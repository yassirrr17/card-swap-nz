-- Per-brand buyer discount percentage for Instant Sell listings (0-25%).
-- Marketplace mode is unaffected -- sellers set their own price there by
-- design. Public read (browse page needs it), admin-only write.

create table public.brand_discounts (
  brand text primary key,
  discount_percent numeric not null default 15 check (discount_percent >= 0 and discount_percent <= 25),
  updated_at timestamp with time zone not null default timezone('utc'::text, now())
);

comment on table public.brand_discounts is 'Per-brand buyer discount percentage for Instant Sell listings. Does not apply to Marketplace mode, where sellers set their own price.';

insert into public.brand_discounts (brand, discount_percent) values
  ('The Warehouse', 15),
  ('Woolworths', 15),
  ('New World', 15),
  ('Farmers', 15),
  ('Noel Leeming', 15),
  ('Briscoes', 15),
  ('Rebel Sport', 15),
  ('PB Tech', 15),
  ('Pak''nSave', 15);

alter table public.brand_discounts enable row level security;

create policy "Anyone can read brand discounts"
  on public.brand_discounts for select
  using (true);

create policy "Only admins can modify brand discounts"
  on public.brand_discounts for all
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
