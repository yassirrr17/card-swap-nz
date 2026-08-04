-- Bug fix: Giftlio was making zero margin on Instant Sell resales -- the
-- price paid to the seller and the price shown to buyers on that same
-- card were the exact same number. Adds ONE column to the existing
-- brand_discounts table (no new table). The seller's payout is UNCHANGED
-- (still discount_percent off face value). The resale listing uses a
-- smaller effective discount (discount_percent minus resale_markup_percent),
-- so buyers pay closer to face value than what the seller received -- that
-- gap is Giftlio's margin. A markup of 0 (the default) reproduces the old
-- behaviour exactly. Marketplace listings are entirely unaffected --
-- sellers there always set their own price.

alter table public.brand_discounts
  add column resale_markup_percent numeric not null default 0 check (resale_markup_percent >= 0 and resale_markup_percent <= 25);

comment on column public.brand_discounts.resale_markup_percent is 'Instant Sell only. The seller is still paid at discount_percent off face value (unchanged). The resale listing price uses a SMALLER effective discount (discount_percent minus resale_markup_percent), so buyers pay closer to face value than what the seller received -- that gap is Giftlio''s margin on owned inventory. Marketplace listings are entirely unaffected; sellers there always set their own price.';
