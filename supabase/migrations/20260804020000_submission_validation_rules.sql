-- Submission validation rules: minimum/maximum card value (tiered by
-- seller trust), minimum remaining balance, minimum expiry window, tiered
-- daily submission limits, and an evidence requirement combining brand
-- format confidence with seller trust. Extends the existing
-- validate_card_format() trigger rather than adding a new one, since
-- trigger execution order matters here (this must run before the
-- encryption trigger, which the existing trigger name already guarantees
-- alphabetically).
--
-- "Established seller" is defined consistently as 5+ approved
-- submissions -- the same bar used for both the daily-limit tier and the
-- evidence-requirement tier. "New seller" is fewer than 3 approved
-- submissions.

create or replace function public.validate_card_format()
returns trigger as $$
declare
  rules record;
  card_len integer;
  pin_len integer;
  approved_count integer;
  recent_count integer;
  dispute_count integer;
  is_established boolean;
  is_new_seller boolean;
  daily_cap integer;
  brand_format_unconfirmed boolean;
  brand_row_exists boolean;
begin
  select card_number_length, card_number_length_alt, card_number_format, pin_length, pin_required
  into rules
  from public.brand_discounts
  where brand = new.brand;

  -- Captured immediately, before any other query can overwrite FOUND.
  brand_row_exists := found;
  brand_format_unconfirmed := (not brand_row_exists or rules.card_number_length is null);

  select count(*) into approved_count from public.submissions where seller_id = new.seller_id and status = 'approved';
  select count(*) into recent_count from public.submissions where seller_id = new.seller_id and created_at >= now() - interval '24 hours' and deleted_at is null;
  select count(*) into dispute_count from public.disputes where seller_id = new.seller_id;
  is_established := approved_count >= 5;
  is_new_seller := approved_count < 3;

  -- Evidence requirement: brand format unconfirmed, OR seller is new/has
  -- a dispute history. Either condition alone is enough to require it.
  if (brand_format_unconfirmed or is_new_seller or dispute_count > 0) then
    if new.receipt_storage_path is null and new.card_photo_storage_path is null then
      raise exception 'A receipt or a photo of the card is required for this submission';
    end if;
  end if;

  if new.face_value < 10 then
    raise exception 'Minimum card value is $10.';
  end if;

  if new.face_value > 500 and is_new_seller then
    raise exception 'Maximum card value for new sellers is $500.';
  end if;

  if new.current_balance < new.face_value * 0.1 then
    raise exception 'Cards must have at least 10%% of the original value remaining.';
  end if;

  if new.expiry_date < (current_date + interval '30 days') then
    raise exception 'Cards must be valid for at least 30 days.';
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
$$ language plpgsql security definer set search_path = public;
