-- Card photo upload (alongside the existing receipt upload), and an
-- evidence requirement: for brands where card format can't be
-- automatically validated (Other, or any brand the retailer research
-- couldn't officially confirm a length for), require at least a receipt
-- or a card photo. Brands with a confirmed format don't need this --
-- passing that validation is itself reasonably strong evidence.

alter table public.submissions
  add column card_photo_filename text,
  add column card_photo_storage_path text;

comment on column public.submissions.card_photo_storage_path is 'Path to an uploaded photo of the physical/digital card in the receipts storage bucket. Alongside receipt_storage_path, at least one is required for brands with no confirmed card-format validation rules (see brand_discounts.card_number_length).';

create or replace function public.validate_card_format()
returns trigger as $$
declare
  rules record;
  card_len integer;
  pin_len integer;
begin
  select card_number_length, card_number_length_alt, card_number_format, pin_length, pin_required
  into rules
  from public.brand_discounts
  where brand = new.brand;

  if (not found or rules.card_number_length is null) then
    if new.receipt_storage_path is null and new.card_photo_storage_path is null then
      raise exception 'A receipt or a photo of the card is required for %, since its card format can''t be automatically verified', new.brand;
    end if;
  end if;

  if not found then
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
