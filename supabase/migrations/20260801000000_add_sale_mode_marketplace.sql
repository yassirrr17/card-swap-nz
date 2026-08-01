-- Adds support for sellers choosing between Instant Sell (Giftlio buys at a
-- fixed offer, seller paid at approval) and Marketplace mode (seller sets
-- their own price, Giftlio takes a commission, seller paid only after a
-- buyer purchases).

alter table public.submissions
  add column sale_mode text not null default 'instant' check (sale_mode in ('instant', 'marketplace')),
  add column seller_set_price numeric null check (seller_set_price is null or seller_set_price > 0);

alter table public.listings
  add column sale_mode text not null default 'instant' check (sale_mode in ('instant', 'marketplace')),
  add column commission_rate numeric null,
  add column seller_payout_amount numeric null;

comment on column public.submissions.sale_mode is 'instant = Giftlio buys at fixed offer, pays at approval. marketplace = seller sets own price, paid only after a buyer purchases.';
comment on column public.listings.seller_payout_amount is 'Marketplace mode only: seller_set_price minus commission. Null for instant mode (payout already reflected in the linked submission offer_amount).';
