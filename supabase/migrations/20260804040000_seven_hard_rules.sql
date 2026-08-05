-- Seven hard rules, effective immediately, both Instant Sell and
-- Marketplace. Extends the existing validate_card_format() trigger
-- rather than adding new ones, since trigger execution order matters
-- (must run before the encryption trigger).

alter table public.submissions
  add column card_number_hash text,
  add column issue_date date;

create index idx_submissions_card_number_hash on public.submissions(card_number_hash) where status = 'rejected';

comment on column public.submissions.card_number_hash is 'SHA-256 hash of the plaintext card number, computed before encryption (card_number itself is non-deterministically encrypted via PGP, so it can never be directly compared for equality). Used only to detect exact resubmission of a previously-rejected card number -- the hash itself reveals nothing about the original value.';
comment on column public.submissions.issue_date is 'When the card was originally purchased/issued. Required for Instant Sell (enforced in the trigger); optional for Marketplace. Cards older than 3 years get flagged for admin (client-side "Old Card" badge), not auto-rejected -- every submission already goes through manual review regardless.';

create or replace function public.validate_card_format()
returns trigger as $$
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
begin
  select card_number_length, card_number_length_alt, card_number_format, pin_length, pin_required
  into rules
  from public.brand_discounts
  where brand = new.brand;

  brand_row_exists := found;
  brand_format_unconfirmed := (not brand_row_exists or rules.card_number_length is null);

  select count(*) into approved_count from public.submissions where seller_id = new.seller_id and status = 'approved';
  select count(*) into recent_count from public.submissions where seller_id = new.seller_id and created_at >= now() - interval '24 hours' and deleted_at is null;
  select count(*) into dispute_count from public.disputes where seller_id = new.seller_id;
  select count(*) into completed_sales_count from public.listings where seller_id = new.seller_id and sale_mode = 'marketplace' and status = 'sold';
  is_established := approved_count >= 5;
  is_new_seller := approved_count < 3;
  is_new_marketplace_seller := completed_sales_count < 3;

  -- Rule 7b: block resubmission of a previously-rejected card number.
  computed_hash := encode(digest(new.card_number, 'sha256'), 'hex');
  new.card_number_hash := computed_hash;

  select count(*) into rejected_duplicate_count
  from public.submissions
  where card_number_hash = computed_hash and status = 'rejected';

  if rejected_duplicate_count > 0 then
    raise exception 'This card has been previously reviewed and cannot be resubmitted.';
  end if;

  -- Rule 6: evidence mandatory for every submission, both modes.
  if new.receipt_storage_path is null and new.card_photo_storage_path is null then
    raise exception 'Please upload a receipt or a photo of your gift card.';
  end if;

  if new.face_value < 10 then
    raise exception 'Minimum card value is $10.';
  end if;

  if new.face_value > 500 and is_new_seller then
    raise exception 'Maximum card value for new sellers is $500.';
  end if;

  -- Rule 4: Marketplace-specific $100 cap, based on completed SALES.
  if new.sale_mode = 'marketplace' and new.seller_set_price is not null then
    if new.seller_set_price > 100 and is_new_marketplace_seller then
      raise exception 'New sellers are limited to $100 maximum. Complete 3 sales to unlock higher values.';
    end if;
    if new.seller_set_price < 10 then
      raise exception 'Minimum card value is $10.';
    end if;
  end if;

  -- Rule 1: balance floor raised from 10%% to 20%%.
  if new.current_balance < new.face_value * 0.2 then
    raise exception 'Cards must have at least 20%% of the original value remaining to be accepted.';
  end if;

  -- Rule 3: expiry window extended from 30 to 60 days.
  if new.expiry_date < (current_date + interval '60 days') then
    raise exception 'Cards must be valid for at least 60 days.';
  end if;

  -- Rule 5: issue date required for Instant Sell.
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
$$ language plpgsql security definer set search_path = public, extensions;
