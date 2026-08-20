-- Task 4: admin_audit_log is written entirely by the BROWSER, after an
-- admin action completes -- logAdminAction() in app.js is a plain INSERT
-- that, by its own comment, "never blocks the action itself if logging
-- fails." No DB trigger writes to this table automatically. A direct API
-- call bypassing app.js, or a client-side insert that silently fails,
-- leaves ZERO forensic trail -- including the single highest-risk
-- operation in this system, decrypting a card. This migration makes the
-- database itself the guaranteed floor under that client-side logging,
-- not a replacement for it (the client-side calls stay -- they carry
-- richer context, like which submission an approval belongs to).

-- ----------------------------------------------------------------------------
-- Shared writer. admin_id/admin_name come from the ACTING SESSION, not any
-- client-supplied value -- auth.uid() is null for the service-role webhook
-- paths (api/webhook.js, api/deliver-order.js), which is itself useful
-- signal: these rows show up as admin_name='system', distinguishing an
-- automated state change from a human admin click.
-- ----------------------------------------------------------------------------

create or replace function public.write_audit_log_entry(
  p_action_type text,
  p_target_type text,
  p_target_id uuid,
  p_brand text,
  p_details jsonb
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin_name text;
begin
  select name into v_admin_name from public.profiles where id = auth.uid();

  insert into public.admin_audit_log (admin_id, admin_name, action_type, target_type, target_id, brand, details)
  values (auth.uid(), coalesce(v_admin_name, 'system'), p_action_type, p_target_type, p_target_id, p_brand, p_details);
end;
$function$;

revoke execute on function public.write_audit_log_entry(text, text, uuid, text, jsonb) from anon, authenticated;

-- ----------------------------------------------------------------------------
-- orders: status transitions and payout state (seller_paid/payout_status)
-- -- covers deliveries, refunds, and every payout release/freeze, whether
-- triggered by an admin click or a Stripe webhook.
-- ----------------------------------------------------------------------------

create or replace function public.audit_orders_changes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if old.status is distinct from new.status
     or old.seller_paid is distinct from new.seller_paid
     or old.payout_status is distinct from new.payout_status then
    perform public.write_audit_log_entry(
      'db_order_state_change', 'order', new.id, new.brand,
      jsonb_build_object(
        'old_status', old.status, 'new_status', new.status,
        'old_seller_paid', old.seller_paid, 'new_seller_paid', new.seller_paid,
        'old_payout_status', old.payout_status, 'new_payout_status', new.payout_status,
        'payout_frozen_reason', new.payout_frozen_reason
      )
    );
  end if;
  return new;
end;
$function$;

revoke execute on function public.audit_orders_changes() from anon, authenticated;

drop trigger if exists trg_audit_orders_changes on public.orders;
create trigger trg_audit_orders_changes
after update on public.orders
for each row execute function public.audit_orders_changes();

-- ----------------------------------------------------------------------------
-- submissions: approval/rejection and Instant Sell payout
-- ----------------------------------------------------------------------------

create or replace function public.audit_submissions_changes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if old.status is distinct from new.status or old.paid_at is distinct from new.paid_at then
    perform public.write_audit_log_entry(
      'db_submission_state_change', 'submission', new.id, new.brand,
      jsonb_build_object('old_status', old.status, 'new_status', new.status, 'paid_at', new.paid_at, 'rejection_reason', new.rejection_reason)
    );
  end if;
  return new;
end;
$function$;

revoke execute on function public.audit_submissions_changes() from anon, authenticated;

drop trigger if exists trg_audit_submissions_changes on public.submissions;
create trigger trg_audit_submissions_changes
after update on public.submissions
for each row execute function public.audit_submissions_changes();

-- ----------------------------------------------------------------------------
-- profiles: role/suspension/verification -- the exact columns
-- prevent_self_privilege_escalation() already protects. Logging here closes
-- the remaining gap: that trigger stops an unauthorized change, but nothing
-- previously recorded an AUTHORIZED one either.
-- ----------------------------------------------------------------------------

create or replace function public.audit_profiles_changes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if old.role is distinct from new.role
     or old.suspended is distinct from new.suspended
     or old.verification_status is distinct from new.verification_status then
    perform public.write_audit_log_entry(
      'db_profile_state_change', 'profile', new.id, null,
      jsonb_build_object(
        'old_role', old.role, 'new_role', new.role,
        'old_suspended', old.suspended, 'new_suspended', new.suspended, 'suspended_reason', new.suspended_reason,
        'old_verification_status', old.verification_status, 'new_verification_status', new.verification_status
      )
    );
  end if;
  return new;
end;
$function$;

revoke execute on function public.audit_profiles_changes() from anon, authenticated;

drop trigger if exists trg_audit_profiles_changes on public.profiles;
create trigger trg_audit_profiles_changes
after update on public.profiles
for each row execute function public.audit_profiles_changes();

-- ----------------------------------------------------------------------------
-- listings: suspension
-- ----------------------------------------------------------------------------

create or replace function public.audit_listings_changes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if old.suspended is distinct from new.suspended then
    perform public.write_audit_log_entry(
      'db_listing_state_change', 'listing', new.id, new.brand,
      jsonb_build_object('old_suspended', old.suspended, 'new_suspended', new.suspended, 'suspended_reason', new.suspended_reason)
    );
  end if;
  return new;
end;
$function$;

revoke execute on function public.audit_listings_changes() from anon, authenticated;

drop trigger if exists trg_audit_listings_changes on public.listings;
create trigger trg_audit_listings_changes
after update on public.listings
for each row execute function public.audit_listings_changes();

-- ----------------------------------------------------------------------------
-- pricing_config: a singleton row, so any change to it changes the
-- economics of every future submission/checkout -- logged in full, not
-- diffed field by field.
-- ----------------------------------------------------------------------------

create or replace function public.audit_pricing_config_changes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.write_audit_log_entry(
    'db_pricing_config_change', 'pricing_config', new.id, null,
    jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new))
  );
  return new;
end;
$function$;

revoke execute on function public.audit_pricing_config_changes() from anon, authenticated;

drop trigger if exists trg_audit_pricing_config_changes on public.pricing_config;
create trigger trg_audit_pricing_config_changes
after update on public.pricing_config
for each row execute function public.audit_pricing_config_changes();

-- ----------------------------------------------------------------------------
-- brand_discounts: retailer_enabled (the kill switch) and discount_percent
-- are the two fields with direct financial/availability impact.
-- ----------------------------------------------------------------------------

create or replace function public.audit_brand_discounts_changes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if old.retailer_enabled is distinct from new.retailer_enabled or old.discount_percent is distinct from new.discount_percent then
    perform public.write_audit_log_entry(
      'db_brand_discount_change', 'brand_discount', null, new.brand,
      jsonb_build_object(
        'old_retailer_enabled', old.retailer_enabled, 'new_retailer_enabled', new.retailer_enabled,
        'old_discount_percent', old.discount_percent, 'new_discount_percent', new.discount_percent
      )
    );
  end if;
  return new;
end;
$function$;

revoke execute on function public.audit_brand_discounts_changes() from anon, authenticated;

drop trigger if exists trg_audit_brand_discounts_changes on public.brand_discounts;
create trigger trg_audit_brand_discounts_changes
after update on public.brand_discounts
for each row execute function public.audit_brand_discounts_changes();

-- ----------------------------------------------------------------------------
-- decrypt_card_value(): the single highest-risk read in this system, and
-- previously the one with NO dedicated audit trail at all -- only the
-- surrounding approve_submission client-side log entry existed. Never logs
-- the ciphertext or the decrypted value itself -- only a SHA-256 hash of
-- the ciphertext (lets separate calls for the SAME card be correlated
-- without storing anything sensitive) plus a best-effort lookup of which
-- submission/card_vault row that ciphertext actually belongs to.
-- ----------------------------------------------------------------------------

create or replace function public.decrypt_card_value(ciphertext_base64 text)
returns text as $$
declare
  v_ciphertext_hash text;
  v_target_type text;
  v_target_id uuid;
begin
  if ciphertext_base64 is null then return null; end if;
  if not (is_admin() or auth.uid() is null) then
    raise exception 'Not authorized to decrypt card data';
  end if;

  v_ciphertext_hash := encode(digest(ciphertext_base64, 'sha256'), 'hex');

  select id, 'submission' into v_target_id, v_target_type
    from public.submissions where card_number = ciphertext_base64 or pin = ciphertext_base64
    limit 1;
  if v_target_id is null then
    select id, 'card_vault' into v_target_id, v_target_type
      from public.card_vault where card_number = ciphertext_base64 or pin = ciphertext_base64
      limit 1;
  end if;

  perform public.write_audit_log_entry(
    'card_credential_decrypted', coalesce(v_target_type, 'unknown'), v_target_id, null,
    jsonb_build_object('ciphertext_sha256', v_ciphertext_hash)
  );

  return pgp_sym_decrypt(decode(ciphertext_base64, 'base64'), public.get_card_encryption_key());
end;
$$ language plpgsql security definer set search_path = public, extensions;

revoke execute on function public.decrypt_card_value(text) from anon;
revoke execute on function public.decrypt_card_value(text) from authenticated;
grant execute on function public.decrypt_card_value(text) to authenticated;
grant execute on function public.decrypt_card_value(text) to service_role;

-- ----------------------------------------------------------------------------
-- admin_audit_log: append-only. There was already no UPDATE/DELETE RLS
-- policy for anon/authenticated (only "select"/"insert" exist), which
-- already denies those to ordinary roles by omission -- but service_role
-- bypasses RLS entirely, so nothing previously stopped a service-role
-- code path (or a compromised service key) from editing or deleting audit
-- history. This trigger closes that regardless of role, including
-- service_role and table owners.
-- ----------------------------------------------------------------------------

create or replace function public.prevent_audit_log_tampering()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  raise exception 'admin_audit_log is append-only -- % is not permitted.', tg_op;
end;
$function$;

revoke execute on function public.prevent_audit_log_tampering() from anon, authenticated;

drop trigger if exists trg_prevent_audit_log_tampering on public.admin_audit_log;
create trigger trg_prevent_audit_log_tampering
before update or delete on public.admin_audit_log
for each row execute function public.prevent_audit_log_tampering();
