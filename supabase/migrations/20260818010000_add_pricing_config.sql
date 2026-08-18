-- Platform economics config: marketplace commission rate, minimum card
-- balance, minimum listing price. Single source of truth in the DB so
-- tuning any of these is an admin edit, not a redeploy. Singleton table
-- (id is pinned to 1) -- there is exactly one row, always.
--
-- RLS is enabled AND given an explicit admin-role policy for UPDATE --
-- deliberately not just "enable RLS and assume the default-deny is enough".
-- Public SELECT is required: the sell form and checkout need to read these
-- values client-side to show real numbers before a seller submits.

create table public.pricing_config (
  id smallint primary key default 1 check (id = 1),
  marketplace_commission_rate numeric(5,4) not null default 0.12 check (marketplace_commission_rate >= 0 and marketplace_commission_rate <= 1),
  min_card_balance numeric(10,2) not null default 20.00 check (min_card_balance >= 0),
  min_listing_price numeric(10,2) not null default 15.00 check (min_listing_price >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

comment on table public.pricing_config is 'Singleton row (id=1) holding the live marketplace commission rate and the minimum card balance / listing price floors. Read by the sell form, the submission trigger, and the checkout endpoint -- never hardcode these values elsewhere.';

insert into public.pricing_config (id, marketplace_commission_rate, min_card_balance, min_listing_price)
values (1, 0.12, 20.00, 15.00);

alter table public.pricing_config enable row level security;

create policy pricing_config_select_public
  on public.pricing_config for select
  using (true);

-- Explicit role check, not a bare "using (true)" or reliance on RLS being
-- merely enabled -- the policy itself verifies the caller is an admin.
create policy pricing_config_update_admin_only
  on public.pricing_config for update
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- Dispute economics: a flat estimated cost per dispute (support time,
-- chargeback risk, refund processing), logged against the order so the
-- admin dashboard's net-contribution figure reflects real losses, not
-- just gross commission minus Stripe fees. Not part of pricing_config --
-- this wasn't asked to be tunable from admin, so it's a plain default
-- rather than another config row.
alter table public.disputes
  add column estimated_cost numeric(10,2) not null default 25.00;

comment on column public.disputes.estimated_cost is 'Flat estimated cost of a dispute (support time, chargeback/refund risk), subtracted from net contribution in the admin economics dashboard.';

-- Per-order economics, populated when the Stripe webhook creates the order
-- row (i.e. "on every completed sale" = payment succeeded). Nullable:
-- Instant Sell orders (sale_mode = 'instant') have no marketplace
-- commission concept, so these stay null for them by design.
alter table public.orders
  add column gross_commission numeric(10,2),
  add column stripe_fee numeric(10,2),
  add column stripe_fee_is_estimated boolean,
  add column net_contribution numeric(10,2);

comment on column public.orders.gross_commission is 'sale_price * the commission rate that applied to THIS listing (its own locked-in listings.commission_rate, not necessarily today''s config) at the time of sale. Null for Instant Sell orders.';
comment on column public.orders.stripe_fee is 'Stripe''s actual reported fee from the charge''s balance transaction where available; otherwise a rough estimate -- see stripe_fee_is_estimated.';
comment on column public.orders.stripe_fee_is_estimated is 'True if stripe_fee is an estimate (the real balance transaction fee was not yet available when the order was recorded), false if it is Stripe''s actual reported fee.';
comment on column public.orders.net_contribution is 'gross_commission - stripe_fee for this single order. Dispute costs are NOT baked in here (a dispute is a separate cost event, possibly logged well after the sale) -- subtract disputes.estimated_cost separately when aggregating.';

-- No more buyer-side service fee -- this column stays (never dropped, to
-- avoid disturbing the total column's NOT NULL contract) but every new
-- order will insert 0 here going forward. total = sale_price now, always.
alter table public.orders
  alter column service_fee set default 0;

-- Absolute-dollar minimum balance floor, IN ADDITION to the existing
-- 20%-of-face-value rule (both must pass) -- and a configurable minimum
-- listing price, replacing the old hardcoded "$10 minimum" for marketplace
-- asking prices specifically (face_value's own separate $10 floor is
-- untouched). Reads pricing_config fresh on every submission -- a missing
-- config row blocks the submission with an explicit error rather than
-- silently letting anything through, since an unconfigured floor must
-- never be treated as "no floor."
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
  v_min_card_balance numeric;
  v_min_listing_price numeric;
begin
  -- Marketplace-only for launch: Instant Sell paused until there's capital
  -- to fund it. This is the REAL enforcement -- the Sell page no longer
  -- offers the option client-side, but that alone isn't trustworthy (this
  -- app has already had a case of a client-side-only restriction being
  -- bypassed by calling the API directly). To bring Instant Sell back
  -- later: delete this one block. Nothing else about the Instant Sell
  -- system needs to change -- it was left fully intact on purpose.
  if new.sale_mode = 'instant' then
    raise exception 'Instant Sell is not currently available. Please use Marketplace.';
  end if;

  select min_card_balance, min_listing_price
  into v_min_card_balance, v_min_listing_price
  from public.pricing_config where id = 1;

  if v_min_card_balance is null or v_min_listing_price is null then
    raise exception 'Pricing configuration is missing. Contact support before submitting -- this is not something you can fix by retrying.';
  end if;

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

  -- Rule 1 (unchanged): balance must be at least 20% of the original
  -- value. This is separate from and additional to the absolute-dollar
  -- floor below -- both must pass, whichever is stricter for this card's
  -- face value is the one that actually binds.
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
$$ language plpgsql security definer set search_path = public, extensions;
