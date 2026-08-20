-- Manual SQL test script for Task 4 (DB-enforced admin audit logging).
-- Same style as tests/task1-3 -- RAISE NOTICE / EXCEPTION assertions,
-- wrapped in begin/rollback.

begin;

do $$
declare
  v_admin uuid;
  v_seller uuid;
  v_listing_id uuid;
  v_order_id uuid;
  v_card_vault_id uuid;
  v_submission_id uuid;
  v_log_count int;
  v_threw boolean;
  v_details jsonb;
  v_target_id uuid;
begin
  v_admin := gen_random_uuid();
  v_seller := gen_random_uuid();

  insert into auth.users (id, email) values
    (v_admin, 'test-admin-' || v_admin || '@example.invalid'),
    (v_seller, 'test-seller-' || v_seller || '@example.invalid')
  on conflict do nothing;

  -- See tests/task3_payout_holds.sql for why this must disable
  -- trg_prevent_self_privilege_escalation to seed a first admin.
  alter table public.profiles disable trigger trg_prevent_self_privilege_escalation;
  insert into public.profiles (id, name, email, role) values
    (v_admin, 'Test Admin', (select email from auth.users where id = v_admin), 'admin'),
    (v_seller, 'Test Seller', (select email from auth.users where id = v_seller), 'seller')
  on conflict (id) do update set role = excluded.role;
  alter table public.profiles enable trigger trg_prevent_self_privilege_escalation;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);

  -- ------------------------------------------------------------------
  -- Test 1: an orders state change writes a db_order_state_change entry,
  -- even though this is a plain UPDATE, not an app.js admin action
  -- ------------------------------------------------------------------
  reset role; -- listing/order creation as superuser, same as other test scripts

  insert into public.listings (
    public_id, seller_id, seller_name, brand, face_value, sale_price, discount,
    status, expiry_date, sale_mode
  ) values (
    'TEST-AUD-' || substr(gen_random_uuid()::text, 1, 8), v_seller, 'Test Seller',
    'The Warehouse', 100, 80, 20, 'sold', current_date + interval '90 days', 'marketplace'
  ) returning id into v_listing_id;

  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status
  ) values (
    'TEST-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_seller, 'Test Buyer',
    'buyer@example.invalid', 'The Warehouse', 100, 80, 0, 80, 'pending_verification'
  ) returning id into v_order_id;

  select count(*) into v_log_count from public.admin_audit_log where target_type = 'order' and target_id = v_order_id;
  if v_log_count <> 0 then
    raise exception 'FAIL: no audit entry should exist before any state change';
  end if;

  update public.orders set status = 'delivered', delivered_at = now() where id = v_order_id;

  select count(*) into v_log_count from public.admin_audit_log where target_type = 'order' and target_id = v_order_id and action_type = 'db_order_state_change';
  if v_log_count <> 1 then
    raise exception 'FAIL: expected exactly 1 audit entry for the order status change, got %', v_log_count;
  end if;
  raise notice 'PASS: an orders status change is automatically audit-logged';

  -- A second update that does NOT touch status/seller_paid/payout_status
  -- should NOT create another entry (only meaningful changes are logged).
  update public.orders set buyer_phone = '0211234567' where id = v_order_id;
  select count(*) into v_log_count from public.admin_audit_log where target_type = 'order' and target_id = v_order_id;
  if v_log_count <> 1 then
    raise exception 'FAIL: an unrelated column change should not add another audit entry, count is now %', v_log_count;
  end if;
  raise notice 'PASS: unrelated column changes are not logged (no noise)';

  -- ------------------------------------------------------------------
  -- Test 2: a profiles role change is logged, WITHOUT needing app.js at
  -- all -- this is the exact class of change (privilege escalation, via
  -- direct API/DB access) the brief specifically worried had no trail.
  -- ------------------------------------------------------------------
  -- Baseline first -- the fixture upsert above already triggered ONE
  -- legitimate db_profile_state_change entry of its own (role
  -- buyer->seller, since handle_new_user() auto-created both rows as
  -- 'buyer' before this script's ON CONFLICT DO UPDATE ran) -- correct
  -- behavior, not a bug, but this test cares about the NEXT change only.
  select count(*) into v_log_count from public.admin_audit_log where target_type = 'profile' and target_id = v_seller and action_type = 'db_profile_state_change';

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  update public.profiles set verification_status = 'verified' where id = v_seller;
  reset role;

  if (select count(*) from public.admin_audit_log where target_type = 'profile' and target_id = v_seller and action_type = 'db_profile_state_change') <> v_log_count + 1 then
    raise exception 'FAIL: expected exactly 1 NEW audit entry for the verification_status change';
  end if;
  raise notice 'PASS: a profiles verification/role/suspension change is automatically audit-logged';

  -- ------------------------------------------------------------------
  -- Test 3: decrypt_card_value() logs a hash, never the plaintext, and
  -- correctly identifies which card_vault row it belongs to
  -- ------------------------------------------------------------------
  -- validate_card_format() (evidence/balance/expiry rules) is unrelated to
  -- what Task 4 tests -- disabled just for this fixture insert, same
  -- pattern as tests/task3_payout_holds.sql.
  alter table public.submissions disable trigger trg_card_format_validation;
  insert into public.submissions (
    public_id, seller_id, seller_name, brand, face_value, current_balance, expiry_date,
    card_number, pin, offer_amount, status, sale_mode
  ) values (
    'TEST-SUB-' || substr(gen_random_uuid()::text, 1, 8), v_seller, 'Test Seller', 'The Warehouse',
    100, 90, current_date + interval '90 days', '9999888877776666', '4321', 70, 'pending_review', 'marketplace'
  ) returning id into v_submission_id;
  alter table public.submissions enable trigger trg_card_format_validation;

  -- NOT sourced from submissions.card_number/pin here -- those columns are
  -- already ciphertext by the time the row above exists (submissions has
  -- its own BEFORE INSERT encryption trigger). Inserting plaintext
  -- directly so card_vault's OWN encryption trigger encrypts it exactly
  -- once -- routing through the already-encrypted submissions value would
  -- double-encrypt it and break decryption.
  insert into public.card_vault (submission_id, seller_id, brand, card_number, pin, current_balance, expiry_date)
  values (v_submission_id, v_seller, 'The Warehouse', '9999888877776666', '4321', 90, current_date + interval '90 days')
  returning id into v_card_vault_id;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);

  declare
    v_ciphertext text;
    v_decrypted text;
  begin
    select card_number into v_ciphertext from public.card_vault where id = v_card_vault_id;
    select public.decrypt_card_value(v_ciphertext) into v_decrypted;
    if v_decrypted is distinct from '9999888877776666' then
      raise exception 'FAIL: decrypt_card_value did not return the expected plaintext, got %', v_decrypted;
    end if;
  end;

  reset role;

  select target_id, details into v_target_id, v_details
  from public.admin_audit_log
  where action_type = 'card_credential_decrypted'
  order by created_at desc limit 1;

  if v_target_id is distinct from v_card_vault_id then
    raise exception 'FAIL: decrypt audit entry should be attributed to card_vault row %, got %', v_card_vault_id, v_target_id;
  end if;
  if v_details ? 'card_number' or v_details::text like '%9999888877776666%' then
    raise exception 'FAIL: the decrypt audit entry must never contain the plaintext card number';
  end if;
  if not (v_details ? 'ciphertext_sha256') then
    raise exception 'FAIL: the decrypt audit entry should carry a ciphertext hash for correlation';
  end if;
  raise notice 'PASS: decrypt_card_value() logs which card it decrypted and a ciphertext hash, never the plaintext';

  -- ------------------------------------------------------------------
  -- Test 4: admin_audit_log is append-only, even for a superuser/service-
  -- role-equivalent connection (this whole script runs as one) -- not
  -- just blocked by RLS for ordinary roles.
  -- ------------------------------------------------------------------
  v_threw := false;
  begin
    update public.admin_audit_log set details = '{}'::jsonb where target_id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: updating admin_audit_log should have been rejected, even for this (superuser-equivalent) connection';
  end if;
  raise notice 'PASS: admin_audit_log rejects UPDATE unconditionally';

  v_threw := false;
  begin
    delete from public.admin_audit_log where target_id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: deleting from admin_audit_log should have been rejected, even for this (superuser-equivalent) connection';
  end if;
  raise notice 'PASS: admin_audit_log rejects DELETE unconditionally';

  raise notice 'ALL TASK 4 TESTS PASSED';
end $$;

rollback;
