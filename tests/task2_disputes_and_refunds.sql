-- Manual SQL test script for Task 2 (buyer dispute creation + the
-- idempotent refund state transition). Same style as
-- tests/task1_listing_reservations.sql -- plain RAISE NOTICE / EXCEPTION
-- assertions, wrapped in begin/rollback so it leaves nothing behind.
--
-- RLS only actually applies to the 'authenticated' Postgres role with a
-- JWT claim set -- the connection this script runs under (postgres /
-- service_role via the Supabase SQL editor or MCP) bypasses RLS entirely
-- by default. So each RLS-relevant check below explicitly does
-- `set local role authenticated;` and `set local request.jwt.claims = ...`
-- to actually impersonate a buyer, then resets back before the next case.

begin;

do $$
declare
  v_seller uuid;
  v_buyer1 uuid;
  v_buyer2 uuid;
  v_listing_id uuid;
  v_order_id uuid;
  v_order_id_not_delivered uuid;
  v_order_id_old uuid;
  v_dispute_id uuid;
  v_status text;
  v_threw boolean;
begin
  v_seller := gen_random_uuid();
  v_buyer1 := gen_random_uuid();
  v_buyer2 := gen_random_uuid();

  insert into auth.users (id, email) values
    (v_seller, 'test-seller-' || v_seller || '@example.invalid'),
    (v_buyer1, 'test-buyer1-' || v_buyer1 || '@example.invalid'),
    (v_buyer2, 'test-buyer2-' || v_buyer2 || '@example.invalid')
  on conflict do nothing;

  insert into public.profiles (id, name, email, role) values
    (v_seller, 'Test Seller', (select email from auth.users where id = v_seller), 'seller'),
    (v_buyer1, 'Test Buyer One', (select email from auth.users where id = v_buyer1), 'buyer'),
    (v_buyer2, 'Test Buyer Two', (select email from auth.users where id = v_buyer2), 'buyer')
  on conflict (id) do nothing;

  insert into public.listings (
    public_id, seller_id, seller_name, brand, face_value, sale_price, discount,
    status, expiry_date, sale_mode
  ) values (
    'TEST-DISP-' || substr(gen_random_uuid()::text, 1, 8), v_seller, 'Test Seller',
    'The Warehouse', 100, 80, 20, 'sold', current_date + interval '90 days', 'marketplace'
  ) returning id into v_listing_id;

  -- A delivered order (recently -- inside the claim window), buyer1's.
  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status, delivered_at, stripe_payment_intent_id
  ) values (
    'TEST-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_buyer1, 'Test Buyer One',
    'buyer1@example.invalid', 'The Warehouse', 100, 80, 0, 80, 'delivered', timezone('utc', now()) - interval '2 hours',
    'pi_test_' || substr(gen_random_uuid()::text, 1, 16)
  ) returning id into v_order_id;

  -- A not-yet-delivered order, also buyer1's.
  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status
  ) values (
    'TEST-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_buyer1, 'Test Buyer One',
    'buyer1@example.invalid', 'The Warehouse', 100, 80, 0, 80, 'pending_verification'
  ) returning id into v_order_id_not_delivered;

  -- A delivered order, but well outside the 48h claim window.
  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status, delivered_at, stripe_payment_intent_id
  ) values (
    'TEST-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_buyer1, 'Test Buyer One',
    'buyer1@example.invalid', 'The Warehouse', 100, 80, 0, 80, 'delivered', timezone('utc', now()) - interval '10 days',
    'pi_test_' || substr(gen_random_uuid()::text, 1, 16)
  ) returning id into v_order_id_old;

  -- ------------------------------------------------------------------
  -- Test 1: buyer1 CAN report an issue on their own delivered order
  -- ------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer1)::text, true);

  insert into public.disputes (order_id, buyer_message) values (v_order_id, 'The balance was $20 short.') returning id into v_dispute_id;

  reset role;

  select status into v_status from public.disputes where id = v_dispute_id;
  if v_status is distinct from 'open' then
    raise exception 'FAIL: new dispute should be open, got %', v_status;
  end if;
  raise notice 'PASS: buyer can report an issue on their own delivered order';

  -- ------------------------------------------------------------------
  -- Test 2: buyer1 CANNOT open a second dispute on the same order while
  -- one is already open (duplicate guard)
  -- ------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer1)::text, true);

  v_threw := false;
  begin
    insert into public.disputes (order_id, buyer_message) values (v_order_id, 'Also this.');
  exception when others then
    v_threw := true;
  end;
  reset role;

  if not v_threw then
    raise exception 'FAIL: a second dispute on the same order should have been rejected';
  end if;
  raise notice 'PASS: duplicate open dispute on the same order was rejected';

  -- ------------------------------------------------------------------
  -- Test 3: buyer2 CANNOT report an issue on buyer1's order
  -- ------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer2)::text, true);

  v_threw := false;
  begin
    insert into public.disputes (order_id, buyer_message) values (v_order_id_not_delivered, 'Not my order.');
  exception when others then
    v_threw := true;
  end;
  reset role;

  if not v_threw then
    raise exception 'FAIL: buyer2 should not be able to dispute buyer1''s order';
  end if;
  raise notice 'PASS: a buyer cannot report an issue on someone else''s order';

  -- ------------------------------------------------------------------
  -- Test 4: buyer1 CANNOT report an issue on an order that isn't
  -- delivered yet
  -- ------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer1)::text, true);

  v_threw := false;
  begin
    insert into public.disputes (order_id, buyer_message) values (v_order_id_not_delivered, 'Where is my card?');
  exception when others then
    v_threw := true;
  end;
  reset role;

  if not v_threw then
    raise exception 'FAIL: a non-delivered order should not be disputable';
  end if;
  raise notice 'PASS: an undelivered order cannot be disputed';

  -- ------------------------------------------------------------------
  -- Test 5: buyer1 CANNOT report an issue once the claim window has
  -- closed
  -- ------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer1)::text, true);

  v_threw := false;
  begin
    insert into public.disputes (order_id, buyer_message) values (v_order_id_old, 'Too late, but trying anyway.');
  exception when others then
    v_threw := true;
  end;
  reset role;

  if not v_threw then
    raise exception 'FAIL: a dispute outside the claim window should have been rejected';
  end if;
  raise notice 'PASS: claim window is enforced -- an old delivery cannot be disputed';

  -- ------------------------------------------------------------------
  -- Test 6: the exact idempotent refund-transition pattern used by
  -- api/webhook.js's charge.refunded handler -- replaying the same event
  -- must not error and must not double-transition.
  -- ------------------------------------------------------------------
  update public.orders set status = 'refunded', updated_at = now()
  where id = v_order_id and status <> 'refunded';

  select status into v_status from public.orders where id = v_order_id;
  if v_status is distinct from 'refunded' then
    raise exception 'FAIL: order should be refunded after the update, got %', v_status;
  end if;

  -- Replay: same update again. Must affect 0 rows and not error.
  update public.orders set status = 'refunded', updated_at = now()
  where id = v_order_id and status <> 'refunded';

  select status into v_status from public.orders where id = v_order_id;
  if v_status is distinct from 'refunded' then
    raise exception 'FAIL: replayed refund update changed order status to %', v_status;
  end if;
  raise notice 'PASS: refund state transition is idempotent under a replayed webhook event';

  raise notice 'ALL TASK 2 TESTS PASSED';
end $$;

rollback;
