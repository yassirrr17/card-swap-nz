-- Retailer-specific gift card submission validation, researched per brand
-- (see docs/research/retailer-card-validation-research.md for the full
-- research trail and sources). Adds validation rule columns to
-- brand_discounts, populates all nine supported brands with researched
-- values, and enforces the rules server-side via a trigger -- client-side
-- validation gives immediate feedback, this is what actually protects
-- the data, since a client-side-only check can always be bypassed.

alter table public.brand_discounts
  add column card_number_length integer,
  add column card_number_length_alt integer,
  add column card_number_format text check (card_number_format is null or card_number_format in ('digits', 'alphanumeric')),
  add column pin_length integer,
  add column pin_required boolean not null default false,
  add column confidence_level text not null default 'low' check (confidence_level in ('high', 'medium', 'low')),
  add column validation_source text,
  add column validation_notes text;

comment on column public.brand_discounts.card_number_length is 'NULL means length validation is disabled for this brand (unconfirmed from official sources) -- never guess a plausible-sounding number here.';
comment on column public.brand_discounts.card_number_length_alt is 'Optional second accepted length (e.g. Rebel Sport accepts both 17-digit current and 19-digit legacy cards).';

-- Populate all nine supported brands with researched values. Uses UPSERT
-- so this is safe whether or not each brand's row already exists, and
-- deliberately does NOT touch discount_percent/instant_sell_available/
-- retailer_enabled for existing rows -- only the validation-specific
-- columns listed in DO UPDATE SET are ever overwritten here.
insert into public.brand_discounts (brand, discount_percent, card_number_length, card_number_length_alt, card_number_format, pin_length, pin_required, confidence_level, validation_source, validation_notes)
values
  ('The Warehouse', 15, null, null, null, null, false, 'low', 'thewarehouse.co.nz/gift-card-balance-check.html (official)', 'Confirmed: no PIN required for online balance check. Card number length/format NOT confirmed by any official source -- length and format validation deliberately disabled rather than guessed.'),
  ('Woolworths', 10, 19, null, 'digits', 4, true, 'high', 'giftcardbalance.woolworths.co.nz/en-nz/checkbalance (official, verbatim: "19 digit card number and the 4 digit passcode")', 'Fully confirmed from an official source. Runs on the epay Gift Station platform.'),
  ('New World', 15, null, null, null, 4, true, 'medium', 'giftstation.co.nz/faq (official epay Gift Station FAQ)', 'PIN confirmed 4-digit required (Foodstuffs/epay Gift Station system, same platform as Woolworths). Card number length NOT confirmed -- likely 19 digits by inference from Woolworths on the same platform, but unverified, so length validation is disabled.'),
  ('Farmers', 15, null, null, null, 4, true, 'medium', 'Farmers official gift card balance checker (farmers.co.nz)', 'PIN confirmed 4-digit required. Card number length NOT confirmed -- validation disabled. Farmers is owned by James Pascoe Group, NOT related to Noel Leeming (The Warehouse Group) -- do not assume a shared format.'),
  ('Noel Leeming', 15, null, null, 'alphanumeric', null, false, 'low', 'noelleeming.co.nz/gift-card-balance-checker (official)', 'Card number confirmed ALPHANUMERIC (includes letters) -- do not enable digits-only validation. No PIN required on Noel Leeming''s own checker. Note: cards issued via the separate epay Gift Station retail channel may use a different 4-digit-PIN variant -- length still unconfirmed either way.'),
  ('Briscoes', 15, null, null, null, null, false, 'low', 'Inferred from sister brand Rebel Sport (same Briscoe Group); no Briscoes-specific official balance page found', 'No field confirmed specifically for Briscoes. Provisionally likely mirrors Rebel Sport (17 or 19 digit numeric + PIN) given shared ownership, but this is an inference, not a confirmation -- all validation disabled pending a Briscoes-specific check.'),
  ('Rebel Sport', 0, 17, 19, 'digits', null, true, 'medium', 'rebelsport.com.au/customer-service/giftcard-terms.html (official AU T&Cs; NZ programme assumed identical via shared Briscoe Group ownership)', 'Card number officially 17 digits, OR 19 digits for cards issued before October 2021 -- both lengths accepted. PIN ("Access PIN") confirmed required but its exact digit count is not published, so only presence is enforced, not an exact length.'),
  ('PB Tech', 15, null, null, null, null, false, 'low', 'pbtech.co.nz/help/article/22/payment-methods (official)', 'Confirmed: online redemption uses no PIN. Card number length/format not published anywhere official -- validation disabled.'),
  ('Pak''nSave', 15, null, null, null, 4, true, 'medium', 'giftstation.co.nz/faq; paknsave.co.nz/more/gift-cards (both official)', 'Same system as New World (Foodstuffs, epay Gift Station). PIN confirmed 4-digit required. Card number length NOT confirmed -- likely 19 digits by inference from Woolworths on the same platform, but unverified, so length validation is disabled.')
on conflict (brand) do update set
  card_number_length = excluded.card_number_length,
  card_number_length_alt = excluded.card_number_length_alt,
  card_number_format = excluded.card_number_format,
  pin_length = excluded.pin_length,
  pin_required = excluded.pin_required,
  confidence_level = excluded.confidence_level,
  validation_source = excluded.validation_source,
  validation_notes = excluded.validation_notes;

-- Server-side enforcement. Note the trigger name deliberately sorts
-- alphabetically BEFORE trg_encrypt_submission_card_data (from an earlier
-- migration) -- Postgres runs same-timing triggers in name order, and
-- this MUST run before encryption, or it would be validating ciphertext
-- length instead of the real card number.
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

drop trigger if exists trg_validate_card_format on public.submissions;
drop trigger if exists trg_card_format_validation on public.submissions;
create trigger trg_card_format_validation
  before insert on public.submissions
  for each row
  execute function public.validate_card_format();
