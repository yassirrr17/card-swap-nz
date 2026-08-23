-- Manual SQL test script for the linked-account-detection capture signals
-- (phone_verified_at protection, account_ip_events / seller_payout_accounts
-- RLS). Capture-only feature -- no matching/detection logic to test here,
-- just that the data lands in the right place and only the right people
-- can read it. Same style as tests/task1-6 -- RAISE NOTICE / EXCEPTION
-- assertions, wrapped in begin/rollback so nothing here touches real data.

begin;

do $$
declare
  v_admin uuid;
  v_seller uuid;
  v_other_user uuid;
  v_threw boolean;
  v_row record;
  v_row_count integer;
begin
  v_admin := gen_random_uuid();
  v_seller := gen_random_uuid();
  v_other_user := gen_random_uuid();

  insert into auth.users (id, email) values
    (v_admin, 'test-admin-' || v_admin || '@example.invalid'),
    (v_seller, 'test-seller-' || v_seller || '@example.invalid'),
    (v_other_user, 'test-other-' || v_other_user || '@example.invalid')
  on conflict do nothing;

  alter table public.profiles disable trigger trg_prevent_self_privilege_escalation;
  insert into public.profiles (id, name, email, role) values
    (v_admin, 'Test Admin', (select email from auth.users where id = v_admin), 'admin'),
    (v_seller, 'Test Seller', (select email from auth.users where id = v_seller), 'seller'),
    (v_other_user, 'Test Other', (select email from auth.users where id = v_other_user), 'buyer')
  on conflict (id) do update set role = excluded.role;
  alter table public.profiles enable trigger trg_prevent_self_privilege_escalation;

  -- ------------------------------------------------------------------------
  -- Test 1: a seller CAN self-set phone_number...
  -- ------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_seller)::text, true);
  update public.profiles set phone_number = '+64211234567' where id = v_seller;

  select phone_number into v_row from public.profiles where id = v_seller;
  if v_row.phone_number is distinct from '+64211234567' then
    raise exception 'FAIL: a user should be able to self-set their own phone_number, got %', v_row.phone_number;
  end if;
  raise notice 'PASS: phone_number is self-editable';

  -- ------------------------------------------------------------------------
  -- Test 2: ...but CANNOT self-set phone_verified_at -- it gets silently
  -- reset back to OLD (same pattern as verification_status), not an error.
  -- ------------------------------------------------------------------------
  update public.profiles set phone_verified_at = timezone('utc', now()) where id = v_seller;

  select phone_verified_at into v_row from public.profiles where id = v_seller;
  if v_row.phone_verified_at is not null then
    raise exception 'FAIL: a non-admin should not be able to self-set phone_verified_at, but it is now %', v_row.phone_verified_at;
  end if;
  raise notice 'PASS: phone_verified_at cannot be self-set (prevent_self_privilege_escalation protects it, same as verification_status)';

  -- ------------------------------------------------------------------------
  -- Test 3: an admin CAN set phone_verified_at.
  -- ------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  update public.profiles set phone_verified_at = timezone('utc', now()) where id = v_seller;

  select phone_verified_at into v_row from public.profiles where id = v_seller;
  if v_row.phone_verified_at is null then
    raise exception 'FAIL: an admin should be able to set phone_verified_at';
  end if;
  raise notice 'PASS: an admin can set phone_verified_at';

  -- ------------------------------------------------------------------------
  -- Test 4: account_ip_events requires ip_address_hash (not null) --
  -- inserting without one fails, which is what forces every writer through
  -- the keyed-hash computation rather than skipping it.
  -- ------------------------------------------------------------------------
  v_threw := false;
  begin
    insert into public.account_ip_events (profile_id, ip_address, event_type)
    values (v_seller, '203.0.113.5'::inet, 'login');
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: inserting into account_ip_events without ip_address_hash should fail (not null)';
  end if;
  raise notice 'PASS: account_ip_events requires ip_address_hash';

  insert into public.account_ip_events (profile_id, ip_address, ip_address_hash, event_type)
  values
    (v_seller, '203.0.113.5'::inet, encode(digest('203.0.113.5' || 'test-pepper', 'sha256'), 'hex'), 'signup'),
    (v_other_user, '203.0.113.9'::inet, encode(digest('203.0.113.9' || 'test-pepper', 'sha256'), 'hex'), 'login');

  -- ------------------------------------------------------------------------
  -- Test 5: RLS on account_ip_events -- the seller can read their own row,
  -- not the other user's.
  -- ------------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_seller)::text, true);
  select count(*) into v_row_count from public.account_ip_events where profile_id = v_seller;
  if v_row_count <> 1 then
    raise exception 'FAIL: seller should see their own 1 account_ip_events row, saw %', v_row_count;
  end if;
  select count(*) into v_row_count from public.account_ip_events where profile_id = v_other_user;
  if v_row_count <> 0 then
    raise exception 'FAIL: seller should NOT see the other user''s account_ip_events row, saw %', v_row_count;
  end if;
  reset role;
  raise notice 'PASS: account_ip_events RLS -- a user only sees their own IP events';

  -- ------------------------------------------------------------------------
  -- Test 6: an admin can see both.
  -- ------------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  select count(*) into v_row_count from public.account_ip_events;
  reset role;
  if v_row_count < 2 then
    raise exception 'FAIL: an admin should see both account_ip_events rows, saw %', v_row_count;
  end if;
  raise notice 'PASS: an admin can see all account_ip_events rows';

  -- ------------------------------------------------------------------------
  -- Test 7: seller_payout_accounts requires bank_account_identifier_hash,
  -- and RLS is scoped the same way.
  -- ------------------------------------------------------------------------
  v_threw := false;
  begin
    insert into public.seller_payout_accounts (seller_id, bank_account_last4) values (v_seller, '1234');
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: inserting into seller_payout_accounts without bank_account_identifier_hash should fail (not null)';
  end if;
  raise notice 'PASS: seller_payout_accounts requires bank_account_identifier_hash';

  insert into public.seller_payout_accounts (seller_id, bank_account_last4, bank_account_identifier_hash)
  values (v_seller, '1234', encode(digest('12-3456-7890123-00' || 'test-pepper', 'sha256'), 'hex'));

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_other_user)::text, true);
  select count(*) into v_row_count from public.seller_payout_accounts where seller_id = v_seller;
  reset role;
  if v_row_count <> 0 then
    raise exception 'FAIL: another user should not see the seller''s payout account row, saw %', v_row_count;
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_seller)::text, true);
  select count(*) into v_row_count from public.seller_payout_accounts where seller_id = v_seller;
  reset role;
  if v_row_count <> 1 then
    raise exception 'FAIL: the seller should see their own payout account row, saw %', v_row_count;
  end if;
  raise notice 'PASS: seller_payout_accounts RLS -- only the owning seller (or admin) can read it';

  raise notice 'ALL LINKED-ACCOUNT SIGNAL CAPTURE TESTS PASSED';
end $$;

rollback;
