-- BACKFILL: applied directly to the live database on 2026-08-19, never
-- committed as a file -- see the note at the top of
-- 20260818194136_add_reconciliation_incidents.sql. Do NOT re-apply -- this
-- fix is already live.
--
-- This migration corrected enforce_offer_insert()'s retailer-enabled
-- check: the kill-switch lives on brand_discounts.retailer_enabled, keyed
-- by brand, not on the listing row itself, so the lookup has to join out
-- to brand_discounts rather than read a column off listings directly.
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

create or replace function public.enforce_offer_insert()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_listing record;
  v_enabled boolean;
  v_min numeric;
  v_max numeric;
begin
  select l.id, l.seller_id, l.sale_price, l.status, l.sale_mode, l.brand
    into v_listing
  from listings l
  where l.id = new.listing_id;

  if not found then
    raise exception 'That listing does not exist.';
  end if;

  if v_listing.status <> 'active' then
    raise exception 'Offers can only be made on active listings.';
  end if;

  if v_listing.sale_mode <> 'marketplace' then
    raise exception 'Offers are only available on marketplace listings.';
  end if;

  -- retailer kill-switch lives on brand_discounts, not listings
  select bd.retailer_enabled into v_enabled
  from brand_discounts bd where bd.brand = v_listing.brand;

  if v_enabled is false then
    raise exception 'This retailer is temporarily unavailable.';
  end if;

  if v_listing.seller_id = new.buyer_id then
    raise exception 'You cannot make an offer on your own listing.';
  end if;

  -- Never trust these from the client. Derive them.
  new.seller_id      := v_listing.seller_id;
  new.original_price := v_listing.sale_price;
  new.status         := 'pending';
  new.counter_amount := null;
  new.responded_at   := null;
  new.created_at     := timezone('utc', now());

  v_min := round(v_listing.sale_price * 0.75, 2);
  v_max := round(v_listing.sale_price * 1.25, 2);

  if new.offer_amount is null or new.offer_amount <= 0 then
    raise exception 'Enter a valid offer amount.';
  end if;

  if new.offer_amount < v_min or new.offer_amount > v_max then
    raise exception 'Offer must be between % and %.', v_min, v_max;
  end if;

  if exists (
    select 1 from listing_offers o
    where o.listing_id = new.listing_id
      and o.buyer_id = new.buyer_id
      and o.status in ('pending','countered','accepted')
  ) then
    raise exception 'You already have an active offer on this listing.';
  end if;

  return new;
end;
$function$;
