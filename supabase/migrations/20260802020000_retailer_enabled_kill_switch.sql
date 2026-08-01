alter table public.brand_discounts
  add column retailer_enabled boolean not null default true;

comment on column public.brand_discounts.retailer_enabled is 'Whole-retailer kill switch: when false, blocks BOTH buying existing listings of this brand AND submitting new ones (any sale mode) app-wide. Broader than the older instant_sell_available column, which only ever affected the Instant Sell submission form.';
