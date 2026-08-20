-- Manual SQL test script for Task 6 (balance re-check gate before
-- delivery). Same style as tests/task1-5 -- RAISE NOTICE / EXCEPTION
-- assertions, wrapped in begin/rollback.
--
-- This tests the DATABASE-level backstop (enforce_balance_check_before_
-- delivery, migration 20260820201500) directly. The primary, EARLIER gate
-- lives in api/deliver-order.js itself (checked before any card is
-- decrypted or emailed, not just before the orders.status update) -- that
-- half can't be exercised from SQL alone since it depends on a live Stripe
-- session; this script proves the DB trigger that backstops it works in
-- isolation.

begin;

do $$
declare
  v_seller uuid;
  v_buyer uuid;
  v_listing_id uuid;
  v_order_id uuid;
  v_threw boolean;
  v_status text;
begin
  v_seller := gen_random_uuid();
  v_buyer := gen_random_uuid();

  insert into auth.users (id, email) values
    (v_seller, 'test-seller-' || v_seller || '@example.invalid'),
    (v_buyer, 'test-buyer-' || v_buyer || '@example.invalid')
  on conflict do nothing;

  alter table public.profiles disable trigger trg_prevent_self_privilege_escalation;
  insert into public.profiles (id, name, email, role) values
    (v_seller, 'Test Seller', (select email from auth.users where id = v_seller), 'seller'),
    (v_buyer, 'Test Buyer', (select email from auth.users where id = v_buyer), 'buyer')
  on conflict (id) do update set role = excluded.role;
  alter table public.profiles enable trigger trg_prevent_self_privilege_escalation;

  insert into public.listings (
    public_id, seller_id, seller_name, brand, face_value, sale_price, discount,
    status, expiry_date, sale_mode
  ) values (
    'TEST-BAL-' || substr(gen_random_uuid()::text, 1, 8), v_seller, 'Test Seller',
    'The Warehouse', 100, 80, 20, 'sold', current_date + interval '90 days', 'marketplace'
  ) returning id into v_listing_id;

  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status
  ) values (
    'TEST-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_buyer, 'Test Buyer',
    'buyer@example.invalid', 'The Warehouse', 100, 80, 0, 80, 'pending_verification'
  ) returning id into v_order_id;

  -- ------------------------------------------------------------------
  -- Test 1: no balance check at all -> delivery blocked
  -- ------------------------------------------------------------------
  v_threw := false;
  begin
    update public.orders set status = 'delivered', delivered_at = now() where id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: delivery with no balance check at all should have been rejected';
  end if;
  raise notice 'PASS: delivery rejected with no balance check on record';

  -- ------------------------------------------------------------------
  -- Test 2: a SUBMISSION-type or POST-delivery check does not count --
  -- must specifically be pre_delivery
  -- ------------------------------------------------------------------
  insert into public.balance_checks (listing_id, check_type, claimed_balance, checked_balance, source, status, checked_by_name)
  values (v_listing_id, 'submission', 100, 100, 'manual', 'completed', 'Test Admin');

  v_threw := false;
  begin
    update public.orders set status = 'delivered', delivered_at = now() where id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: a submission-type check should not satisfy the pre_delivery requirement';
  end if;
  raise notice 'PASS: a non-pre_delivery check type does not satisfy the gate';

  -- ------------------------------------------------------------------
  -- Test 3: a STALE pre_delivery check (older than the freshness window)
  -- does not count
  -- ------------------------------------------------------------------
  insert into public.balance_checks (listing_id, check_type, claimed_balance, checked_balance, source, status, checked_by_name, created_at)
  values (v_listing_id, 'pre_delivery', 100, 95, 'manual', 'completed', 'Test Admin', timezone('utc', now()) - interval '10 days');

  v_threw := false;
  begin
    update public.orders set status = 'delivered', delivered_at = now() where id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: a stale pre_delivery check (10 days old) should not satisfy the gate';
  end if;
  raise notice 'PASS: a stale pre_delivery check does not satisfy the gate';

  -- ------------------------------------------------------------------
  -- Test 4: a FAILED pre_delivery check does not count, even if fresh
  -- ------------------------------------------------------------------
  insert into public.balance_checks (listing_id, check_type, claimed_balance, checked_balance, source, status, checked_by_name, error)
  values (v_listing_id, 'pre_delivery', 100, null, 'manual', 'failed', 'Test Admin', 'Retailer balance page was down.');

  v_threw := false;
  begin
    update public.orders set status = 'delivered', delivered_at = now() where id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: a failed pre_delivery check should not satisfy the gate';
  end if;
  raise notice 'PASS: a failed pre_delivery check does not satisfy the gate';

  -- ------------------------------------------------------------------
  -- Test 5: a fresh, completed, pre_delivery check -> delivery succeeds
  -- ------------------------------------------------------------------
  insert into public.balance_checks (listing_id, check_type, claimed_balance, checked_balance, source, status, checked_by_name)
  values (v_listing_id, 'pre_delivery', 100, 100, 'manual', 'completed', 'Test Admin');

  update public.orders set status = 'delivered', delivered_at = now() where id = v_order_id;
  select status into v_status from public.orders where id = v_order_id;
  if v_status is distinct from 'delivered' then
    raise exception 'FAIL: delivery should have succeeded with a fresh completed pre_delivery check, status is %', v_status;
  end if;
  raise notice 'PASS: delivery succeeds once a fresh, completed pre_delivery check exists';

  raise notice 'ALL TASK 6 TESTS PASSED';
end $$;

rollback;
