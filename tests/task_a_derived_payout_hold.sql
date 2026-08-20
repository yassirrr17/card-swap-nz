-- Manual SQL test script for Task A (Giftlio follow-up): the Marketplace
-- payout hold derived from dispute_claim_window_hours + payout_hold_buffer_hours
-- instead of a separately-stored marketplace_payout_hold_hours. Same style
-- as tests/task3_payout_holds.sql -- RAISE NOTICE / EXCEPTION assertions,
-- wrapped in begin/rollback.

begin;

do $$
declare
  v_seller uuid;
  v_buyer uuid;
  v_listing_id uuid;
  v_order_id uuid;
  v_dispute_id uuid;
  v_status text;
  v_payout_status text;
  v_threw boolean;
  v_saved_dispute_window integer;
  v_saved_buffer integer;
begin
  select dispute_claim_window_hours, payout_hold_buffer_hours
    into v_saved_dispute_window, v_saved_buffer
  from public.pricing_config where id = 1;

  v_seller := gen_random_uuid();
  v_buyer := gen_random_uuid();

  insert into auth.users (id, email) values
    (v_seller, 'test-seller-' || v_seller || '@example.invalid'),
    (v_buyer, 'test-buyer-' || v_buyer || '@example.invalid')
  on conflict do nothing;

  alter table public.profiles disable trigger trg_prevent_self_privilege_escalation;
  insert into public.profiles (id, name, email, role, suspended) values
    (v_seller, 'Test Seller', (select email from auth.users where id = v_seller), 'seller', false),
    (v_buyer, 'Test Buyer', (select email from auth.users where id = v_buyer), 'buyer', false)
  on conflict (id) do update set role = excluded.role, suspended = excluded.suspended;
  alter table public.profiles enable trigger trg_prevent_self_privilege_escalation;

  -- ------------------------------------------------------------------
  -- Test 1: with defaults (48h dispute window + 24h buffer = 72h),
  -- delivered 50 hours ago is still inside the derived hold -> rejected.
  -- ------------------------------------------------------------------
  update public.pricing_config set dispute_claim_window_hours = 48, payout_hold_buffer_hours = 24 where id = 1;

  insert into public.listings (
    public_id, seller_id, seller_name, brand, face_value, sale_price, discount,
    status, expiry_date, sale_mode
  ) values (
    'TEST-A-PYT-' || substr(gen_random_uuid()::text, 1, 8), v_seller, 'Test Seller',
    'The Warehouse', 100, 80, 20, 'sold', current_date + interval '90 days', 'marketplace'
  ) returning id into v_listing_id;

  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status, delivered_at
  ) values (
    'TEST-A-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_buyer, 'Test Buyer',
    'buyer@example.invalid', 'The Warehouse', 100, 80, 0, 80, 'delivered', timezone('utc', now()) - interval '50 hours'
  ) returning id into v_order_id;

  v_threw := false;
  begin
    update public.orders set seller_paid = true, payout_released_at = now() where id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: release at 50h should have been rejected under the derived 72h hold (48+24)';
  end if;
  raise notice 'PASS: release rejected at 50h under the derived 72h hold';

  -- ------------------------------------------------------------------
  -- Test 2: same order, delivered_at pushed back to 73h ago -> release
  -- succeeds (past the derived 72h hold, no dispute, not frozen).
  -- ------------------------------------------------------------------
  update public.orders set delivered_at = timezone('utc', now()) - interval '73 hours' where id = v_order_id;
  update public.orders set seller_paid = true, payout_released_at = now() where id = v_order_id;
  select seller_paid::text, payout_status into v_status, v_payout_status from public.orders where id = v_order_id;
  if v_status is distinct from 'true' or v_payout_status is distinct from 'released' then
    raise exception 'FAIL: release at 73h should have succeeded under the derived 72h hold, seller_paid=%, payout_status=%', v_status, v_payout_status;
  end if;
  raise notice 'PASS: release succeeds at 73h under the derived 72h hold';

  -- ------------------------------------------------------------------
  -- Test 3: changing dispute_claim_window_hours ALONE moves the effective
  -- hold, with no separate marketplace_payout_hold_hours to update.
  -- Shrink the window to 12h (buffer stays 24h -> 36h effective hold) and
  -- confirm a fresh order at 40h (past the new 36h hold, but well inside
  -- the old 72h one) is now releasable.
  -- ------------------------------------------------------------------
  update public.pricing_config set dispute_claim_window_hours = 12 where id = 1;

  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status, delivered_at
  ) values (
    'TEST-A-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_buyer, 'Test Buyer',
    'buyer@example.invalid', 'The Warehouse', 100, 80, 0, 80, 'delivered', timezone('utc', now()) - interval '40 hours'
  ) returning id into v_order_id;

  update public.orders set seller_paid = true, payout_released_at = now() where id = v_order_id;
  select seller_paid::text, payout_status into v_status, v_payout_status from public.orders where id = v_order_id;
  if v_status is distinct from 'true' or v_payout_status is distinct from 'released' then
    raise exception 'FAIL: release at 40h should have succeeded once dispute_claim_window_hours dropped to 12h (36h effective hold), seller_paid=%, payout_status=%', v_status, v_payout_status;
  end if;
  raise notice 'PASS: shrinking dispute_claim_window_hours alone shrinks the effective hold accordingly';

  update public.pricing_config set dispute_claim_window_hours = 48 where id = 1;

  -- ------------------------------------------------------------------
  -- Test 4: missing config (payout_hold_buffer_hours null) blocks release
  -- with an explicit error rather than silently falling back to any
  -- default. payout_hold_buffer_hours is NOT NULL at the schema level (so
  -- this can never actually happen through the app) -- the trigger's own
  -- null check is defensive, same belt-and-suspenders pattern already used
  -- for dispute_claim_window_hours. Relax the constraint just inside this
  -- transaction (rolled back at the end) to exercise that code path.
  -- ------------------------------------------------------------------
  alter table public.pricing_config alter column payout_hold_buffer_hours drop not null;
  update public.pricing_config set payout_hold_buffer_hours = null where id = 1;

  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status, delivered_at
  ) values (
    'TEST-A-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_buyer, 'Test Buyer',
    'buyer@example.invalid', 'The Warehouse', 100, 80, 0, 80, 'delivered', timezone('utc', now()) - interval '200 hours'
  ) returning id into v_order_id;

  v_threw := false;
  begin
    update public.orders set seller_paid = true, payout_released_at = now() where id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: release with payout_hold_buffer_hours missing should have been blocked, not silently allowed';
  end if;
  raise notice 'PASS: release blocked when payout_hold_buffer_hours config is missing (no silent fallback)';

  update public.pricing_config set payout_hold_buffer_hours = v_saved_buffer where id = 1;
  alter table public.pricing_config alter column payout_hold_buffer_hours set not null;

  -- ------------------------------------------------------------------
  -- Test 5: dispute existence blocks release regardless of elapsed time --
  -- a dispute filed well within its own claim window still blocks release
  -- even once checked long past the derived hold.
  -- ------------------------------------------------------------------
  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status, delivered_at
  ) values (
    'TEST-A-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_buyer, 'Test Buyer',
    'buyer@example.invalid', 'The Warehouse', 100, 80, 0, 80, 'delivered', timezone('utc', now()) - interval '1 hour'
  ) returning id into v_order_id;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer)::text, true);
  insert into public.disputes (order_id, buyer_message) values (v_order_id, 'Balance was wrong.') returning id into v_dispute_id;
  reset role;

  -- Age the order well past any realistic hold while the dispute is still open.
  update public.orders set delivered_at = timezone('utc', now()) - interval '1000 hours' where id = v_order_id;

  v_threw := false;
  begin
    update public.orders set seller_paid = true, payout_released_at = now() where id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: release with an open dispute should be rejected regardless of elapsed time';
  end if;
  raise notice 'PASS: an open dispute blocks release regardless of elapsed time, independent of the hold length';

  update public.pricing_config set dispute_claim_window_hours = v_saved_dispute_window, payout_hold_buffer_hours = v_saved_buffer where id = 1;

  raise notice 'ALL TASK A TESTS PASSED';
end $$;

rollback;
