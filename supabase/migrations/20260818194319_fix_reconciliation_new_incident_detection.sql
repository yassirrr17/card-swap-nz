-- BACKFILL: applied directly to the live database on 2026-08-18, never
-- committed as a file -- see the note at the top of
-- 20260818194136_add_reconciliation_incidents.sql. Do NOT re-apply -- this
-- fix is already live.
--
-- This migration corrected how run_reconciliation() identifies "new"
-- incidents to return in its result payload (the upsert's ON CONFLICT
-- path means a re-detected incident bumps seen_count/last_seen_at rather
-- than getting a fresh first_seen_at, so filtering on
-- `first_seen_at = v_now and status = 'open'` after the upsert correctly
-- captures only incidents that did not already exist).
--
-- Postgres only exposes a function's *current* definition, not its
-- historical diffs, so the CREATE OR REPLACE below reproduces the
-- corrected body pulled verbatim from the live database via
-- pg_get_functiondef() -- it is intentionally identical to the version
-- created in the previous migration (that migration already carries the
-- post-fix body, for the same reason). Kept as its own file, at its
-- original timestamp, so the migration history matches what was actually
-- applied to the database rather than silently merging two migrations
-- into one.

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
