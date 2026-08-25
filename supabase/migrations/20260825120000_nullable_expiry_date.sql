-- Some gift cards legitimately have no expiry (a growing number of NZ
-- retailers issue non-expiring cards). expiry_date was hard NOT NULL on
-- submissions/listings/card_vault, which made "no expiry" impossible to
-- represent. Widen all three to nullable -- existing rows already have
-- real dates, so no backfill is needed.
alter table public.submissions alter column expiry_date drop not null;
alter table public.listings alter column expiry_date drop not null;
alter table public.card_vault alter column expiry_date drop not null;

-- The "cards must be valid for at least N days" floor was hardcoded to 60
-- inside validate_card_format() (and duplicated client-side). Moves into
-- pricing_config alongside the other tunables (transaction_cap_amount,
-- dispute_claim_window_hours, ...) so it's an admin edit, not a redeploy.
-- Default matches the existing hardcoded value -- this migration changes
-- WHERE the number lives, not what it is.
alter table public.pricing_config
  add column min_expiry_window_days integer not null default 60 check (min_expiry_window_days >= 0);

comment on column public.pricing_config.min_expiry_window_days is 'Minimum number of days a card must remain valid to be accepted at submission time. A null expiry_date (no-expiry card) always passes this check regardless of this value.';

-- Same body as the live version (20260818191426_security_remediation_snapshot.sql)
-- with two changes: (1) min_expiry_window_days is read from pricing_config
-- alongside the other floors, with the same "missing config blocks the
-- submission" guard the other two already get; (2) the expiry check is
-- skipped entirely when expiry_date is null, explicitly, rather than
-- relying on SQL's implicit-false-on-NULL comparison to happen to do the
-- right thing.
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
  v_min_expiry_window_days integer;
begin
  if new.sale_mode = 'instant' then
    raise exception 'Instant Sell is not currently available. Please use Marketplace.';
  end if;

  select min_card_balance, min_listing_price, min_expiry_window_days
  into v_min_card_balance, v_min_listing_price, v_min_expiry_window_days
  from public.pricing_config where id = 1;

  if v_min_card_balance is null or v_min_listing_price is null or v_min_expiry_window_days is null then
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

  if new.expiry_date is not null and new.expiry_date < (current_date + (v_min_expiry_window_days || ' days')::interval) then
    raise exception 'Cards must be valid for at least % days.', v_min_expiry_window_days;
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
