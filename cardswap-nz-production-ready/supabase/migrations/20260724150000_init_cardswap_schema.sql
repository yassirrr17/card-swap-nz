create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null unique,
  role text not null default 'buyer' check (role in ('buyer', 'seller', 'admin')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique,
  seller_id uuid not null references public.profiles(id) on delete cascade,
  seller_name text not null,
  brand text not null,
  face_value numeric(10,2) not null check (face_value > 0),
  current_balance numeric(10,2) not null check (current_balance >= 0 and current_balance <= face_value),
  expiry_date date not null,
  card_number text not null,
  pin text,
  receipt_filename text,
  offer_amount numeric(10,2) not null check (offer_amount >= 0),
  status text not null default 'pending_review' check (status in ('pending_review', 'approved', 'rejected', 'listed', 'sold')),
  admin_notes text,
  approved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.card_vault (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references public.submissions(id) on delete cascade,
  seller_id uuid not null references public.profiles(id) on delete cascade,
  brand text not null,
  card_number text not null,
  pin text,
  current_balance numeric(10,2) not null check (current_balance >= 0),
  expiry_date date not null,
  is_redeemed boolean not null default false,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique,
  submission_id uuid references public.submissions(id) on delete set null,
  card_vault_id uuid unique references public.card_vault(id) on delete set null,
  seller_id uuid not null references public.profiles(id) on delete cascade,
  seller_name text not null,
  seller_since text,
  cards_sold integer not null default 0 check (cards_sold >= 0),
  brand text not null,
  face_value numeric(10,2) not null check (face_value > 0),
  sale_price numeric(10,2) not null check (sale_price > 0 and sale_price <= face_value),
  discount integer not null check (discount between 0 and 100),
  status text not null default 'active' check (status in ('active', 'sold', 'inactive')),
  expiry_date date not null,
  sold_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique,
  listing_id uuid not null references public.listings(id) on delete restrict,
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  buyer_name text not null,
  buyer_email text not null,
  buyer_phone text,
  brand text not null,
  face_value numeric(10,2) not null check (face_value > 0),
  sale_price numeric(10,2) not null check (sale_price > 0),
  service_fee numeric(10,2) not null check (service_fee >= 0),
  total numeric(10,2) not null check (total >= 0),
  status text not null default 'pending_verification' check (status in ('pending_verification', 'delivered', 'refunded')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_profiles_role on public.profiles(role);
create index if not exists idx_submissions_seller_created on public.submissions(seller_id, created_at desc);
create index if not exists idx_submissions_status_created on public.submissions(status, created_at desc);
create index if not exists idx_listings_status_created on public.listings(status, created_at desc);
create index if not exists idx_listings_seller_created on public.listings(seller_id, created_at desc);
create index if not exists idx_orders_buyer_created on public.orders(buyer_id, created_at desc);
create index if not exists idx_orders_listing on public.orders(listing_id);
create index if not exists idx_card_vault_seller on public.card_vault(seller_id);

create trigger set_profiles_updated_at
before update on public.profiles
for each row
execute procedure public.set_updated_at();

create trigger set_submissions_updated_at
before update on public.submissions
for each row
execute procedure public.set_updated_at();

create trigger set_listings_updated_at
before update on public.listings
for each row
execute procedure public.set_updated_at();

create trigger set_orders_updated_at
before update on public.orders
for each row
execute procedure public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    'buyer'
  )
  on conflict (id) do update
    set name = excluded.name,
        email = excluded.email,
        updated_at = timezone('utc', now());

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute procedure public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

alter table public.profiles enable row level security;
alter table public.submissions enable row level security;
alter table public.card_vault enable row level security;
alter table public.listings enable row level security;
alter table public.orders enable row level security;

drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin"
on public.profiles
for select
using (auth.uid() = id or public.is_admin());

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles
for insert
with check (auth.uid() = id or public.is_admin());

drop policy if exists "profiles_update_own_or_admin" on public.profiles;
create policy "profiles_update_own_or_admin"
on public.profiles
for update
using (auth.uid() = id or public.is_admin())
with check (auth.uid() = id or public.is_admin());

drop policy if exists "submissions_select_seller_or_admin" on public.submissions;
create policy "submissions_select_seller_or_admin"
on public.submissions
for select
using (seller_id = auth.uid() or public.is_admin());

drop policy if exists "submissions_insert_seller" on public.submissions;
create policy "submissions_insert_seller"
on public.submissions
for insert
with check (seller_id = auth.uid() or public.is_admin());

drop policy if exists "submissions_update_seller_or_admin" on public.submissions;
create policy "submissions_update_seller_or_admin"
on public.submissions
for update
using (seller_id = auth.uid() or public.is_admin())
with check (seller_id = auth.uid() or public.is_admin());

drop policy if exists "listings_select_active_or_owner_or_admin" on public.listings;
create policy "listings_select_active_or_owner_or_admin"
on public.listings
for select
using (status = 'active' or seller_id = auth.uid() or public.is_admin());

drop policy if exists "listings_admin_insert" on public.listings;
create policy "listings_admin_insert"
on public.listings
for insert
with check (public.is_admin());

drop policy if exists "listings_admin_update" on public.listings;
create policy "listings_admin_update"
on public.listings
for update
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "card_vault_admin_full" on public.card_vault;
create policy "card_vault_admin_full"
on public.card_vault
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "orders_select_buyer_or_admin" on public.orders;
create policy "orders_select_buyer_or_admin"
on public.orders
for select
using (buyer_id = auth.uid() or public.is_admin());

drop policy if exists "orders_insert_buyer_or_admin" on public.orders;
create policy "orders_insert_buyer_or_admin"
on public.orders
for insert
with check (buyer_id = auth.uid() or public.is_admin());

drop policy if exists "orders_update_admin" on public.orders;
create policy "orders_update_admin"
on public.orders
for update
using (public.is_admin())
with check (public.is_admin());
