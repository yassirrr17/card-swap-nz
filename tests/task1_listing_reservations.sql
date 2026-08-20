-- Manual SQL test script for Task 1 (double-sold listing race fix).
-- Run against a non-production project, or wrap the whole thing in a
-- transaction you roll back (see bottom). Uses plain RAISE NOTICE / EXCEPTION
-- assertions -- there is no pgTAP or test framework in this project, so this
-- follows the same "runnable with nothing extra installed" spirit as
-- pricing-helper.test.js.
--
-- What this covers:
--   1. reserve_listing_for_checkout() only lets ONE caller win an
--      active->reserved transition (the actual race-condition fix).
--   2. A second reservation attempt on an already-reserved listing fails
--      cleanly (returns false, does not throw, does not change anything).
--   3. release_stale_reservations() releases a reservation older than the
--      configured TTL, and leaves a fresh one alone.
--   4. release_stale_reservations() never touches a 'sold' listing.
--
-- What this does NOT cover: true concurrent (simultaneous) requests -- that
-- needs two real parallel database sessions. To verify that by hand, open
-- two `psql` sessions on the same listing id and run
-- `select reserve_listing_for_checkout('<id>', '<buyer>');` in both at the
-- same moment (e.g. with `\watch` or by pasting into both at once) --
-- exactly one should return true. This script instead proves the mechanism
-- that MAKES that true: the UPDATE ... WHERE status = 'active' guard, which
-- Postgres's own row-level locking serializes for you -- there is no
-- separate "check" step for a second session to race against.

begin;

do $$
declare
  v_seller uuid;
  v_buyer1 uuid;
  v_buyer2 uuid;
  v_listing_id uuid;
  v_result boolean;
  v_status text;
  v_released int;
begin
  -- ------------------------------------------------------------------
  -- Fixtures: a seller, two buyers, one active listing. Uses fake
  -- auth.users rows so this can run standalone -- if your project
  -- enforces the auth.users FK strictly, insert real test users first
  -- and swap these ids for real ones instead.
  -- ------------------------------------------------------------------
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
    'TEST-RESV-' || substr(gen_random_uuid()::text, 1, 8), v_seller, 'Test Seller',
    'The Warehouse', 100, 80, 20, 'active', current_date + interval '90 days', 'marketplace'
  ) returning id into v_listing_id;

  -- ------------------------------------------------------------------
  -- Test 1: first reservation succeeds
  -- ------------------------------------------------------------------
  v_result := public.reserve_listing_for_checkout(v_listing_id, v_buyer1);
  if v_result is not true then
    raise exception 'FAIL: first reservation should have succeeded, got %', v_result;
  end if;

  select status into v_status from public.listings where id = v_listing_id;
  if v_status is distinct from 'reserved' then
    raise exception 'FAIL: listing status should be reserved after first call, got %', v_status;
  end if;
  raise notice 'PASS: first reservation succeeded and listing is reserved';

  -- ------------------------------------------------------------------
  -- Test 2: second reservation (different buyer) on the same listing
  -- fails cleanly -- THIS is the double-sell bug fix, proven directly.
  -- ------------------------------------------------------------------
  v_result := public.reserve_listing_for_checkout(v_listing_id, v_buyer2);
  if v_result is not false then
    raise exception 'FAIL: second concurrent reservation should have been rejected, got %', v_result;
  end if;

  select reserved_by into v_status from public.listings where id = v_listing_id;
  if v_status::uuid is distinct from v_buyer1 then
    raise exception 'FAIL: reserved_by should still be buyer1 after a rejected second attempt, got %', v_status;
  end if;
  raise notice 'PASS: second reservation was rejected, first buyer still holds the reservation';

  -- ------------------------------------------------------------------
  -- Test 3: release_stale_reservations() leaves a fresh reservation alone
  -- ------------------------------------------------------------------
  select release_stale_reservations() into v_released;
  select status into v_status from public.listings where id = v_listing_id;
  if v_status is distinct from 'reserved' then
    raise exception 'FAIL: a fresh reservation should not be released, status is %', v_status;
  end if;
  raise notice 'PASS: fresh reservation untouched by the sweep (% unrelated rows released)', v_released;

  -- ------------------------------------------------------------------
  -- Test 4: an old reservation IS released by the sweep
  -- ------------------------------------------------------------------
  update public.listings
  set reserved_at = timezone('utc', now()) - interval '1 hour'
  where id = v_listing_id;

  select release_stale_reservations() into v_released;
  select status into v_status from public.listings where id = v_listing_id;
  if v_status is distinct from 'active' then
    raise exception 'FAIL: stale reservation should have been released back to active, got %', v_status;
  end if;
  if v_released < 1 then
    raise exception 'FAIL: release_stale_reservations should report at least 1 row released, got %', v_released;
  end if;
  raise notice 'PASS: stale reservation released back to active (% rows)', v_released;

  -- ------------------------------------------------------------------
  -- Test 5: a 'sold' listing is never touched by the sweep, even if its
  -- stale reserved_at timestamp was somehow left behind
  -- ------------------------------------------------------------------
  update public.listings
  set status = 'sold', reserved_at = timezone('utc', now()) - interval '1 hour', reserved_by = v_buyer1
  where id = v_listing_id;

  perform release_stale_reservations();
  select status into v_status from public.listings where id = v_listing_id;
  if v_status is distinct from 'sold' then
    raise exception 'FAIL: a sold listing must never be reverted by the sweep, got %', v_status;
  end if;
  raise notice 'PASS: sold listing left untouched by the sweep';

  raise notice 'ALL TASK 1 TESTS PASSED';
end $$;

-- Roll back all fixture data -- this script never leaves test rows behind.
rollback;
