-- Marketplace-only launch mode. Instant Sell is paused (not deleted) until
-- there's capital to fund it -- Instant Sell requires paying sellers
-- upfront before the card resells, which is a real cash requirement
-- Marketplace doesn't have (commission is only collected after a buyer
-- actually purchases).
--
-- This adds ONE hard block to the existing validate_card_format() trigger:
-- any new submission with sale_mode = 'instant' is rejected outright. This
-- is deliberately the ONLY change to the trigger -- every other Instant
-- Sell rule (issue date requirement, etc.) is left completely intact,
-- since it becomes unreachable on its own once this block is in place,
-- and needs no changes when Instant Sell comes back later.
--
-- To re-enable Instant Sell: remove the IF block at the top of this
-- function that raises the "not currently available" exception. Nothing
-- else in the database needs to change.
--
-- Client-side, the Sell page no longer offers the Instant Sell option at
-- all -- but per this app's own history (a previous client-side-only
-- price restriction was once bypassed by calling the API directly), the
-- real enforcement has to live here, not just in the UI.

CREATE OR REPLACE FUNCTION public.validate_card_format()
RETURNS TRIGGER AS $$
DECLARE
  rules RECORD;
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
BEGIN
  IF NEW.sale_mode = 'instant' THEN
    RAISE EXCEPTION 'Instant Sell is not currently available. Please use Marketplace.';
  END IF;

  SELECT card_number_length, card_number_length_alt, card_number_format, pin_length, pin_required
  INTO rules
  FROM public.brand_discounts
  WHERE brand = NEW.brand;

  brand_row_exists := FOUND;
  brand_format_unconfirmed := (NOT brand_row_exists OR rules.card_number_length IS NULL);

  SELECT count(*) INTO approved_count FROM public.submissions WHERE seller_id = NEW.seller_id AND status = 'approved';
  SELECT count(*) INTO recent_count FROM public.submissions WHERE seller_id = NEW.seller_id AND created_at >= now() - interval '24 hours' AND deleted_at IS NULL;
  SELECT count(*) INTO dispute_count FROM public.disputes WHERE seller_id = NEW.seller_id;
  SELECT count(*) INTO completed_sales_count FROM public.listings WHERE seller_id = NEW.seller_id AND sale_mode = 'marketplace' AND status = 'sold';
  is_established := approved_count >= 5;
  is_new_seller := approved_count < 3;
  is_new_marketplace_seller := completed_sales_count < 3;

  computed_hash := encode(digest(NEW.card_number, 'sha256'), 'hex');
  NEW.card_number_hash := computed_hash;

  SELECT count(*) INTO rejected_duplicate_count
  FROM public.submissions
  WHERE card_number_hash = computed_hash AND status = 'rejected';

  IF rejected_duplicate_count > 0 THEN
    RAISE EXCEPTION 'This card has been previously reviewed and cannot be resubmitted.';
  END IF;

  IF NEW.receipt_storage_path IS NULL AND NEW.card_photo_storage_path IS NULL THEN
    RAISE EXCEPTION 'Please upload a receipt or a photo of your gift card.';
  END IF;

  IF NEW.face_value < 10 THEN
    RAISE EXCEPTION 'Minimum card value is $10.';
  END IF;

  IF NEW.face_value > 500 AND is_new_seller THEN
    RAISE EXCEPTION 'Maximum card value for new sellers is $500.';
  END IF;

  IF NEW.sale_mode = 'marketplace' AND NEW.seller_set_price IS NOT NULL THEN
    IF NEW.seller_set_price > 100 AND is_new_marketplace_seller THEN
      RAISE EXCEPTION 'New sellers are limited to $100 maximum. Complete 3 sales to unlock higher values.';
    END IF;
    IF NEW.seller_set_price < 10 THEN
      RAISE EXCEPTION 'Minimum card value is $10.';
    END IF;
  END IF;

  IF NEW.current_balance < NEW.face_value * 0.2 THEN
    RAISE EXCEPTION 'Cards must have at least 20%% of the original value remaining to be accepted.';
  END IF;

  IF NEW.expiry_date < (current_date + interval '60 days') THEN
    RAISE EXCEPTION 'Cards must be valid for at least 60 days.';
  END IF;

  IF NEW.sale_mode = 'instant' AND NEW.issue_date IS NULL THEN
    RAISE EXCEPTION 'Issue date is required for Instant Sell submissions.';
  END IF;

  daily_cap := CASE WHEN is_established THEN 10 ELSE 3 END;
  IF recent_count >= daily_cap THEN
    RAISE EXCEPTION 'Daily submission limit reached. Try again tomorrow.';
  END IF;

  IF NOT brand_row_exists THEN
    RETURN NEW;
  END IF;

  card_len := length(NEW.card_number);

  IF rules.card_number_length IS NOT NULL THEN
    IF NOT (card_len = rules.card_number_length OR (rules.card_number_length_alt IS NOT NULL AND card_len = rules.card_number_length_alt)) THEN
      IF rules.card_number_length_alt IS NOT NULL THEN
        RAISE EXCEPTION 'Invalid card number length for %: expected % or % digits, got %',
          NEW.brand, rules.card_number_length, rules.card_number_length_alt, card_len;
      ELSE
        RAISE EXCEPTION 'Invalid card number length for %: expected % digits, got %',
          NEW.brand, rules.card_number_length, card_len;
      END IF;
    END IF;
  END IF;

  IF rules.card_number_format = 'digits' AND NEW.card_number !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Invalid card number format for %: must be digits only', NEW.brand;
  END IF;

  IF rules.pin_required AND (NEW.pin IS NULL OR length(trim(NEW.pin)) = 0) THEN
    RAISE EXCEPTION 'A PIN is required for % gift cards', NEW.brand;
  END IF;

  IF rules.pin_length IS NOT NULL AND NEW.pin IS NOT NULL AND length(NEW.pin) > 0 THEN
    pin_len := length(NEW.pin);
    IF pin_len != rules.pin_length THEN
      RAISE EXCEPTION 'Invalid PIN length for %: expected % digits, got %', NEW.brand, rules.pin_length, pin_len;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions;
