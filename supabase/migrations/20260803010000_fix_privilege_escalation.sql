-- Final QA pass turned up two real privilege-escalation gaps, both of the
-- same underlying class: a row-ownership RLS policy with no restriction on
-- WHICH COLUMNS could be changed, meaning any authenticated user could
-- call the Supabase REST API directly (bypassing the app's UI entirely)
-- and modify fields they should never control.

-- 1. submissions: sellers had UPDATE access to their own rows with no
-- column restriction -- a seller could set their own submission's status
-- straight to 'approved', or inflate offer_amount, completely bypassing
-- admin review. Confirmed the app's actual code never needs sellers to
-- update submissions at all (the only .update() call site in the whole
-- app is inside an admin-only function) -- so this removes seller UPDATE
-- access entirely rather than trying to patch it.
drop policy if exists "submissions_update_seller_or_admin" on public.submissions;

create policy "submissions_update_admin_only"
  on public.submissions for update
  using (is_admin())
  with check (is_admin());

-- 2. profiles: users had UPDATE access to their own row with no column
-- restriction -- a user could set role='admin' on themselves, un-suspend
-- themselves, or mark themselves verified. Unlike submissions, users DO
-- legitimately need self-update (name, notification_preference), so a
-- trigger is used instead of removing UPDATE outright: it silently
-- reverts any change to the sensitive columns unless the actor is an
-- admin. A self-escalation attempt just has that field ignored; every
-- other field in the same update still goes through normally.
create or replace function public.prevent_self_privilege_escalation()
returns trigger as $$
begin
  if is_admin() then
    return new;
  end if;

  new.role := old.role;
  new.verification_status := old.verification_status;
  new.suspended := old.suspended;
  new.suspended_reason := old.suspended_reason;
  new.suspended_at := old.suspended_at;
  new.email := old.email;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_prevent_self_privilege_escalation on public.profiles;
create trigger trg_prevent_self_privilege_escalation
  before update on public.profiles
  for each row
  execute function public.prevent_self_privilege_escalation();

-- 3. listing_offers: two more gaps in the same audit pass.
--
-- (a) counter_amount had no range check at all, unlike offer_amount --
-- a seller could set an arbitrary counter via direct API call, bypassing
-- the stated +/-25% business rule entirely.
alter table public.listing_offers
  add constraint counter_within_range
  check (counter_amount is null or (counter_amount >= original_price * 0.75 and counter_amount <= original_price * 1.25));

-- (b) buyers had NO update policy at all on listing_offers -- meaning
-- withdrawOffer() and respondToCounter() (both buyer-triggered actions in
-- the app) would fail for every real user, since RLS defaults to deny
-- with no matching policy. This is a real functional bug, not just a
-- security gap. Adding the missing policy, plus a role-aware protection
-- trigger: sellers may set counter_amount (their decision to make), and
-- neither buyer nor seller may rewrite the original offer's history
-- (amount, who it's between, which listing, when it was made).
create policy "Buyers can respond to their own offers"
  on public.listing_offers for update
  using (buyer_id = auth.uid())
  with check (buyer_id = auth.uid());

create or replace function public.protect_offer_history()
returns trigger as $$
begin
  if is_admin() then
    return new;
  end if;

  new.offer_amount := old.offer_amount;
  new.buyer_id := old.buyer_id;
  new.seller_id := old.seller_id;
  new.original_price := old.original_price;
  new.listing_id := old.listing_id;
  new.created_at := old.created_at;

  if auth.uid() != old.seller_id then
    new.counter_amount := old.counter_amount;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_protect_offer_history on public.listing_offers;
create trigger trg_protect_offer_history
  before update on public.listing_offers
  for each row
  execute function public.protect_offer_history();
