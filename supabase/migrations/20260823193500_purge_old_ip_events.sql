-- Scheduled purge of raw IP data from account_ip_events, called by a new
-- n8n Cloud workflow (not built in this migration -- see the separate n8n
-- workflow "Giftlio IP Event Purge (API)").
--
-- This is an UPDATE, not a DELETE: only ip_address (raw) is cleared on rows
-- past the retention window. ip_address_hash, profile_id, event_type, and
-- created_at are preserved indefinitely -- deleting the row would destroy
-- the hash too, which the retention decision (linked-account-detection
-- capture task) requires to persist for correlation.
--
-- Retention window is config-driven (pricing_config), same pattern as
-- every other tunable window in this schema (dispute_claim_window_hours,
-- transaction_cap_window_days, etc.) -- never hardcoded here.

alter table public.pricing_config
  add column if not exists ip_event_raw_retention_days integer not null default 90
  check (ip_event_raw_retention_days > 0);

comment on column public.pricing_config.ip_event_raw_retention_days is 'How long account_ip_events.ip_address (the raw IP) is kept before purge_old_ip_events() clears it. ip_address_hash is never purged -- it persists indefinitely for linked-account correlation.';

create or replace function public.purge_old_ip_events()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_retention_days integer;
  v_rows_affected integer;
begin
  select ip_event_raw_retention_days into v_retention_days
  from public.pricing_config where id = 1;

  if v_retention_days is null then
    raise exception 'IP event retention configuration is missing. Contact support -- this is not something you can fix by retrying.';
  end if;

  update public.account_ip_events
  set ip_address = null
  where ip_address is not null
    and created_at < timezone('utc', now()) - (v_retention_days || ' days')::interval;

  get diagnostics v_rows_affected = row_count;
  return v_rows_affected;
end;
$function$;

comment on function public.purge_old_ip_events() is 'Clears (does not delete) ip_address on account_ip_events rows older than pricing_config.ip_event_raw_retention_days. Called daily by the n8n "Giftlio IP Event Purge (API)" workflow via the Supabase REST API RPC endpoint, same pattern as run_reconciliation(). Returns the number of rows purged.';

-- Same grant pattern as run_reconciliation() -- service_role only (the n8n
-- Supabase credential used for both workflows is configured with the
-- service role key).
revoke all on function public.purge_old_ip_events() from public, anon, authenticated;
grant execute on function public.purge_old_ip_events() to service_role;
