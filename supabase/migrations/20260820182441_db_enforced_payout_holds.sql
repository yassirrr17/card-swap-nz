-- Task 3: the 24h/48h payout holds only ever existed as disabled buttons in
-- app.js -- nothing in the database stopped a direct API call from
-- releasing a payout early, while a dispute is open, or for a refunded
-- order. This makes the hold a real database constraint, and gives orders
-- an explicit payout_status instead of relying on the bare seller_paid
-- boolean to represent five different real states.

-- ----------------------------------------------------------------------------
-- Config: hold durations, not hardcoded (were JS constants
-- MARKETPLACE_PAYOUT_HOLD_HOURS / INSTANT_SELL_PAYOUT_HOLD_HOURS in app.js).
-- No fallback default baked into the trigger logic itself -- if this
-- config is ever missing, the release is BLOCKED with an explicit error,
-- same "no silent fallback" principle already used for pricing_config
-- elsewhere in this schema.
-- ----------------------------------------------------------------------------

alter table public.pricing_config
  add column if not exists marketplace_payout_hold_hours integer not null default 48
  check (marketplace_payout_hold_hours > 0);

alter table public.pricing_config
  add column if not exists instant_sell_payout_hold_hours integer not null default 24
  check (instant_sell_payout_hold_hours > 0);

-- ----------------------------------------------------------------------------
-- orders.payout_status: pending (default) / released / frozen / reversed.
-- seller_paid stays as-is for backwards compatibility with existing app
-- code (it's still what the release button flips) -- this trigger keeps
-- the two in sync rather than replacing one with the other.
-- ----------------------------------------------------------------------------

alter table public.orders
  add column if not exists payout_status text not null default 'pending'
  check (payout_status in ('pending', 'released', 'frozen', 'reversed')),
  add column if not exists payout_frozen_reason text,
  add column if not exists payout_frozen_at timestamptz,
  add column if not exists payout_frozen_by uuid references public.profiles(id);

update public.orders set payout_status = 'released' where seller_paid = true and payout_status = 'pending';

create or replace function public.enforce_payout_release_hold()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_seller_id uuid;
  v_hold_hours integer;
begin
  -- Freezing: an admin-only safety valve, allowed regardless of hold
  -- timing -- freezing should never itself be blocked by the same checks
  -- that block a release.
  if new.payout_status = 'frozen' and old.payout_status is distinct from 'frozen' then
    if not is_admin() then
      raise exception 'Only an admin can freeze a payout.';
    end if;
    if new.payout_frozen_reason is null or length(trim(new.payout_frozen_reason)) = 0 then
      raise exception 'A reason is required to freeze a payout.';
    end if;
    new.payout_frozen_at := timezone('utc', now());
    new.payout_frozen_by := auth.uid();
    return new;
  end if;

  if old.payout_status = 'frozen' and new.payout_status is distinct from 'frozen' and not is_admin() then
    raise exception 'Only an admin can unfreeze a payout.';
  end if;

  -- Releasing: seller_paid flipping false -> true is the actual money-gate
  -- moment. Every check below runs regardless of caller, including an
  -- admin session -- the hold is a hard rule, not a UI convenience. A
  -- legitimate release only ever happens after the app's own "Release
  -- Payout" button becomes clickable, which is exactly when these
  -- conditions are already true, so this never blocks a normal release --
  -- only a direct API call attempting to jump the gate.
  if new.seller_paid = true and old.seller_paid is distinct from true then
    if old.payout_status = 'frozen' then
      raise exception 'This payout is frozen and cannot be released. Unfreeze it first.';
    end if;
    if new.delivered_at is null then
      raise exception 'Cannot release payout before the order is marked delivered.';
    end if;
    if new.status = 'refunded' then
      raise exception 'Cannot release payout for a refunded order.';
    end if;

    select l.seller_id into v_seller_id from public.listings l where l.id = new.listing_id;
    if public.is_seller_suspended(v_seller_id) then
      raise exception 'Cannot release payout -- this seller is currently suspended.';
    end if;

    if exists (select 1 from public.disputes d where d.order_id = new.id and d.status in ('open', 'investigating')) then
      raise exception 'Cannot release payout -- there is an open dispute on this order.';
    end if;

    select marketplace_payout_hold_hours into v_hold_hours from public.pricing_config where id = 1;
    if v_hold_hours is null then
      raise exception 'Payout hold configuration is missing. Contact support -- this is not something you can fix by retrying.';
    end if;
    if timezone('utc', now()) < new.delivered_at + (v_hold_hours || ' hours')::interval then
      raise exception 'Payout cannot be released until % hours after delivery.', v_hold_hours;
    end if;

    new.payout_status := 'released';
  end if;

  -- Reversal signal: the order is now refunded but the seller was already
  -- paid -- money has left Giftlio's account for a sale that no longer
  -- stands. This does not claw anything back automatically (that's a human
  -- decision), it just makes the state visible instead of silently leaving
  -- seller_paid=true looking normal. Mirrors run_reconciliation()'s
  -- REFUNDED_BUT_SELLER_PAID check.
  if old.seller_paid = true and new.status = 'refunded' and new.payout_status is distinct from 'reversed' then
    new.payout_status := 'reversed';
  end if;

  return new;
end;
$function$;

revoke execute on function public.enforce_payout_release_hold() from anon, authenticated;

drop trigger if exists trg_enforce_payout_release_hold on public.orders;
create trigger trg_enforce_payout_release_hold
before update on public.orders
for each row execute function public.enforce_payout_release_hold();

-- Same reversal signal, reached from the other direction: a dispute opens
-- (buyer report or Stripe chargeback, Task 2) against an order that was
-- already paid out. Mirrors run_reconciliation()'s PAYOUT_WITH_OPEN_DISPUTE
-- check -- this makes that condition visible on the order itself, not just
-- in a separate reconciliation queue.
create or replace function public.flag_payout_reversed_on_dispute()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.orders
  set payout_status = 'reversed'
  where id = new.order_id and seller_paid = true and payout_status = 'released';
  return new;
end;
$function$;

revoke execute on function public.flag_payout_reversed_on_dispute() from anon, authenticated;

drop trigger if exists trg_flag_payout_reversed_on_dispute on public.disputes;
create trigger trg_flag_payout_reversed_on_dispute
after insert on public.disputes
for each row execute function public.flag_payout_reversed_on_dispute();

-- ----------------------------------------------------------------------------
-- Same hold, enforced the same way, for Instant Sell's payout mechanism
-- (submissions.paid_at, gated on approved_at rather than delivered_at).
-- Instant Sell is currently hard-blocked at submission time
-- (validate_card_format()), but this closes the gap for the day it's
-- re-enabled -- there's no reason its payout should be less protected than
-- Marketplace's in the meantime, and submissions.paid_at is reachable via
-- markSubmissionPaid() regardless of the Instant Sell block.
-- ----------------------------------------------------------------------------

create or replace function public.enforce_submission_payout_hold()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_hold_hours integer;
begin
  if new.paid_at is not null and old.paid_at is null then
    if new.approved_at is null then
      raise exception 'Cannot mark as paid before this submission is approved.';
    end if;
    if public.is_seller_suspended(new.seller_id) then
      raise exception 'Cannot mark as paid -- this seller is currently suspended.';
    end if;

    select instant_sell_payout_hold_hours into v_hold_hours from public.pricing_config where id = 1;
    if v_hold_hours is null then
      raise exception 'Payout hold configuration is missing. Contact support -- this is not something you can fix by retrying.';
    end if;
    if timezone('utc', now()) < new.approved_at + (v_hold_hours || ' hours')::interval then
      raise exception 'Payout cannot be marked paid until % hours after approval.', v_hold_hours;
    end if;
  end if;

  return new;
end;
$function$;

revoke execute on function public.enforce_submission_payout_hold() from anon, authenticated;

drop trigger if exists trg_enforce_submission_payout_hold on public.submissions;
create trigger trg_enforce_submission_payout_hold
before update on public.submissions
for each row execute function public.enforce_submission_payout_hold();
