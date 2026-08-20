-- Task A (Giftlio follow-up): dispute_claim_window_hours and
-- marketplace_payout_hold_hours were two independent config values that
-- currently happen to both be 48. Nothing enforced that relationship -- if
-- either changed later without the other changing too, a dispute filed
-- near the (old) claim deadline could race a payout release governed by
-- an (unchanged) hold. Two numbers that have to be kept in sync by hand is
-- itself the bug, not the specific value 48.
--
-- Fix: the payout hold is no longer its own stored number. It's computed
-- at read time as dispute_claim_window_hours + payout_hold_buffer_hours --
-- the full window a buyer can still file a dispute in, plus a safety
-- margin for admin/processing lag. Changing dispute_claim_window_hours
-- alone now automatically moves the payout hold with it.
--
-- marketplace_payout_hold_hours is dropped rather than kept as a
-- generated column: nothing in the app reads it directly (grepped -- only
-- the trigger below ever touched it), so keeping a column around that
-- exists solely to mirror a computation done at the same call site adds a
-- second name for the same fact without buying anything. The comment on
-- payout_hold_buffer_hours documents the relationship where a future
-- reader would look for it.

alter table public.pricing_config
  add column if not exists payout_hold_buffer_hours integer not null default 24
  check (payout_hold_buffer_hours > 0);

comment on column public.pricing_config.payout_hold_buffer_hours is
  'Safety margin added on top of dispute_claim_window_hours to get the effective Marketplace payout hold (enforce_payout_release_hold() computes hold_hours = dispute_claim_window_hours + payout_hold_buffer_hours at read time -- there is no separately-stored marketplace_payout_hold_hours to keep in sync). Default 24h buffer on a 48h dispute window = 72h effective hold.';

alter table public.pricing_config
  drop column if exists marketplace_payout_hold_hours;

create or replace function public.enforce_payout_release_hold()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_seller_id uuid;
  v_dispute_window_hours integer;
  v_buffer_hours integer;
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

    -- Hard block on dispute existence, independent of elapsed time: a
    -- dispute filed at hour 47 of a 48h window blocks release even if this
    -- check somehow runs at hour 73. Elapsed time alone is never
    -- sufficient -- an open dispute always wins regardless of how much of
    -- the hold has passed.
    if exists (select 1 from public.disputes d where d.order_id = new.id and d.status in ('open', 'investigating')) then
      raise exception 'Cannot release payout -- there is an open dispute on this order.';
    end if;

    -- Effective hold = the full window a buyer can still file a dispute in
    -- (dispute_claim_window_hours), plus a safety margin
    -- (payout_hold_buffer_hours). No fallback default baked into the
    -- trigger itself -- if either half of this config is missing, the
    -- release is BLOCKED with an explicit error, same "no silent fallback"
    -- principle already used for pricing_config elsewhere in this schema.
    select dispute_claim_window_hours, payout_hold_buffer_hours
      into v_dispute_window_hours, v_buffer_hours
      from public.pricing_config where id = 1;
    if v_dispute_window_hours is null or v_buffer_hours is null then
      raise exception 'Payout hold configuration is missing. Contact support -- this is not something you can fix by retrying.';
    end if;
    v_hold_hours := v_dispute_window_hours + v_buffer_hours;

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

-- trigger definition is unchanged (still fires on the same update path);
-- re-declared here only because CREATE OR REPLACE FUNCTION above requires
-- no trigger changes, but re-running this migration end-to-end (e.g. in a
-- rebuild) should not depend on a previous migration having created it.
drop trigger if exists trg_enforce_payout_release_hold on public.orders;
create trigger trg_enforce_payout_release_hold
before update on public.orders
for each row execute function public.enforce_payout_release_hold();

-- ----------------------------------------------------------------------------
-- Instant Sell has no dispute mechanism -- disputes.order_id references
-- orders only (verified: no submission_id/instant-sell column on
-- disputes), and Instant Sell is separately hard-blocked at submission
-- time regardless. There is no dispute_claim_window_hours equivalent to
-- derive an Instant Sell hold from, so instant_sell_payout_hold_hours
-- stays exactly as it was: an independent config value, untouched by this
-- migration.
-- ----------------------------------------------------------------------------
