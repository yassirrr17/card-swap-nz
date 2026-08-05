-- Retailer branding colors, admin-controlled. Fixes two real bugs found
-- while building this: the homepage retailer tiles had a literal
-- hardcoded "Up to 20% off" string (completely disconnected from each
-- brand's actual discount_percent), and colors lived in a hardcoded
-- BRAND_COLORS object in app.js rather than being editable anywhere.
--
-- New World gets a genuine two-color split design (red/white) via the new
-- optional brand_color_secondary column -- this makes the split design
-- itself admin-configurable and reusable for any brand, not a one-off
-- hardcoded special case.

alter table public.brand_discounts
  add column brand_color text,
  add column brand_color_secondary text,
  add column brand_text_color text;

comment on column public.brand_discounts.brand_color is 'Primary badge background color (hex). Admin-editable, replaces the old hardcoded BRAND_COLORS object in app.js.';
comment on column public.brand_discounts.brand_color_secondary is 'Optional second color (hex). When set, the badge renders as a split/two-tone design instead of solid -- e.g. New World''s red/white split. NULL means solid single-color, the default for most brands.';
comment on column public.brand_discounts.brand_text_color is 'Optional text color override (hex) for brands where the default white text is unreadable against their brand color (e.g. Pak''nSave yellow needs black text). NULL falls back to white.';

update public.brand_discounts set brand_color = '#E4002B', brand_color_secondary = null, brand_text_color = null where brand = 'The Warehouse';
update public.brand_discounts set brand_color = '#1B7339', brand_color_secondary = null, brand_text_color = null where brand = 'Woolworths';
update public.brand_discounts set brand_color = '#E2231A', brand_color_secondary = '#FFFFFF', brand_text_color = null where brand = 'New World';
update public.brand_discounts set brand_color = '#E6007E', brand_color_secondary = null, brand_text_color = null where brand = 'Farmers';
update public.brand_discounts set brand_color = '#0033A0', brand_color_secondary = null, brand_text_color = null where brand = 'Noel Leeming';
update public.brand_discounts set brand_color = '#E31837', brand_color_secondary = null, brand_text_color = null where brand = 'Briscoes';
update public.brand_discounts set brand_color = '#1A1A1A', brand_color_secondary = null, brand_text_color = null where brand = 'Rebel Sport';
update public.brand_discounts set brand_color = '#FF6600', brand_color_secondary = null, brand_text_color = null where brand = 'PB Tech';
update public.brand_discounts set brand_color = '#FFD100', brand_color_secondary = null, brand_text_color = '#000000' where brand = 'Pak''nSave';
