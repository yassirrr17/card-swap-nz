-- Counter-offer system for Marketplace listings (buyer proposes a price
-- within +/-25% of the listed price, seller accepts/rejects/counters).
create table public.listing_offers (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  buyer_id uuid not null references public.profiles(id),
  seller_id uuid not null references public.profiles(id),
  original_price numeric not null,
  offer_amount numeric not null,
  counter_amount numeric,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'countered', 'buyer_accepted_counter', 'expired', 'withdrawn')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint offer_within_range check (offer_amount >= original_price * 0.75 and offer_amount <= original_price * 1.25)
);
create index idx_listing_offers_listing on public.listing_offers(listing_id);
create index idx_listing_offers_seller on public.listing_offers(seller_id);
create index idx_listing_offers_status on public.listing_offers(status);

alter table public.listing_offers enable row level security;
create policy "Buyers can view and create their own offers" on public.listing_offers for select using (buyer_id = auth.uid() or seller_id = auth.uid());
create policy "Buyers can create offers" on public.listing_offers for insert with check (buyer_id = auth.uid());
create policy "Sellers can respond to their own offers" on public.listing_offers for update using (seller_id = auth.uid()) with check (seller_id = auth.uid());

-- Marketplace seller notification preference (Instant Sell sellers only
-- ever get 3 emails total, so this setting is irrelevant to them).
alter table public.profiles
  add column notification_preference text not null default 'every_event' check (notification_preference in ('every_event', 'daily_digest', 'payout_only'));
