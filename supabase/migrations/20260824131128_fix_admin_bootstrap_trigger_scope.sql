-- prevent_self_privilege_escalation() (20260803010000_fix_privilege_escalation.sql)
-- exists to stop an ordinary logged-in user from calling the Supabase REST
-- API directly and setting role='admin' (or unsuspending/verifying/etc.)
-- on their own row. It does this by checking is_admin(), which resolves
-- auth.uid() against public.profiles.
--
-- That check can't distinguish "a real end user trying to self-escalate"
-- from "no JWT session exists at all" -- both see auth.uid() as null. So
-- it has been silently blocking every direct-SQL role change too,
-- including DEPLOYMENT.md's documented first-admin bootstrap step
-- (`update public.profiles set role = 'admin' where email = '...'` run
-- in the SQL editor): the UPDATE appears to succeed but role is silently
-- reverted to its old value, with no error. On a fresh project with zero
-- admins, there is no session that could ever satisfy is_admin(), so this
-- makes the documented bootstrap procedure permanently a no-op.
--
-- The fix: scope the guard to what it actually needs to guard against --
-- PostgREST requests running as the ordinary `authenticated` role (the
-- one path an end user's own JWT-scoped session can reach). Supabase's
-- pooler does `set local role <authenticated|anon|service_role>` per
-- request, so current_setting('role', true) reliably reflects this.
-- service_role (api/* functions using the service role key) and direct
-- database connections (the SQL editor, migrations, `postgres` /
-- `supabase_admin`) are already fully-trusted operator access -- equivalent
-- to root on this database -- and were never meant to be blocked here.
create or replace function public.prevent_self_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if current_setting('role', true) is distinct from 'authenticated' then
    return new;
  end if;

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
