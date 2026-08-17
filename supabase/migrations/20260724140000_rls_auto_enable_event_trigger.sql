-- Record-keeping only: this event trigger was already live in production
-- (Supabase project kwcoziqzadeoooalwpjs) with no matching file anywhere
-- in this repo -- unlike every other drift case found in this repo, it
-- wasn't even a misplaced or malformed file, it simply had zero trace in
-- git history. Reconstructed 2026-08-17 from the live pg_proc/pg_event_trigger
-- definitions, verbatim. Do NOT re-run this against the live database, it
-- already exists exactly as described below.
--
-- Timestamped ahead of 20260724150000_init_cardswap_schema.sql rather than
-- alongside it: this function's OID (17478) is lower than every other
-- function in the public schema, including set_updated_at (17480), which
-- IS created by that init migration. That only happens if this event
-- trigger was installed before the init migration ran -- consistent with
-- its purpose, a safety net that auto-enables RLS on any table created in
-- public from that point on, including the very first ones.

create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
  cmd record;
begin
  for cmd in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table','partitioned table')
  loop
     if cmd.schema_name is not null and cmd.schema_name in ('public') and cmd.schema_name not in ('pg_catalog','information_schema') and cmd.schema_name not like 'pg_toast%' and cmd.schema_name not like 'pg_temp%' then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
        raise log 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      exception
        when others then
          raise log 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      end;
     else
        raise log 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     end if;
  end loop;
end;
$function$;

create event trigger ensure_rls
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();
