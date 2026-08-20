-- BACKFILL: applied directly to the live database on 2026-08-18, never
-- committed as a file -- see the note at the top of
-- 20260818194136_add_reconciliation_incidents.sql. This file covers the
-- reconciliation_runs table and the run_reconciliation() function.
-- Do NOT re-apply -- these objects are already live.
--
-- The function body below is pulled verbatim from the live database via
-- pg_get_functiondef(). Postgres only exposes an object's *current*
-- definition, not its historical diffs, so this is necessarily the
-- post-fix body (the next migration, fix_reconciliation_new_incident_
-- detection, is the one named for correcting it) -- applying both files in
-- order still reconstructs the live function exactly, which is what
-- matters for disaster recovery.

create table if not exists public.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default timezone('utc', now()),
  findings_count integer not null default 0,
  new_count integer not null default 0,
  auto_resolved_count integer not null default 0,
  open_count integer not null default 0,
  external_source_ok boolean not null default true,
  notes text
);

alter table public.reconciliation_runs enable row level security;

drop policy if exists recon_runs_admin_select on public.reconciliation_runs;
create policy recon_runs_admin_select on public.reconciliation_runs
  for select using (is_admin());

-- Scans orders/listings/disputes/submissions/email_queue for known
-- inconsistency patterns (each mirrored, where applicable, by a hard DB
-- constraint elsewhere -- this is the detection net for the ones that
-- can't be constraints, e.g. "listing still active after sale"). Accepts
-- externally-sourced findings (e.g. a Stripe-side reconciliation job) via
-- p_external so admins get one unified incident queue. Upserts into
-- reconciliation_incidents keyed on (check_code, entity_key) so repeat
-- runs bump seen_count instead of duplicating, and auto-resolves any
-- previously-open incident that this run no longer detects.
create or replace function public.run_reconciliation(p_external jsonb DEFAULT '[]'::jsonb, p_external_ok boolean DEFAULT true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_now timestamptz := timezone('utc', now());
  v_new jsonb;
  v_new_count int := 0;
  v_resolved int := 0;
  v_findings int := 0;
  v_open int := 0;
begin
  drop table if exists _recon_findings;
  create temp table _recon_findings (
    check_code text,
    severity text,
    entity_type text,
    entity_id uuid,
    entity_key text,
    entity_label text,
    summary text,
    amount_at_risk numeric(10,2),
    details jsonb
  ) on commit drop;

  insert into _recon_findings
  select
    f->>'check_code', f->>'severity', coalesce(f->>'entity_type','stripe'), null::uuid,
    f->>'entity_key', f->>'entity_label', f->>'summary',
    nullif(f->>'amount_at_risk','')::numeric, coalesce(f->'details','{}'::jsonb)
  from jsonb_array_elements(coalesce(p_external,'[]'::jsonb)) f
  where f->>'check_code' is not null and f->>'entity_key' is not null;

  insert into _recon_findings
  select 'LISTING_STILL_ACTIVE_AFTER_SALE','CRITICAL','order', o.id, o.id::text, o.public_id,
    'Order ' || o.public_id || ' exists for listing ' || l.public_id ||
    ', but the listing is still ACTIVE and can be bought again.',
    o.total, jsonb_build_object('listing_id', l.id, 'listing_public_id', l.public_id, 'brand', o.brand)
  from orders o join listings l on l.id = o.listing_id
  where o.status <> 'refunded' and l.status = 'active';

  insert into _recon_findings
  select 'DUPLICATE_SALE','CRITICAL','listing', l.id, l.id::text, l.public_id,
    'Listing ' || l.public_id || ' has ' || count(o.id) || ' non-refunded orders. A card can only be sold once.',
    sum(o.total), jsonb_build_object('order_ids', jsonb_agg(o.public_id), 'brand', l.brand)
  from listings l join orders o on o.listing_id = l.id and o.status <> 'refunded'
  group by l.id, l.public_id, l.brand having count(o.id) > 1;

  insert into _recon_findings
  select 'PAYOUT_BEFORE_DELIVERY','CRITICAL','order', o.id, o.id::text, o.public_id,
    'Seller was paid for order ' || o.public_id || ' but the order status is "' || o.status || '" (not delivered).',
    o.total, jsonb_build_object('brand', o.brand, 'buyer_email', o.buyer_email)
  from orders o where o.seller_paid = true and o.status <> 'delivered';

  insert into _recon_findings
  select 'REFUNDED_BUT_SELLER_PAID','CRITICAL','order', o.id, o.id::text, o.public_id,
    'Order ' || o.public_id || ' was refunded to the buyer, but the seller has already been paid.',
    o.total, jsonb_build_object('brand', o.brand)
  from orders o where o.status = 'refunded' and o.seller_paid = true;

  insert into _recon_findings
  select 'PAYOUT_WITH_OPEN_DISPUTE','CRITICAL','order', o.id, o.id::text, o.public_id,
    'Order ' || o.public_id || ' has an open dispute (' || d.public_id || ') but the payout has been released.',
    o.total, jsonb_build_object('dispute_id', d.id, 'dispute_public_id', d.public_id, 'dispute_status', d.status)
  from orders o join disputes d on d.order_id = o.id
  where d.status in ('open','investigating')
    and (o.seller_paid = true or o.payout_released_at is not null);

  insert into _recon_findings
  select 'UNDELIVERED_ORDER','HIGH','order', o.id, o.id::text, o.public_id,
    'Order ' || o.public_id || ' has been awaiting delivery for ' ||
    floor(extract(epoch from (v_now - o.created_at))/3600)::text || ' hours.',
    o.total, jsonb_build_object('brand', o.brand, 'buyer_email', o.buyer_email)
  from orders o
  where o.status = 'pending_verification' and o.created_at < v_now - interval '24 hours';

  insert into _recon_findings
  select 'SOLD_LISTING_NO_ORDER','HIGH','listing', l.id, l.id::text, l.public_id,
    'Listing ' || l.public_id || ' is marked SOLD but no order row exists for it.',
    l.sale_price, jsonb_build_object('brand', l.brand)
  from listings l
  where l.status = 'sold' and not exists (select 1 from orders o where o.listing_id = l.id);

  insert into _recon_findings
  select 'ORDER_WITHOUT_STRIPE_SESSION','HIGH','order', o.id, o.id::text, o.public_id,
    'Order ' || o.public_id || ' has no Stripe session ID. It may not correspond to a real payment.',
    o.total, jsonb_build_object('brand', o.brand)
  from orders o
  where o.stripe_session_id is null and o.created_at < v_now - interval '30 minutes';

  insert into _recon_findings
  select 'DISPUTE_AGING','HIGH','dispute', d.id, d.id::text, d.public_id,
    'Dispute ' || d.public_id || ' has been open for ' ||
    floor(extract(epoch from (v_now - d.created_at))/3600)::text || ' hours with no resolution.',
    d.estimated_cost, jsonb_build_object('dispute_status', d.status, 'order_id', d.order_id)
  from disputes d
  where d.status in ('open','investigating') and d.created_at < v_now - interval '48 hours';

  insert into _recon_findings
  select 'DELIVERED_WITHOUT_TIMESTAMP','MEDIUM','order', o.id, o.id::text, o.public_id,
    'Order ' || o.public_id || ' is marked delivered but has no delivered_at timestamp.',
    null, '{}'::jsonb
  from orders o where o.status = 'delivered' and o.delivered_at is null;

  insert into _recon_findings
  select 'SUBMISSION_STATE_DRIFT','MEDIUM','submission', s.id, s.id::text, s.public_id,
    'Listing ' || l.public_id || ' is sold, but submission ' || s.public_id || ' is still "' || s.status || '".',
    null, jsonb_build_object('listing_id', l.id, 'brand', s.brand)
  from listings l join submissions s on s.id = l.submission_id
  where l.status = 'sold' and s.status <> 'sold' and s.deleted_at is null;

  insert into _recon_findings
  select 'ORDER_TOTAL_MISMATCH','MEDIUM','order', o.id, o.id::text, o.public_id,
    'Order ' || o.public_id || ' total (' || o.total || ') does not equal sale price + service fee (' ||
    (o.sale_price + coalesce(o.service_fee,0)) || ').',
    abs(o.total - (o.sale_price + coalesce(o.service_fee,0))), '{}'::jsonb
  from orders o where abs(o.total - (o.sale_price + coalesce(o.service_fee,0))) > 0.01;

  insert into _recon_findings
  select 'EMAIL_DELIVERY_FAILED','MEDIUM','email', null::uuid, 'failed_emails_7d', 'Failed emails',
    count(*) || ' notification email(s) failed to send in the last 7 days.',
    null, jsonb_build_object('event_types', jsonb_agg(distinct e.event_type))
  from email_queue e
  where e.status = 'failed' and e.created_at > v_now - interval '7 days'
  having count(*) > 0;

  insert into _recon_findings
  select 'EMAIL_QUEUE_STUCK','MEDIUM','email', null::uuid, 'stuck_emails', 'Stuck email queue',
    count(*) || ' email(s) have been pending for over 2 hours.',
    null, jsonb_build_object('oldest', min(e.created_at))
  from email_queue e
  where e.status = 'pending' and e.created_at < v_now - interval '2 hours'
  having count(*) > 0;

  select count(*) into v_findings from _recon_findings;

  insert into reconciliation_incidents (
    check_code, severity, entity_type, entity_id, entity_key,
    entity_label, summary, amount_at_risk, details, first_seen_at, last_seen_at
  )
  select
    f.check_code, f.severity, f.entity_type, f.entity_id, f.entity_key,
    f.entity_label, f.summary, f.amount_at_risk, f.details, v_now, v_now
  from _recon_findings f
  on conflict (check_code, entity_key) where status in ('open','acknowledged')
  do update set
    last_seen_at = v_now,
    seen_count = reconciliation_incidents.seen_count + 1,
    severity = excluded.severity,
    summary = excluded.summary,
    amount_at_risk = excluded.amount_at_risk,
    details = excluded.details;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb), count(*)::int
    into v_new, v_new_count
  from (
    select i.id, i.check_code, i.severity, i.entity_type,
           i.entity_label, i.summary, i.amount_at_risk
    from reconciliation_incidents i
    where i.first_seen_at = v_now and i.status = 'open'
  ) r;

  update reconciliation_incidents i
  set status = 'auto_resolved',
      resolved_at = v_now,
      resolution_note = 'No longer detected by reconciliation run'
  where i.status = 'open'
    and i.first_seen_at < v_now
    and not exists (
      select 1 from _recon_findings f
      where f.check_code = i.check_code and f.entity_key = i.entity_key
    );
  get diagnostics v_resolved = row_count;

  select count(*) into v_open from reconciliation_incidents where status in ('open','acknowledged');

  insert into reconciliation_runs (findings_count, new_count, auto_resolved_count, open_count, external_source_ok)
  values (v_findings, v_new_count, v_resolved, v_open, coalesce(p_external_ok, true));

  return jsonb_build_object(
    'ran_at', v_now,
    'findings', v_findings,
    'new_incidents', v_new_count,
    'auto_resolved', v_resolved,
    'open_total', v_open,
    'external_source_ok', coalesce(p_external_ok, true),
    'new', coalesce(v_new, '[]'::jsonb)
  );
end;
$function$;

revoke execute on function public.run_reconciliation(jsonb, boolean) from anon, authenticated;
