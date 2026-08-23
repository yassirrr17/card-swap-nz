-- Unverified sellers can still list and sell -- payout is now held until
-- profiles.verification_status = 'verified'. Enforced in the same two
-- DB triggers that already gate payout release (there is no app-server code
-- path for either release action to hook into -- both are direct
-- RLS-governed client updates from the admin panel), so this can't be
-- bypassed by a direct API call any more than the existing hold/dispute/
-- suspension checks can.
--
-- An admin override exists for the case a seller needs manual release
-- before formal verification exists (verification_status is currently only
-- ever set by an admin -- prevent_self_privilege_escalation() already
-- blocks self-service changes to it -- and nothing sets it to 'verified'
-- yet; that's a future feature). The override bypasses ONLY the
-- verification check -- disputes, suspension, freeze, and the elapsed-time
-- hold are untouched and still apply exactly as before.

-- ----------------------------------------------------------------------------
-- Override columns, same naming/shape as the existing payout_frozen_* trio.
-- ----------------------------------------------------------------------------

alter table public.orders
  add column if not exists payout_verification_override_reason text,
  add column if not exists payout_verification_override_by uuid references public.profiles(id),
  add column if not exists payout_verification_override_at timestamptz;

alter table public.submissions
  add column if not exists payout_verification_override_reason text,
  add column if not exists payout_verification_override_by uuid references public.profiles(id),
  add column if not exists payout_verification_override_at timestamptz;

comment on column public.orders.payout_verification_override_reason is 'Set by an admin to release a Marketplace payout despite the seller not being verification_status=verified. Bypasses ONLY the verification check -- dispute/suspension/freeze/elapsed-time holds still apply. See enforce_payout_release_hold().';
comment on column public.submissions.payout_verification_override_reason is 'Set by an admin to mark an Instant Sell submission paid despite the seller not being verification_status=verified. Bypasses ONLY the verification check -- suspension/elapsed-time holds still apply. See enforce_submission_payout_hold().';

-- ----------------------------------------------------------------------------
-- Marketplace: enforce_payout_release_hold(), extended with the
-- verification check inside the existing release branch. Runs after the
-- suspension check and before the dispute check -- ordering doesn't change
-- any existing behavior, it just adds one more condition to the same list.
-- ----------------------------------------------------------------------------

create or replace function public.enforce_payout_release_hold()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_seller_id uuid;
  v_seller_verification_status text;
  v_dispute_window_hours integer;
  v_buffer_hours integer;
  v_hold_hours integer;
begin
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

    -- Verification hold: no automated way yet to set verification_status
    -- to 'verified' (that's a future feature), so this only ever passes
    -- today via the admin override below. Bypasses ONLY this check --
    -- every other condition in this function still applies normally.
    select verification_status into v_seller_verification_status
    from public.profiles where id = v_seller_id;

    if v_seller_verification_status is distinct from 'verified' then
      if not is_admin() then
        raise exception 'Only an admin can release payout for an unverified seller.';
      end if;
      if new.payout_verification_override_reason is null or length(trim(new.payout_verification_override_reason)) = 0 then
        raise exception 'Cannot release payout -- this seller is not verified. An admin override reason is required.';
      end if;
      new.payout_verification_override_by := auth.uid();
      new.payout_verification_override_at := timezone('utc', now());
    end if;

    if exists (select 1 from public.disputes d where d.order_id = new.id and d.status in ('open', 'investigating')) then
      raise exception 'Cannot release payout -- there is an open dispute on this order.';
    end if;

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

  if old.seller_paid = true and new.status = 'refunded' and new.payout_status is distinct from 'reversed' then
    new.payout_status := 'reversed';
  end if;

  return new;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Instant Sell: enforce_submission_payout_hold(), same shape. seller_id is
-- already a direct column on submissions, no join needed.
-- ----------------------------------------------------------------------------

create or replace function public.enforce_submission_payout_hold()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_hold_hours integer;
  v_seller_verification_status text;
begin
  if new.paid_at is not null and old.paid_at is null then
    if new.approved_at is null then
      raise exception 'Cannot mark as paid before this submission is approved.';
    end if;
    if public.is_seller_suspended(new.seller_id) then
      raise exception 'Cannot mark as paid -- this seller is currently suspended.';
    end if;

    select verification_status into v_seller_verification_status
    from public.profiles where id = new.seller_id;

    if v_seller_verification_status is distinct from 'verified' then
      if not is_admin() then
        raise exception 'Only an admin can mark as paid for an unverified seller.';
      end if;
      if new.payout_verification_override_reason is null or length(trim(new.payout_verification_override_reason)) = 0 then
        raise exception 'Cannot mark as paid -- this seller is not verified. An admin override reason is required.';
      end if;
      new.payout_verification_override_by := auth.uid();
      new.payout_verification_override_at := timezone('utc', now());
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

-- ----------------------------------------------------------------------------
-- Audit logging: both audit_*_changes() functions are hand-picked field
-- loggers, not generic diffs -- the override fields need to be added
-- explicitly or they'd never show up in admin_audit_log.
-- ----------------------------------------------------------------------------

create or replace function public.audit_orders_changes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if old.status is distinct from new.status
     or old.seller_paid is distinct from new.seller_paid
     or old.payout_status is distinct from new.payout_status then
    perform public.write_audit_log_entry(
      'db_order_state_change', 'order', new.id, new.brand,
      jsonb_build_object(
        'old_status', old.status, 'new_status', new.status,
        'old_seller_paid', old.seller_paid, 'new_seller_paid', new.seller_paid,
        'old_payout_status', old.payout_status, 'new_payout_status', new.payout_status,
        'payout_frozen_reason', new.payout_frozen_reason,
        'payout_verification_override_reason', new.payout_verification_override_reason,
        'payout_verification_override_by', new.payout_verification_override_by
      )
    );
  end if;
  return new;
end;
$function$;

create or replace function public.audit_submissions_changes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if old.status is distinct from new.status or old.paid_at is distinct from new.paid_at then
    perform public.write_audit_log_entry(
      'db_submission_state_change', 'submission', new.id, new.brand,
      jsonb_build_object(
        'old_status', old.status, 'new_status', new.status, 'paid_at', new.paid_at,
        'rejection_reason', new.rejection_reason,
        'payout_verification_override_reason', new.payout_verification_override_reason,
        'payout_verification_override_by', new.payout_verification_override_by
      )
    );
  end if;
  return new;
end;
$function$;
