-- Enables Supabase Realtime on brand_discounts, so any already-open Sell
-- page or admin Brand Discounts table updates the instant an admin saves a
-- change -- no manual browser refresh and no re-navigation required.
alter publication supabase_realtime add table public.brand_discounts;
