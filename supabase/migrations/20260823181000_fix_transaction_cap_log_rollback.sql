-- Fixes a real bug in the previous migration (20260823175821), caught by
-- tests/transaction_cap.sql before this ever reached a real caller: Postgres
-- rolls back the ENTIRE transaction when a function raises an exception --
-- including any INSERT that same function already did earlier in the same
-- call, unless that INSERT is wrapped in its own savepoint the caller
-- controls. check_and_log_transaction_cap() inserted a 'rejected' ledger row
-- and then raised in the same breath, so that row was silently undone every
-- single time -- "log every rejected attempt" was not actually happening.
--
-- Fix: split the all-in-one function into a pure read (no writes, no raise
-- except on genuine misuse/missing config) and a pure log write (no raise
-- at all), so logging and raising are never in the same statement:
--
--   evaluate_transaction_cap()   -- read-only: computes prior/resulting
--                                   totals and whether this would be
--                                   allowed. Never writes to the ledger.
--   log_transaction_cap_outcome() -- write-only: inserts one ledger row.
--                                    Never raises on cap logic (only on a
--                                    genuine constraint violation).
--   enforce_transaction_cap()    -- used by the two DB triggers only.
--                                   Evaluates; if allowed, logs 'allowed'
--                                   and returns (no raise, so the log
--                                   commits normally as part of the same
--                                   successful transaction). If rejected,
--                                   raises WITHOUT attempting to log --
--                                   see the comment on that branch for why.
--
-- The app-layer pre-check (api/create-checkout.js) now calls
-- evaluate_transaction_cap() first (read-only, in its own statement), and if
-- it comes back not-allowed, calls log_transaction_cap_outcome() as a
-- SEPARATE statement to persist the rejection -- that logging call has
-- nothing to raise against, so it always commits. This covers the
-- overwhelming majority of real rejections (the actual checkout UI path).
--
-- The DB-trigger backstop's own rejection (the rare case where the pre-check
-- was bypassed or lost a race) is NOT written to transaction_cap_ledger --
-- there is no way to durably log a row from inside the exact statement that
-- must also abort, without an autonomous transaction (e.g. dblink calling
-- back into the same database over a second connection), which was judged
-- to be more new moving parts (a new extension, a self-referential DB
-- connection to maintain) than this narrow, rare case justifies without
-- asking first. That rare rejection is still visible in Postgres's own
-- error/server logs (the RAISE EXCEPTION message), just not as a ledger row.

drop trigger if exists trg_enforce_transaction_cap_on_order_insert on public.orders;
drop trigger if exists trg_enforce_transaction_cap_on_submission_approval on public.submissions;
drop function if exists public.enforce_transaction_cap_on_order_insert();
drop function if exists public.enforce_transaction_cap_on_submission_approval();
drop function if exists public.check_and_log_transaction_cap(uuid, text, numeric, uuid, uuid, text, boolean);

-- ----------------------------------------------------------------------------
-- evaluate_transaction_cap(): read-only. Takes the same per-profile advisory
-- lock as before -- not to protect a write here, but so a concurrent
-- evaluate/enforce call for the SAME profile can't read a stale prior_total
-- while another one is mid-write.
-- ----------------------------------------------------------------------------

create or replace function public.evaluate_transaction_cap(
  p_profile_id uuid,
  p_transaction_type text,
  p_amount numeric
)
returns table(prior_total numeric, resulting_total numeric, cap_amount numeric, window_days integer, allowed boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cap_amount numeric;
  v_window_days integer;
  v_prior_total numeric;
begin
  if p_transaction_type not in ('marketplace_buy', 'marketplace_sell', 'instant_sell') then
    raise exception 'Invalid transaction_type: %', p_transaction_type;
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Transaction amount must be positive.';
  end if;

  select transaction_cap_amount, transaction_cap_window_days
  into v_cap_amount, v_window_days
  from public.pricing_config where id = 1;

  if v_cap_amount is null or v_window_days is null then
    raise exception 'Transaction cap configuration is missing. Contact support -- this is not something you can fix by retrying.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_profile_id::text, 0));

  select coalesce(sum(l.amount), 0) into v_prior_total
  from public.transaction_cap_ledger l
  left join public.orders o on o.id = l.order_id
  where l.profile_id = p_profile_id
    and l.outcome = 'allowed'
    and l.checked_at >= timezone('utc', now()) - (v_window_days || ' days')::interval
    and (l.order_id is null or o.status is distinct from 'refunded');

  return query select
    v_prior_total,
    v_prior_total + p_amount,
    v_cap_amount,
    v_window_days,
    (v_prior_total + p_amount) < v_cap_amount;
end;
$function$;

revoke all on function public.evaluate_transaction_cap(uuid, text, numeric) from public;
grant execute on function public.evaluate_transaction_cap(uuid, text, numeric) to service_role;

-- ----------------------------------------------------------------------------
-- log_transaction_cap_outcome(): write-only, never raises on cap logic --
-- callers decide allowed/rejected themselves (via evaluate_transaction_cap
-- or their own trigger-time re-evaluation) and simply record the outcome.
-- ----------------------------------------------------------------------------

create or replace function public.log_transaction_cap_outcome(
  p_profile_id uuid,
  p_transaction_type text,
  p_amount numeric,
  p_outcome text,
  p_prior_total numeric,
  p_resulting_total numeric,
  p_window_days integer,
  p_cap_amount numeric,
  p_source text,
  p_order_id uuid default null,
  p_submission_id uuid default null,
  p_rejection_reason text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.transaction_cap_ledger (
    profile_id, transaction_type, order_id, submission_id, amount, outcome,
    prior_rolling_total, resulting_rolling_total, window_days_used, cap_amount_used,
    rejection_reason, checked_by_source
  ) values (
    p_profile_id, p_transaction_type, p_order_id, p_submission_id, p_amount, p_outcome,
    p_prior_total, p_resulting_total, p_window_days, p_cap_amount,
    p_rejection_reason, p_source
  );
end;
$function$;

revoke all on function public.log_transaction_cap_outcome(uuid, text, numeric, text, numeric, numeric, integer, numeric, text, uuid, uuid, text) from public;
grant execute on function public.log_transaction_cap_outcome(uuid, text, numeric, text, numeric, numeric, integer, numeric, text, uuid, uuid, text) to service_role;

-- ----------------------------------------------------------------------------
-- enforce_transaction_cap(): the DB-trigger-only entry point. Allowed ->
-- logs and returns normally (no raise involved, so the log commits as part
-- of the same successful transaction as the real order/approval). Rejected
-- -> raises immediately WITHOUT attempting to log -- any insert attempted
-- here would be undone anyway by this very exception aborting the
-- transaction (see the migration header comment), so trying would only be
-- misleading. This path is the rare backstop case (the app-layer pre-check
-- was bypassed or lost a race); it remains visible via Postgres's error
-- logs, just not as a transaction_cap_ledger row.
-- ----------------------------------------------------------------------------

create or replace function public.enforce_transaction_cap(
  p_profile_id uuid,
  p_transaction_type text,
  p_amount numeric,
  p_source text,
  p_order_id uuid default null,
  p_submission_id uuid default null
)
returns numeric
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_eval record;
begin
  select * into v_eval from public.evaluate_transaction_cap(p_profile_id, p_transaction_type, p_amount);

  if not v_eval.allowed then
    raise exception 'This transaction would put the rolling %s-day total at or over $%s.', v_eval.window_days, v_eval.cap_amount;
  end if;

  perform public.log_transaction_cap_outcome(
    p_profile_id, p_transaction_type, p_amount, 'allowed',
    v_eval.prior_total, v_eval.resulting_total, v_eval.window_days, v_eval.cap_amount,
    p_source, p_order_id, p_submission_id
  );

  return v_eval.resulting_total;
end;
$function$;

revoke all on function public.enforce_transaction_cap(uuid, text, numeric, text, uuid, uuid) from public;

-- ----------------------------------------------------------------------------
-- Marketplace backstop trigger, updated to call enforce_transaction_cap().
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
  perform public.enforce_transaction_cap(
    new.buyer_id, 'marketplace_buy', new.total, 'order_insert_trigger', new.id
  );

  select seller_id, sale_mode, seller_payout_amount into v_listing
  from public.listings where id = new.listing_id;

  if v_listing.sale_mode = 'marketplace' and v_listing.seller_payout_amount is not null then
    perform public.enforce_transaction_cap(
      v_listing.seller_id, 'marketplace_sell', v_listing.seller_payout_amount, 'order_insert_trigger', new.id
    );
  end if;

  return new;
end;
$function$;

revoke all on function public.enforce_transaction_cap_on_order_insert() from public;

create trigger trg_enforce_transaction_cap_on_order_insert
before insert on public.orders
for each row execute function public.enforce_transaction_cap_on_order_insert();

-- ----------------------------------------------------------------------------
-- Instant Sell backstop trigger, updated to call enforce_transaction_cap().
-- ----------------------------------------------------------------------------

create or replace function public.enforce_transaction_cap_on_submission_approval()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    perform public.enforce_transaction_cap(
      new.seller_id, 'instant_sell', new.offer_amount, 'submission_approval_trigger', null, new.id
    );
  end if;
  return new;
end;
$function$;

revoke all on function public.enforce_transaction_cap_on_submission_approval() from public;

create trigger trg_enforce_transaction_cap_on_submission_approval
before update on public.submissions
for each row execute function public.enforce_transaction_cap_on_submission_approval();
