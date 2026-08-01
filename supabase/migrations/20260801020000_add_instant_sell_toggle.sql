alter table public.brand_discounts
  add column instant_sell_available boolean not null default true;

comment on column public.brand_discounts.instant_sell_available is 'When false, this brand is hidden from the Instant Sell submission form but remains visible in Marketplace mode and the browse grid.';
