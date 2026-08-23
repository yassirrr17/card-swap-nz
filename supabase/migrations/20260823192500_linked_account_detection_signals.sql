-- Capture-only: adds the columns/tables needed for linked-account detection
-- to be buildable later (verified phone, payout bank account identifier,
-- signup/session IP). NO matching/detection logic here -- just where each
-- signal lives and how it gets written.
--
-- Confirmed via live schema audit: none of these three signals exist today.
-- orders.buyer_phone is a per-order contact field typed at checkout, not a
-- verified identity attribute -- unrelated to this.

-- ----------------------------------------------------------------------------
-- Phone: profiles columns, same shape as email/name -- a low-cardinality,
-- rarely-changing identity attribute belongs with the identity row, not a
-- separate table. profiles' existing RLS (profiles_select_own_or_admin /
-- profiles_update_own_or_admin) already covers these new columns -- no new
-- policy needed, row-level security applies to the whole row.
--
-- phone_number is left self-editable (a user can submit their own number to
-- be verified), but phone_verified_at is added to
-- prevent_self_privilege_escalation()'s protected-column list, same as
-- verification_status -- otherwise anyone could self-mark their own number
-- "verified" with no actual verification, which would make this signal
-- worthless for detection.
-- ----------------------------------------------------------------------------

alter table public.profiles
  add column if not exists phone_number text,
  add column if not exists phone_verified_at timestamptz;

comment on column public.profiles.phone_number is 'Seller/buyer-submitted phone number, not yet verified until phone_verified_at is set. Self-editable -- the number itself is not the trust signal, phone_verified_at is.';
comment on column public.profiles.phone_verified_at is 'Set only by an admin/system verification step (never self-service -- see prevent_self_privilege_escalation()). Capture point: a future phone verification feature, not built in this migration.';

create or replace function public.prevent_self_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if is_admin() then
    return new;
  end if;

  new.role := old.role;
  new.verification_status := old.verification_status;
  new.suspended := old.suspended;
  new.suspended_reason := old.suspended_reason;
  new.suspended_at := old.suspended_at;
  new.email := old.email;
  new.phone_verified_at := old.phone_verified_at;

  return new;
end;
$function$;

-- ----------------------------------------------------------------------------
-- IP: its own append-only event table, not a profiles column -- a mutable
-- "last IP" field would only ever hold the most recent value, useless for
-- correlating IP overlap across accounts later. Both signup and every
-- login are captured here, tagged by event_type.
--
-- ip_address (raw) is meant to be retention-limited (recommended: 90 days,
-- purged after -- no cron infrastructure exists in this project today, so
-- that purge is a manual/future-scheduled DELETE, not built here).
-- ip_address_hash is a KEYED hash (HMAC-SHA256 with a server-side pepper
-- held only in an env var, computed in api/record-session-ip.js -- never
-- in this database) intended to persist longer for the actual
-- linked-account-detection purpose. A bare/unkeyed hash of an IP address
-- is trivially reversible (only ~4 billion IPv4 values), so this
-- deliberately is NOT a plain digest() the way card_number_hash elsewhere
-- in this schema is.
-- ----------------------------------------------------------------------------

create table public.account_ip_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  ip_address inet,
  ip_address_hash text not null,
  event_type text not null check (event_type in ('signup', 'login')),
  created_at timestamptz not null default timezone('utc', now())
);

comment on table public.account_ip_events is 'Capture-only signal for future linked-account detection -- no matching logic here. ip_address is raw and intended for short (~90 day) retention; ip_address_hash is a keyed HMAC (pepper held in an env var, never in this DB) intended to persist longer for correlation. Written only by api/record-session-ip.js via the service role.';

create index idx_account_ip_events_profile on public.account_ip_events (profile_id, created_at);

alter table public.account_ip_events enable row level security;

create policy account_ip_events_select_own_or_admin
  on public.account_ip_events for select
  using (profile_id = auth.uid() or is_admin());

-- No insert/update/delete policy for anon/authenticated -- writes only via
-- the service-role endpoint, same as every other service-role-only table
-- in this schema (orders, email_queue, etc.).

-- ----------------------------------------------------------------------------
-- Bank account: a dedicated table, not a profiles column -- keeps a highly
-- sensitive, narrowly-scoped signal isolated from the frequently-read
-- profiles row, and preserves history if a seller's payout account changes
-- (useful for detection later; a single mutable column would lose that).
--
-- Deliberately NO raw/reversible account number is stored, only the last 4
-- digits (for a seller to recognize their own account, e.g. "ending in
-- 1234") plus a keyed HMAC hash for exact-match correlation later. This
-- table serves ONLY the linked-account-detection signal -- it does not
-- give Giftlio the ability to actually pay a seller via stored bank
-- details (that would be reversible storage, a materially bigger decision
-- deliberately not made here).
--
-- Capture point: a future "set up payout details" seller-facing step,
-- which does not exist yet -- no capture endpoint is built in this
-- migration, matching how verification_status was left for its own future
-- feature. This table has no writer yet; it exists so that future feature
-- can write directly into it without another schema change.
-- ----------------------------------------------------------------------------

create table public.seller_payout_accounts (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles(id),
  bank_account_last4 text,
  bank_account_identifier_hash text not null,
  captured_at timestamptz not null default timezone('utc', now())
);

comment on table public.seller_payout_accounts is 'Capture-only signal for future linked-account detection -- no matching logic here, and no reversible account number is stored (last4 + a keyed HMAC hash only). Not yet written to by any code -- the seller-facing payout-setup step this depends on has not been built.';

create index idx_seller_payout_accounts_seller on public.seller_payout_accounts (seller_id);

alter table public.seller_payout_accounts enable row level security;

create policy seller_payout_accounts_select_own_or_admin
  on public.seller_payout_accounts for select
  using (seller_id = auth.uid() or is_admin());
