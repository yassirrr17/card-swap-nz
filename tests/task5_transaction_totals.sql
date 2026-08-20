-- Manual SQL test script for Task 5 (rolling 12-month cumulative
-- transaction counter). Same style as tests/task1-4 -- RAISE NOTICE /
-- EXCEPTION assertions, wrapped in begin/rollback.

begin;

do $$
declare
  v_admin uuid;
  v_buyer uuid;
  v_seller uuid;
  v_listing_id uuid;
  v_totals record;
  v_threw boolean;
begin
  v_admin := gen_random_uuid();
  v_buyer := gen_random_uuid();
  v_seller := gen_random_uuid();

  insert into auth.users (id, email) values
    (v_admin, 'test-admin-' || v_admin || '@example.invalid'),
    (v_buyer, 'test-buyer-' || v_buyer || '@example.invalid'),
    (v_seller, 'test-seller-' || v_seller || '@example.invalid')
  on conflict do nothing;

  alter table public.profiles disable trigger trg_prevent_self_privilege_escalation;
  insert into public.profiles (id, name, email, role) values
    (v_admin, 'Test Admin', (select email from auth.users where id = v_admin), 'admin'),
    (v_buyer, 'Test Buyer', (select email from auth.users where id = v_buyer), 'buyer'),
    (v_seller, 'Test Seller', (select email from auth.users where id = v_seller), 'seller')
  on conflict (id) do update set role = excluded.role;
  alter table public.profiles enable trigger trg_prevent_self_privilege_escalation;

  insert into public.listings (
    public_id, seller_id, seller_name, brand, face_value, sale_price, discount,
    status, expiry_date, sale_mode, seller_payout_amount
  ) values (
    'TEST-TOT-' || substr(gen_random_uuid()::text, 1, 8), v_seller, 'Test Seller',
    'The Warehouse', 100, 80, 20, 'sold', current_date + interval '90 days', 'marketplace', 70.40
  ) returning id into v_listing_id;

  -- An order INSIDE the rolling window (100 days ago), delivered, $80.
  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status, created_at
  ) values (
    'TEST-ORD-IN-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_buyer, 'Test Buyer',
    'buyer@example.invalid', 'The Warehouse', 100, 80, 0, 80, 'delivered', timezone('utc', now()) - interval '100 days'
  );

  -- An order OUTSIDE the rolling window (400 days ago -- more than a
  -- year), otherwise identical. Proves this is a genuine rolling window,
  -- not a calendar-year bucket -- both orders are in different calendar
  -- years from "now" in a naive implementation, but only the 400-day-old
  -- one should actually be excluded.
  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status, created_at
  ) values (
    'TEST-ORD-OUT-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_buyer, 'Test Buyer',
    'buyer@example.invalid', 'The Warehouse', 100, 80, 0, 80, 'delivered', timezone('utc', now()) - interval '400 days'
  );

  -- A REFUNDED order inside the window, same buyer, $50 -- must NOT count.
  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status, created_at
  ) values (
    'TEST-ORD-REF-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_buyer, 'Test Buyer',
    'buyer@example.invalid', 'The Warehouse', 60, 50, 0, 50, 'refunded', timezone('utc', now()) - interval '50 days'
  );

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);

  select * into v_totals from public.customer_transaction_totals_365d(v_buyer);

  reset role;

  if v_totals.buying_total_365d is distinct from 80.00 then
    raise exception 'FAIL: buyer''s 365-day buying total should be exactly $80 (the in-window delivered order only), got %', v_totals.buying_total_365d;
  end if;
  raise notice 'PASS: rolling window includes an order from 100 days ago, excludes one from 400 days ago, and excludes a refunded order -- total is exactly $80';

  -- Seller's marketplace selling total should be the payout amount for the
  -- one non-refunded, in-window sale ($70.40) -- the refunded order's
  -- listing is a different one, so it doesn't interact here, but confirms
  -- the seller side sums correctly.
  select * into v_totals from public.customer_transaction_totals_365d(v_seller);
  if v_totals.marketplace_selling_total_365d is distinct from 70.40 then
    raise exception 'FAIL: seller''s marketplace selling total should be $70.40, got %', v_totals.marketplace_selling_total_365d;
  end if;
  if v_totals.combined_total_365d is distinct from 70.40 then
    raise exception 'FAIL: seller''s combined total should equal their marketplace selling total (no buying/instant activity), got %', v_totals.combined_total_365d;
  end if;
  raise notice 'PASS: marketplace selling total correctly sums the seller''s non-refunded payout amounts, combined total adds up';

  -- A non-admin cannot call this at all.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer)::text, true);
  v_threw := false;
  begin
    perform * from public.customer_transaction_totals_365d(v_buyer);
  exception when others then
    v_threw := true;
  end;
  reset role;
  if not v_threw then
    raise exception 'FAIL: a non-admin should not be able to call customer_transaction_totals_365d';
  end if;
  raise notice 'PASS: only an admin can view customer transaction totals';

  raise notice 'ALL TASK 5 TESTS PASSED';
end $$;

rollback;
