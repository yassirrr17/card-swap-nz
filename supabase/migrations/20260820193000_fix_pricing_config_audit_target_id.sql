-- Bugfix, found while testing Task A: audit_pricing_config_changes()
-- (20260820183906_db_enforced_audit_logging.sql) calls
-- write_audit_log_entry(p_action_type, p_target_type, p_target_id uuid, ...)
-- with new.id -- but pricing_config.id is smallint (the singleton row is
-- always id=1), not uuid, and Postgres won't implicitly cast smallint to
-- uuid. Every single UPDATE on pricing_config has been failing outright
-- since that migration landed:
--   ERROR: function public.write_audit_log_entry(unknown, unknown,
--   smallint, unknown, jsonb) does not exist
-- This is not something introduced by Task A -- it predates it -- but it
-- directly blocks Task A/C's whole point (admin-tunable config: dispute
-- window, payout hold buffer, chargeback review threshold all live in
-- this same singleton row), so it's fixed here rather than filed away for
-- later. Same fix already used one function down in the same migration
-- for brand_discounts (also not uuid-keyed): pass null for target_id,
-- since target_type='pricing_config' already identifies which row (there
-- is only ever one).

create or replace function public.audit_pricing_config_changes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.write_audit_log_entry(
    'db_pricing_config_change', 'pricing_config', null, null,
    jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new))
  );
  return new;
end;
$function$;

revoke execute on function public.audit_pricing_config_changes() from anon, authenticated;
