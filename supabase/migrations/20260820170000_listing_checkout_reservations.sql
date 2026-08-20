-- Fixes a real double-sold-listing bug: api/create-checkout.js only ever
-- READ listing.status before creating a Stripe Checkout Session -- nothing
-- reserved the listing. Two concurrent buyers could both pass that read and
-- both get a valid Checkout session for the same card; whichever paid
-- second would be charged for a card that could never be delivered to them,
-- permanently stuck with no refund and no alert. The reconciliation system
-- (run_reconciliation(), added 2026-08-18) has DUPLICATE_SALE and
-- LISTING_STILL_ACTIVE_AFTER_SALE checks specifically watching for this --
-- this migration is the preventive fix; reconciliation stays as the safety
-- net behind it, not a replacement for it.
--
-- Approach: a new 'reserved' listing status, set atomically the moment a
-- buyer starts Stripe Checkout. A second concurrent buyer's reservation
-- attempt then fails cleanly (409, no Stripe session ever created) instead
-- of both buyers racing to the webhook.

-- ----------------------------------------------------------------------------
-- Config: reservation TTL, not hardcoded (matches this project's existing
-- pricing_config pattern). 30 minutes, not less -- Stripe Checkout Sessions
-- cannot expire in under 30 minutes (`expires_at` has a hard 30-minute
-- floor from creation), and this TTL is also used as that session's
-- expires_at so the lazy DB-side sweep and Stripe's own
-- checkout.session.expired webhook event stay consistent with each other.
-- ----------------------------------------------------------------------------

alter table public.pricing_config
  add column if not exists checkout_reservation_ttl_minutes integer not null default 30
  check (checkout_reservation_ttl_minutes >= 30);

comment on column public.pricing_config.checkout_reservation_ttl_minutes is
  'How long a listing stays reserved (unavailable to other buyers) once someone starts Stripe Checkout. Floor of 30 minutes -- Stripe Checkout Sessions cannot be given an expires_at sooner than 30 minutes from creation, and this value is also passed as that expires_at so the lazy DB sweep and the checkout.session.expired webhook stay in sync.';

-- ----------------------------------------------------------------------------
-- Schema: reserved status + who/when
-- ----------------------------------------------------------------------------

alter table public.listings
  add column if not exists reserved_at timestamptz,
  add column if not exists reserved_by uuid references public.profiles(id);

alter table public.listings drop constraint if exists listings_status_check;
alter table public.listings add constraint listings_status_check
  check (status in ('active', 'reserved', 'sold', 'inactive'));

create index if not exists idx_listings_reserved_at on public.listings(reserved_at) where status = 'reserved';

-- The reserving buyer must be able to see their own reservation (e.g. if
-- they reload the listing page mid-checkout) -- previously only the seller
-- and admins could see a non-active listing.
drop policy if exists "listings_select_active_or_owner_or_admin" on public.listings;
create policy "listings_select_active_or_owner_or_admin"
on public.listings
for select
using (
  (
    status = 'active'
    and not suspended
    and not public.is_seller_suspended(seller_id)
  )
  or seller_id = auth.uid()
  or reserved_by = auth.uid()
  or public.is_admin()
);

-- ----------------------------------------------------------------------------
-- reserve_listing_for_checkout(): the actual race fix. A single atomic
-- UPDATE ... WHERE status = 'active' -- Postgres guarantees only one
-- concurrent caller can win this row lock. Returns true iff THIS call
-- reserved it. Called by api/create-checkout.js via the service-role
-- client, immediately before creating the Stripe session -- never before
-- (nothing upstream of this should treat a listing as available).
-- ----------------------------------------------------------------------------

create or replace function public.reserve_listing_for_checkout(p_listing_id uuid, p_buyer_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows int;
begin
  update public.listings
  set status = 'reserved',
      reserved_at = timezone('utc', now()),
      reserved_by = p_buyer_id,
      updated_at = timezone('utc', now())
  where id = p_listing_id
    and status = 'active';

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$function$;

revoke execute on function public.reserve_listing_for_checkout(uuid, uuid) from anon, authenticated;
grant execute on function public.reserve_listing_for_checkout(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- release_stale_reservations(): lazy sweep. There is no cron/scheduled-job
-- infrastructure in this project, so this is called opportunistically at
-- the top of api/create-checkout.js on every new checkout attempt (cheap,
-- self-healing) -- and, faster, from the checkout.session.expired webhook
-- handler for the specific listing that just expired. Never touches a
-- listing that has since become 'sold'.
-- ----------------------------------------------------------------------------

create or replace function public.release_stale_reservations()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ttl_minutes integer;
  v_rows int;
begin
  select checkout_reservation_ttl_minutes into v_ttl_minutes from public.pricing_config where id = 1;
  if v_ttl_minutes is null then
    v_ttl_minutes := 30;
  end if;

  update public.listings
  set status = 'active',
      reserved_at = null,
      reserved_by = null,
      updated_at = timezone('utc', now())
  where status = 'reserved'
    and reserved_at < timezone('utc', now()) - (v_ttl_minutes || ' minutes')::interval;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

revoke execute on function public.release_stale_reservations() from anon, authenticated;
grant execute on function public.release_stale_reservations() to service_role;
