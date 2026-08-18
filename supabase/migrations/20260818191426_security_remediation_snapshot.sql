-- ============================================================================
-- SNAPSHOT MIGRATION -- NOT a pending change.
--
-- Every statement below is ALREADY LIVE on the production Supabase project
-- (kwcoziqzadeoooalwpjs) as of 2026-08-18. It was applied directly via the
-- Supabase MCP (apply_migration / execute_sql) during a security remediation
-- driven from a chat session, without ever being written to a migration file
-- in this repo -- so git history for that period shows only application code
-- changes and says nothing about the database. This file closes that gap: it
-- is the current live definition of every RLS policy, trigger, function, and
-- grant touched during that remediation (DIAGNOSTIC.md, gitignored, has the
-- full narrative), generated FROM the live database (pg_policies,
-- pg_get_functiondef, pg_get_triggerdef, information_schema/has_function_
-- privilege) at the time this file was written -- not reconstructed from
-- memory. Running it against a project already in this state is a no-op
-- (every statement is idempotent: CREATE OR REPLACE / DROP+CREATE POLICY /
-- REVOKE+GRANT). Its real purpose is disaster recovery: if this Supabase
-- project is ever lost or rebuilt from an earlier backup, this file is what
-- restores the audit's fixes.
--
-- Included, by remediation group:
--
-- Group 0 -- SECURITY DEFINER function grants tightened so trigger functions
--   and decrypt_card_value aren't directly callable by anon/authenticated.
-- Group 1 -- orders has no INSERT policy at all (service role only, via
--   api/webhook.js, which bypasses RLS).
-- Group 3 -- listings SELECT respects both listings.suspended and the
--   seller's own profiles.suspended (is_seller_suspended() helper).
-- Group 4 -- listing_offers.status can only move along the transition the
--   specific party (buyer/seller/admin) is actually allowed to make.
-- Group 5 (M2) -- a disabled retailer blocks both new submissions
--   (validate_card_format) and new listings/approvals
--   (validate_listing_retailer_enabled, new trigger).
-- Post-remediation fix (this file) -- decrypt_card_value's Group 0 grant
--   change over-corrected and blocked the real admin approval flow
--   (approveSubmission() in app.js calls it as the browser's own
--   'authenticated' session, not service_role); re-granted to authenticated.
--   Also made the NULL case in validate_listing_retailer_enabled() an
--   explicit branch instead of relying on implicit NULL-in-IF semantics, and
--   locked down validate_listing_retailer_enabled()'s own grant to match the
--   Group 0 trigger-function pattern (it had been missed).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Group 0: SECURITY DEFINER function grants
-- ----------------------------------------------------------------------------

-- decrypt_card_value: NOT callable by anon (closes the original audit
-- finding -- anon has no JWT, so the function's own
-- `is_admin() OR auth.uid() IS NULL` check couldn't distinguish anon from a
-- legitimate service-role caller). IS callable by authenticated (required --
-- app.js's approveSubmission() calls this RPC as the admin's own browser
-- session; the function body's is_admin() check is the real gate for that
-- caller) and by service_role (api/deliver-order.js).
revoke execute on function public.decrypt_card_value(text) from anon;
revoke execute on function public.decrypt_card_value(text) from authenticated;
grant execute on function public.decrypt_card_value(text) to authenticated;
grant execute on function public.decrypt_card_value(text) to service_role;

-- Trigger functions: never legitimately called directly (trigger firing
-- does not require the invoking role to hold EXECUTE), so anon/authenticated
-- EXECUTE is revoked as hardening. service_role/postgres keep it implicitly
-- (function owner).
revoke execute on function public.encrypt_submission_card_data() from anon, authenticated;
revoke execute on function public.encrypt_vault_card_data() from anon, authenticated;
revoke execute on function public.handle_new_user() from anon, authenticated;
revoke execute on function public.prevent_self_privilege_escalation() from anon, authenticated;
revoke execute on function public.protect_offer_history() from anon, authenticated;
revoke execute on function public.rls_auto_enable() from anon, authenticated;
revoke execute on function public.validate_card_format() from anon, authenticated;

-- is_admin() is intentionally left reachable by anon/authenticated: RLS
-- policies invoke it in the querying role's own context, so both roles need
-- EXECUTE for those policies to evaluate at all. Not modified here.


-- ----------------------------------------------------------------------------
-- Group 1: orders can no longer be forged
-- ----------------------------------------------------------------------------

-- Only the service-role client in api/webhook.js may create an order row
-- (service role bypasses RLS entirely; no INSERT policy exists for
-- anon/authenticated at all). No client code inserts into orders directly.
drop policy if exists "orders_insert_buyer_or_admin" on public.orders;


-- ----------------------------------------------------------------------------
-- Group 3: suspension actually suspends
-- ----------------------------------------------------------------------------

-- SECURITY DEFINER helper so the listings SELECT policy can check a
-- seller's suspension status without being blocked by profiles' own RLS
-- (profiles_select_own_or_admin: own row or admin only) for the querying
-- role -- same pattern as is_admin().
create or replace function public.is_seller_suspended(seller uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select suspended from public.profiles where id = seller), false);
$$;

revoke all on function public.is_seller_suspended(uuid) from public;
grant execute on function public.is_seller_suspended(uuid) to anon, authenticated;

-- A suspended listing, or a listing whose seller is suspended, is invisible
-- to anyone except its owner or an admin -- both listings.suspended and
-- profiles.suspended are enforced here, not just as a UI filter.
drop policy if exists "listings_select_active_or_owner_or_admin" on public.listings;
create policy "listings_select_active_or_owner_or_admin"
on public.listings
for select
using (
  (
    status = 'active'
    and not suspended
    and not public.is_seller_suspended(seller_id)
  )
  or seller_id = auth.uid()
  or is_admin()
);


-- ----------------------------------------------------------------------------
-- Group 4: buyer can no longer self-accept their own offer
-- ----------------------------------------------------------------------------

-- listing_offers.status may only move along the transition the specific
-- party is actually allowed to make: seller pending->accepted/rejected/
-- countered; buyer pending->withdrawn, or countered->buyer_accepted_counter/
-- rejected. Any other attempted transition is silently reset back to
-- OLD.status, same defense-in-depth pattern as the other protected columns
-- below.
create or replace function public.protect_offer_history()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  if new.status is distinct from old.status then
    if auth.uid() = old.seller_id and old.status = 'pending' and new.status in ('accepted', 'rejected', 'countered') then
      -- allowed: seller responding to a pending offer
      null;
    elsif auth.uid() = old.buyer_id and old.status = 'pending' and new.status = 'withdrawn' then
      -- allowed: buyer withdrawing their own pending offer
      null;
    elsif auth.uid() = old.buyer_id and old.status = 'countered' and new.status in ('buyer_accepted_counter', 'rejected') then
      -- allowed: buyer accepting or declining the seller's counter
      null;
    else
      new.status := old.status;
    end if;
  end if;

  return new;
end;
$function$;


-- ----------------------------------------------------------------------------
-- Group 5 (M2): disabled retailer blocks submissions AND new listings
-- ----------------------------------------------------------------------------

-- validate_card_format(): rejects a new submission for a retailer with
-- retailer_enabled = false. brand_row_exists already guards the NULL case
-- explicitly (no brand_discounts row for this brand at all -- an
-- uncatalogued brand -- is not restricted, consistent with the rest of this
-- function's handling of unconfigured brands).
create or replace function public.validate_card_format()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  rules record;
  card_len integer;
  pin_len integer;
  approved_count integer;
  recent_count integer;
  dispute_count integer;
  completed_sales_count integer;
  is_established boolean;
  is_new_seller boolean;
  is_new_marketplace_seller boolean;
  daily_cap integer;
  brand_format_unconfirmed boolean;
  brand_row_exists boolean;
  computed_hash text;
  rejected_duplicate_count integer;
  v_min_card_balance numeric;
  v_min_listing_price numeric;
begin
  if new.sale_mode = 'instant' then
    raise exception 'Instant Sell is not currently available. Please use Marketplace.';
  end if;

  select min_card_balance, min_listing_price
  into v_min_card_balance, v_min_listing_price
  from public.pricing_config where id = 1;

  if v_min_card_balance is null or v_min_listing_price is null then
    raise exception 'Pricing configuration is missing. Contact support before submitting -- this is not something you can fix by retrying.';
  end if;

  select card_number_length, card_number_length_alt, card_number_format, pin_length, pin_required, retailer_enabled
  into rules
  from public.brand_discounts
  where brand = new.brand;

  brand_row_exists := found;
  brand_format_unconfirmed := (not brand_row_exists or rules.card_number_length is null);

  if brand_row_exists and rules.retailer_enabled = false then
    raise exception '% is temporarily unavailable for new submissions right now.', new.brand;
  end if;

  select count(*) into approved_count from public.submissions where seller_id = new.seller_id and status = 'approved';
  select count(*) into recent_count from public.submissions where seller_id = new.seller_id and created_at >= now() - interval '24 hours' and deleted_at is null;
  select count(*) into dispute_count from public.disputes where seller_id = new.seller_id;
  select count(*) into completed_sales_count from public.listings where seller_id = new.seller_id and sale_mode = 'marketplace' and status = 'sold';
  is_established := approved_count >= 5;
  is_new_seller := approved_count < 3;
  is_new_marketplace_seller := completed_sales_count < 3;

  computed_hash := encode(digest(new.card_number, 'sha256'), 'hex');
  new.card_number_hash := computed_hash;

  select count(*) into rejected_duplicate_count
  from public.submissions
  where card_number_hash = computed_hash and status = 'rejected';

  if rejected_duplicate_count > 0 then
    raise exception 'This card has been previously reviewed and cannot be resubmitted.';
  end if;

  if new.receipt_storage_path is null and new.card_photo_storage_path is null then
    raise exception 'Please upload a receipt or a photo of your gift card.';
  end if;

  if new.face_value < 10 then
    raise exception 'Minimum card value is $10.';
  end if;

  if new.face_value > 500 and is_new_seller then
    raise exception 'Maximum card value for new sellers is $500.';
  end if;

  if new.sale_mode = 'marketplace' and new.seller_set_price is not null then
    if new.seller_set_price > 100 and is_new_marketplace_seller then
      raise exception 'New sellers are limited to $100 maximum. Complete 3 sales to unlock higher values.';
    end if;
    if new.seller_set_price < v_min_listing_price then
      raise exception 'Minimum listing price is $%.', to_char(v_min_listing_price, 'FM999999990.00');
    end if;
  end if;

  if new.current_balance < new.face_value * 0.2 then
    raise exception 'Cards must have at least 20%% of the original value remaining to be accepted.';
  end if;

  if new.current_balance < v_min_card_balance then
    raise exception 'Cards need at least $% remaining. Below that isn''t economical for us to process.', to_char(v_min_card_balance, 'FM999999990.00');
  end if;

  if new.expiry_date < (current_date + interval '60 days') then
    raise exception 'Cards must be valid for at least 60 days.';
  end if;

  if new.sale_mode = 'instant' and new.issue_date is null then
    raise exception 'Issue date is required for Instant Sell submissions.';
  end if;

  daily_cap := case when is_established then 10 else 3 end;
  if recent_count >= daily_cap then
    raise exception 'Daily submission limit reached. Try again tomorrow.';
  end if;

  if not brand_row_exists then
    return new;
  end if;

  card_len := length(new.card_number);

  if rules.card_number_length is not null then
    if not (card_len = rules.card_number_length or (rules.card_number_length_alt is not null and card_len = rules.card_number_length_alt)) then
      if rules.card_number_length_alt is not null then
        raise exception 'Invalid card number length for %: expected % or % digits, got %',
          new.brand, rules.card_number_length, rules.card_number_length_alt, card_len;
      else
        raise exception 'Invalid card number length for %: expected % digits, got %',
          new.brand, rules.card_number_length, card_len;
      end if;
    end if;
  end if;

  if rules.card_number_format = 'digits' and new.card_number !~ '^[0-9]+$' then
    raise exception 'Invalid card number format for %: must be digits only', new.brand;
  end if;

  if rules.pin_required and (new.pin is null or length(trim(new.pin)) = 0) then
    raise exception 'A PIN is required for % gift cards', new.brand;
  end if;

  if rules.pin_length is not null and new.pin is not null and length(new.pin) > 0 then
    pin_len := length(new.pin);
    if pin_len != rules.pin_length then
      raise exception 'Invalid PIN length for %: expected % digits, got %', new.brand, rules.pin_length, pin_len;
    end if;
  end if;

  return new;
end;
$function$;

-- validate_listing_retailer_enabled(): closes the second half of the same
-- gap -- a pre-existing pending submission for a brand disabled AFTER
-- submission could still be approved (create a listing) without this.
--
-- Explicit decision on the NULL case: retailer_enabled itself is
-- NOT NULL DEFAULT true on brand_discounts, so is_enabled can only be NULL
-- here when no brand_discounts row exists at all for this brand, never
-- because the column holds a real NULL. DECISION: an uncatalogued brand is
-- NOT restricted by the retailer kill switch -- consistent with
-- validate_card_format() above already letting an unconfigured brand's
-- format through unconfirmed. Written as an explicit branch rather than
-- relying on plpgsql's implicit "NULL condition = skip" IF semantics.
create or replace function public.validate_listing_retailer_enabled()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  is_enabled boolean;
begin
  select retailer_enabled into is_enabled from public.brand_discounts where brand = new.brand;

  if is_enabled is null then
    -- No brand_discounts row for this brand -- uncatalogued, not
    -- restricted. Falls through to allow the listing.
    null;
  elsif not is_enabled then
    raise exception '% is temporarily unavailable -- cannot create a new listing for a disabled retailer.', new.brand;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_validate_listing_retailer_enabled on public.listings;
create trigger trg_validate_listing_retailer_enabled
before insert on public.listings
for each row execute function public.validate_listing_retailer_enabled();

-- Same Group 0 hardening pattern applied to this new trigger function (it
-- was missed when first created, and initially caused no visible problem
-- since nothing calls it directly -- fixed here for consistency, not
-- because it was independently exploitable).
revoke execute on function public.validate_listing_retailer_enabled() from anon, authenticated;
