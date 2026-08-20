-- BACKFILL: this migration was applied directly to the live database
-- (kwcoziqzadeoooalwpjs) on 2026-08-18 without ever being committed as a
-- file in this repo -- git history for that period shows only application
-- code changes and says nothing about the database. This file closes that
-- gap for the reconciliation_incidents table: it was generated FROM the
-- live schema (information_schema, pg_constraint, pg_indexes, pg_policies)
-- rather than replayed from memory, and running it against a project
-- already in this state is a no-op (IF NOT EXISTS / OR REPLACE throughout).
-- Do NOT re-apply -- this object is already live.

create table if not exists public.reconciliation_incidents (
  id uuid primary key default gen_random_uuid(),
  check_code text not null,
  severity text not null check (severity in ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  entity_type text not null,
  entity_id uuid,
  entity_key text not null,
  entity_label text,
  summary text not null,
  amount_at_risk numeric(10,2),
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved', 'auto_resolved')),
  first_seen_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  seen_count integer not null default 1,
  notified_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),
  resolution_note text
);

-- One open (or acknowledged) incident per check/entity -- repeat detections
-- of the same problem bump seen_count instead of creating duplicate rows.
create unique index if not exists uq_recon_open_incident
  on public.reconciliation_incidents (check_code, entity_key)
  where (status in ('open', 'acknowledged'));

create index if not exists idx_recon_status_severity
  on public.reconciliation_incidents (status, severity, last_seen_at desc);

alter table public.reconciliation_incidents enable row level security;

drop policy if exists recon_admin_select on public.reconciliation_incidents;
create policy recon_admin_select on public.reconciliation_incidents
  for select using (is_admin());

drop policy if exists recon_admin_update on public.reconciliation_incidents;
create policy recon_admin_update on public.reconciliation_incidents
  for update using (is_admin()) with check (is_admin());

-- No insert/delete policy -- rows are only ever written by
-- run_reconciliation(), a SECURITY DEFINER function (see the next
-- migration), not directly by admins or any client role.
