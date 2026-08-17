-- Record-keeping only: this migration was already applied directly to
-- production (Supabase project kwcoziqzadeoooalwpjs) on 2026-08-16,
-- outside of any file in this repo -- it only existed as an untracked
-- row in supabase_migrations.schema_migrations, with no matching .sql
-- file anywhere in the repo. This file reconstructs it byte-for-byte
-- from the live schema (columns, constraints, indexes, RLS policies,
-- table comment) so the repo actually reflects what's running. Written
-- 2026-08-17 -- do NOT re-run this against the live database, the table
-- already exists exactly as described below.
--
-- Note found while reconstructing this: the table comment says it's
-- "Written only by the service role via api/verify-receipt.js" -- that
-- file has never existed in this repo's git history (checked `git log
-- --all`). The table has 0 rows. This looks like DB-level scaffolding
-- for an AI receipt-verification feature whose application code was
-- never actually written/committed -- flagged separately, not fixed
-- here.

create table public.receipt_checks (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  status text not null default 'pending' check (status = any (array['pending', 'ok', 'mismatch', 'unreadable', 'failed'])),
  detected_brand text,
  detected_balance numeric,
  detected_expiry date,
  confidence numeric check (confidence >= 0 and confidence <= 1),
  mismatch_reasons text[] not null default '{}',
  model text,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

comment on table public.receipt_checks is 'AI-extracted receipt data used as an admin-side second opinion on seller-entered card details. Never auto-approves. Written only by the service role via api/verify-receipt.js.';

create index receipt_checks_submission_id_idx on public.receipt_checks (submission_id);
create index receipt_checks_status_idx on public.receipt_checks (status);

alter table public.receipt_checks enable row level security;

create policy receipt_checks_select_admin_only
  on public.receipt_checks for select
  using (is_admin());

create policy receipt_checks_update_admin_only
  on public.receipt_checks for update
  using (is_admin());
