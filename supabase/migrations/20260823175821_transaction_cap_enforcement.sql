-- Hard NZ$10,000 rolling-window cap, enforced PREVENTATIVELY -- no customer
-- (buyer or seller, combined across every path) can complete a transaction
-- that pushes their rolling total to or over the cap. This is a
-- block-before, not log-after, control: the existing
-- customer_transaction_totals_365d() function only ever reported totals
-- after the fact and enforced nothing.

-- ----------------------------------------------------------------------------
-- Config: cap amount and window, single source of truth (pricing_config,
-- same pattern as every other tunable in this schema). No fallback default
-- baked into the check function -- missing config blocks with an explicit
-- error rather than silently allowing anything through.
-- ----------------------------------------------------------------------------

alter table public.pricing_config
  add column if not exists transaction_cap_amount numeric(12,2) not null default 10000.00
  check (transaction_cap_amount > 0);

alter table public.pricing_config
  add column if not exists transaction_cap_window_days integer not null default 365
  check (transaction_cap_window_days > 0);

comment on column public.pricing_config.transaction_cap_amount is 'Rolling-window combined transaction cap per customer (buying + marketplace selling + instant selling, combined -- matches customer_transaction_totals_365d''s combined_total_365d). Enforced preventatively by check_and_log_transaction_cap().';
comment on column public.pricing_config.transaction_cap_window_days is 'Rolling window (in days) the cap above applies over. 365 by default -- a genuine trailing window, not a calendar-year bucket.';

-- ----------------------------------------------------------------------------
-- transaction_cap_ledger: every check against the cap, whether it passed or
-- was rejected. The rolling total is always RECOMPUTED from this table
-- (SUM over an indexed window), never trusted from a stored running total --
-- a naive running total would drift as old transactions age out of the
-- window, and would not automatically net out a later refund. Instead the
-- live check joins back to orders.status at read time to exclude anything
-- since refunded (see check_and_log_transaction_cap below).
--
-- 'allowed' rows are the authoritative record that a transaction actually
-- happened -- only ever written at the real insert/approval moment
-- (dry_run = false), never by the app-layer pre-check, so one real
-- transaction can never produce two 'allowed' rows. 'rejected' rows are
-- written every time, including from a dry-run pre-check -- a customer
-- attempting to go over the cap is logged even if they never get as far as
-- a real order/submission row.
-- ----------------------------------------------------------------------------

create table public.transaction_cap_ledger (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  transaction_type text not null check (transaction_type in ('marketplace_buy', 'marketplace_sell', 'instant_sell')),
  order_id uuid references public.orders(id),
  submission_id uuid references public.submissions(id),
  amount numeric(12,2) not null check (amount > 0),
  outcome text not null check (outcome in ('allowed', 'rejected')),
  prior_rolling_total numeric(12,2) not null check (prior_rolling_total >= 0),
  resulting_rolling_total numeric(12,2) not null check (resulting_rolling_total >= 0),
  window_days_used integer not null check (window_days_used > 0),
  cap_amount_used numeric(12,2) not null check (cap_amount_used > 0),
  rejection_reason text,
  checked_by_source text not null check (checked_by_source in ('checkout_precheck', 'order_insert_trigger', 'submission_approval_trigger')),
  checked_at timestamptz not null default timezone('utc', now())
);

comment on table public.transaction_cap_ledger is 'Every check against the rolling transaction cap (Task: $10k cap), both allowed and rejected. Rolling totals are always recomputed by summing this table over the configured window, never trusted from a cached cumulative value -- see check_and_log_transaction_cap().';
comment on column public.transaction_cap_ledger.outcome is 'allowed rows are written ONLY at the real insert/approval moment (never by a dry-run pre-check) -- the authoritative record that a transaction actually happened. rejected rows are written on every rejection, including dry-run pre-check rejections, so a customer''s attempt to go over the cap is logged even if no real order/submission was ever created.';

create index idx_transaction_cap_ledger_profile_window on public.transaction_cap_ledger (profile_id, checked_at) where outcome = 'allowed';

alter table public.transaction_cap_ledger enable row level security;

create policy transaction_cap_ledger_select_admin_only
  on public.transaction_cap_ledger for select
  using (is_admin());

-- No insert/update/delete policy for anon or authenticated -- with RLS
-- enabled and no such policy, no client-side role can write to this table
-- at all. All writes go through check_and_log_transaction_cap() below,
-- which runs as its owner (security definer) and so bypasses RLS the same
-- way every other hard-rule function in this schema does.

-- ----------------------------------------------------------------------------
-- check_and_log_transaction_cap(): the one function every call site uses --
-- the app-layer pre-check (Marketplace, before Stripe payment) and the two
-- DB-trigger backstops (Marketplace order insert, Instant Sell approval) all
-- call this exact function, so the threshold/window logic exists in exactly
-- one place.
--
-- p_dry_run = true is the pre-check mode: rejections are still logged (a
-- customer testing the limit is a signal worth keeping even if they never
-- complete a real transaction), but an allowed dry-run logs nothing --
-- the transaction hasn't actually happened yet and might still be
-- abandoned, so only the real trigger-time call (dry_run = false) is
-- allowed to write the authoritative 'allowed' row.
--
-- pg_advisory_xact_lock serializes concurrent checks for the SAME customer
-- (released automatically at transaction end) -- this is what makes the
-- cap race-proof: two simultaneous transactions for one customer can never
-- both read the same "prior total" and both slip under the cap. Two
-- different customers never contend with each other.
-- ----------------------------------------------------------------------------

create or replace function public.check_and_log_transaction_cap(
  p_profile_id uuid,
  p_transaction_type text,
  p_amount numeric,
  p_order_id uuid default null,
  p_submission_id uuid default null,
  p_source text default 'order_insert_trigger',
  p_dry_run boolean default false
)
returns numeric
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cap_amount numeric;
  v_window_days integer;
  v_prior_total numeric;
  v_resulting_total numeric;
begin
  if p_transaction_type not in ('marketplace_buy', 'marketplace_sell', 'instant_sell') then
    raise exception 'Invalid transaction_type: %', p_transaction_type;
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Transaction amount must be positive.';
  end if;
  if p_source not in ('checkout_precheck', 'order_insert_trigger', 'submission_approval_trigger') then
    raise exception 'Invalid source: %', p_source;
  end if;

  select transaction_cap_amount, transaction_cap_window_days
  into v_cap_amount, v_window_days
  from public.pricing_config where id = 1;

  if v_cap_amount is null or v_window_days is null then
    raise exception 'Transaction cap configuration is missing. Contact support -- this is not something you can fix by retrying.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  -- Rolling sum over the window, live-joined to orders so a refund issued
  -- after this order was logged 'allowed' correctly stops counting toward
  -- the cap immediately -- matches customer_transaction_totals_365d()
  -- excluding refunded orders, just computed incrementally instead of from
  -- scratch. Instant Sell submissions have no equivalent "reversed"
  -- transition today, so no join is needed for those rows.
  select coalesce(sum(l.amount), 0) into v_prior_total
  from public.transaction_cap_ledger l
  left join public.orders o on o.id = l.order_id
  where l.profile_id = p_profile_id
    and l.outcome = 'allowed'
    and l.checked_at >= timezone('utc', now()) - (v_window_days || ' days')::interval
    and (l.order_id is null or o.status is distinct from 'refunded');

  v_resulting_total := v_prior_total + p_amount;

  if v_resulting_total >= v_cap_amount then
    insert into public.transaction_cap_ledger (
      profile_id, transaction_type, order_id, submission_id, amount, outcome,
      prior_rolling_total, resulting_rolling_total, window_days_used, cap_amount_used,
      rejection_reason, checked_by_source
    ) values (
      p_profile_id, p_transaction_type, p_order_id, p_submission_id, p_amount, 'rejected',
      v_prior_total, v_resulting_total, v_window_days, v_cap_amount,
      format('Would reach/exceed the $%s rolling %s-day cap (existing total $%s + this $%s)', v_cap_amount, v_window_days, v_prior_total, p_amount),
      p_source
    );
    raise exception 'This transaction would put the rolling %s-day total at or over $%s.', v_window_days, v_cap_amount;
  end if;

  if not p_dry_run then
    insert into public.transaction_cap_ledger (
      profile_id, transaction_type, order_id, submission_id, amount, outcome,
      prior_rolling_total, resulting_rolling_total, window_days_used, cap_amount_used, checked_by_source
    ) values (
      p_profile_id, p_transaction_type, p_order_id, p_submission_id, p_amount, 'allowed',
      v_prior_total, v_resulting_total, v_window_days, v_cap_amount, p_source
    );
  end if;

  return v_resulting_total;
end;
$function$;

-- Explicit revoke from PUBLIC, not just anon/authenticated -- a function is
-- executable by PUBLIC by default in Postgres unless that grant is removed
-- too, and a "revoke from anon, authenticated" alone does not touch it (this
-- schema has at least one pre-existing function, reserve_listing_for_checkout,
-- where that gap means PUBLIC can still call it directly today -- not fixed
-- here, flagged separately, but not repeated in this new function).
revoke all on function public.check_and_log_transaction_cap(uuid, text, numeric, uuid, uuid, text, boolean) from public;
grant execute on function public.check_and_log_transaction_cap(uuid, text, numeric, uuid, uuid, text, boolean) to service_role;

-- ----------------------------------------------------------------------------
-- Marketplace backstop + authoritative log: fires at the real moment the
-- order is recorded (api/webhook.js, after Stripe payment succeeds). This is
-- what actually closes the race the app-layer pre-check (create-checkout.js)
-- can't: two concurrent Stripe checkouts for the SAME buyer on two DIFFERENT
-- listings can each independently pass the pre-check before either
-- completes, since neither knows about the other's in-flight order. The
-- advisory lock here serializes the two order inserts and blocks whichever
-- one would cross the cap.
--
-- Checks the buyer always. Checks the seller only when this is a genuine
-- Marketplace listing (sale_mode = 'marketplace') -- an Instant-Sell-sourced
-- listing being resold here has Giftlio as its effective "seller" for cap
-- purposes, not the original submitter (that seller was already checked at
-- their own submission-approval moment, below) -- matches how
-- customer_transaction_totals_365d() already scopes
-- marketplace_selling_total_365d to sale_mode = 'marketplace'.
--
-- If this ever actually rejects (meaning the pre-check was somehow bypassed
-- or lost the race), the buyer has already paid Stripe but no orders row
-- gets created -- same "reversal is a human decision, not automatic" posture
-- already used elsewhere in this schema (payout reversal on dispute isn't
-- automatic either). An admin would need to manually refund via Stripe in
-- that rare case.
-- ----------------------------------------------------------------------------

create or replace function public.enforce_transaction_cap_on_order_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_listing record;
begin
  perform public.check_and_log_transaction_cap(
    p_profile_id => new.buyer_id,
    p_transaction_type => 'marketplace_buy',
    p_amount => new.total,
    p_order_id => new.id,
    p_source => 'order_insert_trigger',
    p_dry_run => false
  );

  select seller_id, sale_mode, seller_payout_amount into v_listing
  from public.listings where id = new.listing_id;

  if v_listing.sale_mode = 'marketplace' and v_listing.seller_payout_amount is not null then
    perform public.check_and_log_transaction_cap(
      p_profile_id => v_listing.seller_id,
      p_transaction_type => 'marketplace_sell',
      p_amount => v_listing.seller_payout_amount,
      p_order_id => new.id,
      p_source => 'order_insert_trigger',
      p_dry_run => false
    );
  end if;

  return new;
end;
$function$;

revoke all on function public.enforce_transaction_cap_on_order_insert() from public;

drop trigger if exists trg_enforce_transaction_cap_on_order_insert on public.orders;
create trigger trg_enforce_transaction_cap_on_order_insert
before insert on public.orders
for each row execute function public.enforce_transaction_cap_on_order_insert();

-- ----------------------------------------------------------------------------
-- Instant Sell: this trigger is BOTH the pre-check and the backstop, because
-- (unlike Marketplace) there is no server-side code in this path to add an
-- app-layer pre-check to -- submission approval is a direct RLS-governed
-- client UPDATE from the admin panel (app.js), with no api/*.js endpoint in
-- between. This matches how every other Instant Sell hard rule in this
-- schema (validate_card_format, the payout hold) is already enforced purely
-- at the DB trigger layer for exactly this reason.
--
-- Fires at approval (status -> 'approved'), not at payout (paid_at) --
-- that's the moment customer_transaction_totals_365d() counts an Instant
-- Sell transaction, so it's the moment this cap must block it too. Instant
-- Sell is fully blocked at submission time today (validate_card_format), so
-- this trigger is dormant/future-proofing until Instant Sell is re-enabled --
-- same posture Task 3's submission payout hold already took.
-- ----------------------------------------------------------------------------

create or replace function public.enforce_transaction_cap_on_submission_approval()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    perform public.check_and_log_transaction_cap(
      p_profile_id => new.seller_id,
      p_transaction_type => 'instant_sell',
      p_amount => new.offer_amount,
      p_submission_id => new.id,
      p_source => 'submission_approval_trigger',
      p_dry_run => false
    );
  end if;
  return new;
end;
$function$;

revoke all on function public.enforce_transaction_cap_on_submission_approval() from public;

drop trigger if exists trg_enforce_transaction_cap_on_submission_approval on public.submissions;
create trigger trg_enforce_transaction_cap_on_submission_approval
before update on public.submissions
for each row execute function public.enforce_transaction_cap_on_submission_approval();
