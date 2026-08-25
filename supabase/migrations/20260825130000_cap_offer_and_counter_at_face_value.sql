-- Bug: the +/-25% offer/counter-offer range was calculated purely from
-- the listing's sale_price, with no ceiling tied to what the card is
-- actually worth. A $90 listing (on a $100-remaining-balance card) could
-- take offers up to $112.50 -- more than the card is worth. No rational
-- buyer or seller should be able to land above the card's remaining
-- balance, which is what listings.face_value already holds (populated
-- from the submission's current_balance at approval time, not the
-- original printed value -- see app.js's approve flow).
--
-- Same fix in both places that set/accept a price on an offer:
-- enforce_offer_insert() (the buyer's initial offer) and
-- protect_offer_history() (the seller's counter-offer). The floor
-- (original_price * 0.75) is untouched in both -- only the ceiling gets
-- capped at face_value, via least(original_price * 1.25, face_value).
-- The looser offer_within_range/counter_within_range CHECK constraints
-- stay as-is; a tighter cap here is always still within that wider bound.

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
  select l.id, l.seller_id, l.sale_price, l.status, l.sale_mode, l.brand, l.face_value
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
  v_max := least(round(v_listing.sale_price * 1.25, 2), v_listing.face_value);

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

create or replace function public.protect_offer_history()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_face_value numeric;
  v_min numeric;
  v_max numeric;
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
  elsif new.counter_amount is not null and new.counter_amount is distinct from old.counter_amount then
    select l.face_value into v_face_value from listings l where l.id = old.listing_id;

    v_min := round(old.original_price * 0.75, 2);
    v_max := least(round(old.original_price * 1.25, 2), v_face_value);

    if new.counter_amount < v_min or new.counter_amount > v_max then
      raise exception 'Counter offer must be between % and %.', v_min, v_max;
    end if;
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
