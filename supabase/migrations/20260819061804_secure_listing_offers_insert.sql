-- BACKFILL: applied directly to the live database on 2026-08-19, never
-- committed as a file -- see the note at the top of
-- 20260818194136_add_reconciliation_incidents.sql. Do NOT re-apply -- this
-- object is already live.
--
-- listing_offers had an INSERT policy (buyer_id = auth.uid(), from
-- 20260802010000_counter_offers_and_notification_prefs.sql) but nothing
-- stopped a client from setting seller_id/original_price to anything it
-- wanted, offering outside the +/-25% band, offering on its own listing,
-- offering on a non-active or non-marketplace listing, or stacking
-- duplicate active offers on the same listing. This trigger closes that
-- gap the same way enforce_payout_release_hold does elsewhere in this
-- schema: server-side, on every insert, regardless of caller.
--
-- The function body below is pulled verbatim from the live database via
-- pg_get_functiondef(). Postgres only exposes an object's *current*
-- definition, not its historical diffs, so this is necessarily the
-- post-fix body (the next migration, fix_offer_insert_retailer_lookup, is
-- the one named for correcting its retailer-enabled check) -- applying
-- both files in order still reconstructs the live function exactly, which
-- is what matters for disaster recovery.

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

drop trigger if exists trg_enforce_offer_insert on public.listing_offers;
create trigger trg_enforce_offer_insert
before insert on public.listing_offers
for each row execute function public.enforce_offer_insert();
