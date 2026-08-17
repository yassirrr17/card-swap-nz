-- Manual balance-check audit trail for submissions and listings. A seller's
-- claimed balance is never verified automatically anywhere else in this
-- app -- this table records what an admin actually read off the retailer's
-- own balance-check page by hand. No outbound HTTP happens from this
-- migration or the code that writes to it.
--
-- Deliberately shaped so an automated checker could write to this same
-- table later with no schema change: `source` distinguishes manual admin
-- entries from a future automated writer, and `status`/`error` let a
-- failed automated read get recorded honestly (never a guessed balance)
-- instead of forcing a migration to add them at that point. `checked_by`/
-- `checked_by_name` are nullable for exactly that reason -- an automated
-- check has no admin behind it. Every row written by the app today is
-- source='manual', status='completed', checked_by = the admin who typed
-- it in.

create table public.balance_checks (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid references public.submissions(id) on delete cascade,
  listing_id uuid references public.listings(id) on delete cascade,
  check (submission_id is not null or listing_id is not null),

  check_type text not null check (check_type in ('submission', 'pre_delivery', 'post_delivery')),
  claimed_balance numeric(10,2) not null,
  checked_balance numeric(10,2),
  notes text,

  source text not null default 'manual' check (source in ('manual', 'automated')),
  checked_by uuid references public.profiles(id),
  checked_by_name text,
  status text not null default 'completed' check (status in ('completed', 'failed')),
  error text,

  created_at timestamptz not null default now()
);

create index balance_checks_submission_id_idx on public.balance_checks (submission_id);
create index balance_checks_listing_id_idx on public.balance_checks (listing_id);
create index balance_checks_created_at_idx on public.balance_checks (created_at desc);

comment on table public.balance_checks is 'Append-only audit trail of balance checks against a seller''s claimed balance. Manual only today (source=''manual''); shaped to accept automated rows later without a schema change. Never auto-approves or auto-rejects anything -- admin-facing flag only.';

alter table public.balance_checks enable row level security;

create policy balance_checks_select_admin_only
  on public.balance_checks for select
  using (is_admin());

create policy balance_checks_insert_admin_only
  on public.balance_checks for insert
  with check (is_admin());
