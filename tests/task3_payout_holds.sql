-- Manual SQL test script for Task 3 (DB-enforced payout holds). Same style
-- as tests/task1 and tests/task2 -- RAISE NOTICE / EXCEPTION assertions,
-- wrapped in begin/rollback.

begin;

do $$
declare
  v_seller uuid;
  v_seller_suspended uuid;
  v_buyer uuid;
  v_admin uuid;
  v_listing_id uuid;
  v_order_id uuid;
  v_dispute_id uuid;
  v_submission_id uuid;
  v_status text;
  v_payout_status text;
  v_threw boolean;
begin
  v_seller := gen_random_uuid();
  v_seller_suspended := gen_random_uuid();
  v_buyer := gen_random_uuid();
  v_admin := gen_random_uuid();

  insert into auth.users (id, email) values
    (v_seller, 'test-seller-' || v_seller || '@example.invalid'),
    (v_seller_suspended, 'test-seller-susp-' || v_seller_suspended || '@example.invalid'),
    (v_buyer, 'test-buyer-' || v_buyer || '@example.invalid'),
    (v_admin, 'test-admin-' || v_admin || '@example.invalid')
  on conflict do nothing;

  -- NOTE, two layers deep:
  --  1. handle_new_user() (AFTER INSERT on auth.users) has already
  --     auto-created a role='buyer', suspended=false profile row for each
  --     id above by the time this runs -- so this must be an upsert
  --     (ON CONFLICT DO UPDATE), not a plain insert.
  --  2. That UPDATE path fires prevent_self_privilege_escalation(), which
  --     silently reverts role/suspended/verification_status/email back to
  --     their old values UNLESS the acting session is already is_admin()
  --     -- a chicken-and-egg problem here, since this script's own
  --     connection has no JWT claims set yet (auth.uid() is null,
  --     is_admin() is false) at the point it's creating its FIRST admin
  --     fixture. Briefly disabling the trigger for this one upsert is the
  --     correct, standard way through that -- re-enabled immediately after.
  alter table public.profiles disable trigger trg_prevent_self_privilege_escalation;
  insert into public.profiles (id, name, email, role, suspended) values
    (v_seller, 'Test Seller', (select email from auth.users where id = v_seller), 'seller', false),
    (v_seller_suspended, 'Suspended Seller', (select email from auth.users where id = v_seller_suspended), 'seller', true),
    (v_buyer, 'Test Buyer', (select email from auth.users where id = v_buyer), 'buyer', false),
    (v_admin, 'Test Admin', (select email from auth.users where id = v_admin), 'admin', false)
  on conflict (id) do update set role = excluded.role, suspended = excluded.suspended;
  alter table public.profiles enable trigger trg_prevent_self_privilege_escalation;

  insert into public.listings (
    public_id, seller_id, seller_name, brand, face_value, sale_price, discount,
    status, expiry_date, sale_mode
  ) values (
    'TEST-PYT-' || substr(gen_random_uuid()::text, 1, 8), v_seller, 'Test Seller',
    'The Warehouse', 100, 80, 20, 'sold', current_date + interval '90 days', 'marketplace'
  ) returning id into v_listing_id;

  -- Delivered 1 hour ago -- well inside the payout hold (Task A: derived
  -- as dispute_claim_window_hours + payout_hold_buffer_hours, 48h + 24h =
  -- 72h by default -- no longer a separately-stored
  -- marketplace_payout_hold_hours).
  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status, delivered_at
  ) values (
    'TEST-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_buyer, 'Test Buyer',
    'buyer@example.invalid', 'The Warehouse', 100, 80, 0, 80, 'delivered', timezone('utc', now()) - interval '1 hour'
  ) returning id into v_order_id;

  -- ------------------------------------------------------------------
  -- Test 1: release attempt before the hold elapses -> rejected
  -- ------------------------------------------------------------------
  v_threw := false;
  begin
    update public.orders set seller_paid = true, payout_released_at = now() where id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: release before the hold window elapsed should have been rejected';
  end if;
  raise notice 'PASS: release rejected before the payout hold elapses';

  -- ------------------------------------------------------------------
  -- Test 2: a dispute opened while the order is still fresh (well within
  -- its own 48h claim window) keeps blocking release even once
  -- delivered_at is later pushed back past the payout hold (72h by
  -- default: 48h dispute window + 24h buffer, Task A) -- this ordering
  -- matters: a dispute can only be opened BEFORE delivered_at is
  -- artificially aged for this test, exactly like a real buyer disputing
  -- promptly and the hold subsequently elapsing while it's still open.
  -- ------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer)::text, true);
  insert into public.disputes (order_id, buyer_message) values (v_order_id, 'Balance was wrong.') returning id into v_dispute_id;
  reset role;

  update public.orders set delivered_at = timezone('utc', now()) - interval '100 hours' where id = v_order_id;

  v_threw := false;
  begin
    update public.orders set seller_paid = true, payout_released_at = now() where id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: release with an open dispute should have been rejected';
  end if;
  raise notice 'PASS: release rejected while a dispute is open';

  -- Resolve the dispute so later tests aren't blocked by it.
  update public.disputes set status = 'resolved', resolved_at = now() where id = v_dispute_id;

  -- ------------------------------------------------------------------
  -- Test 3: freeze the payout -> release now rejected even though the
  -- hold has elapsed and the dispute is resolved
  -- ------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);

  v_threw := false;
  begin
    update public.orders set payout_status = 'frozen' where id = v_order_id; -- no reason -- should fail
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: freezing without a reason should have been rejected';
  end if;

  update public.orders set payout_status = 'frozen', payout_frozen_reason = 'Suspicious activity under review.' where id = v_order_id;
  reset role;

  select payout_status into v_payout_status from public.orders where id = v_order_id;
  if v_payout_status is distinct from 'frozen' then
    raise exception 'FAIL: order should be frozen, got %', v_payout_status;
  end if;
  raise notice 'PASS: admin can freeze a payout with a reason, not without one';

  v_threw := false;
  begin
    update public.orders set seller_paid = true, payout_released_at = now() where id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: release of a frozen payout should have been rejected';
  end if;
  raise notice 'PASS: a frozen payout cannot be released';

  -- A non-admin cannot unfreeze it -- note this is blocked at the RLS
  -- layer (orders_update_admin: using (is_admin())), not by the trigger's
  -- own admin check: a buyer's UPDATE matches zero rows under RLS, so the
  -- BEFORE UPDATE trigger never even fires and no exception is raised.
  -- That's normal, correct Postgres/RLS behavior (silently filtering rows
  -- the caller isn't allowed to touch, rather than erroring) -- so this
  -- assertion checks the resulting STATE instead of expecting an
  -- exception, unlike the trigger-level checks elsewhere in this script.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer)::text, true);
  update public.orders set payout_status = 'pending' where id = v_order_id;
  reset role;

  select payout_status into v_payout_status from public.orders where id = v_order_id;
  if v_payout_status is distinct from 'frozen' then
    raise exception 'FAIL: a non-admin should not be able to unfreeze a payout (RLS should have silently blocked it), got %', v_payout_status;
  end if;
  raise notice 'PASS: only an admin can unfreeze a payout (blocked at RLS, payout stays frozen)';

  -- Admin unfreezes it.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  update public.orders set payout_status = 'pending' where id = v_order_id;
  reset role;

  -- ------------------------------------------------------------------
  -- Test 4: release now succeeds -- hold elapsed, no dispute, not frozen
  -- ------------------------------------------------------------------
  update public.orders set seller_paid = true, payout_released_at = now() where id = v_order_id;
  select seller_paid::text, payout_status into v_status, v_payout_status from public.orders where id = v_order_id;
  if v_status is distinct from 'true' or v_payout_status is distinct from 'released' then
    raise exception 'FAIL: legitimate release should have succeeded, seller_paid=%, payout_status=%', v_status, v_payout_status;
  end if;
  raise notice 'PASS: a legitimate release (hold elapsed, no dispute, not frozen) succeeds';

  -- ------------------------------------------------------------------
  -- Test 5: reversal signal -- the order gets refunded after payout
  -- ------------------------------------------------------------------
  update public.orders set status = 'refunded' where id = v_order_id;
  select payout_status into v_payout_status from public.orders where id = v_order_id;
  if v_payout_status is distinct from 'reversed' then
    raise exception 'FAIL: payout_status should flip to reversed on a post-payout refund, got %', v_payout_status;
  end if;
  raise notice 'PASS: payout_status flips to reversed when a paid order is refunded';

  -- ------------------------------------------------------------------
  -- Test 6: reversal signal via a NEW dispute on an already-paid order
  -- (a second listing/order, since the first is now refunded). delivered_at
  -- is inside the buyer's own 48h dispute claim window (a separate,
  -- independent config from the payout hold, unaffected by Task A) --
  -- otherwise enforce_dispute_insert() itself would reject the dispute
  -- before this trigger ever gets a chance to run.
  -- ------------------------------------------------------------------
  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status, delivered_at, seller_paid, payout_status, payout_released_at
  ) values (
    'TEST-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_buyer, 'Test Buyer',
    'buyer@example.invalid', 'The Warehouse', 100, 80, 0, 80, 'delivered', timezone('utc', now()) - interval '10 hours',
    true, 'released', now()
  ) returning id into v_order_id;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_buyer)::text, true);
  insert into public.disputes (order_id, buyer_message) values (v_order_id, 'Card was already used.');
  reset role;

  select payout_status into v_payout_status from public.orders where id = v_order_id;
  if v_payout_status is distinct from 'reversed' then
    raise exception 'FAIL: payout_status should flip to reversed when a dispute opens on an already-paid order, got %', v_payout_status;
  end if;
  raise notice 'PASS: payout_status flips to reversed when a dispute opens on an already-paid order';

  -- ------------------------------------------------------------------
  -- Test 7: suspended seller blocks release even with everything else
  -- clear
  -- ------------------------------------------------------------------
  insert into public.listings (
    public_id, seller_id, seller_name, brand, face_value, sale_price, discount,
    status, expiry_date, sale_mode
  ) values (
    'TEST-PYT2-' || substr(gen_random_uuid()::text, 1, 8), v_seller_suspended, 'Suspended Seller',
    'The Warehouse', 100, 80, 20, 'sold', current_date + interval '90 days', 'marketplace'
  ) returning id into v_listing_id;

  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status, delivered_at
  ) values (
    'TEST-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_buyer, 'Test Buyer',
    'buyer@example.invalid', 'The Warehouse', 100, 80, 0, 80, 'delivered', timezone('utc', now()) - interval '100 hours'
  ) returning id into v_order_id;

  v_threw := false;
  begin
    update public.orders set seller_paid = true, payout_released_at = now() where id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: release for a suspended seller should have been rejected';
  end if;
  raise notice 'PASS: release rejected for a suspended seller';

  -- ------------------------------------------------------------------
  -- Test 8: submissions.paid_at hold (Instant Sell), independent gate
  -- ------------------------------------------------------------------
  -- Instant Sell is hard-blocked at submission time by validate_card_format()
  -- (a deliberate product decision, not a bug -- see
  -- 20260805010000_marketplace_only_launch_mode.sql). This fixture only
  -- needs an approved instant-mode row to exist to test the PAYOUT trigger
  -- in isolation, so that unrelated insert-time guard is disabled just for
  -- this one row.
  alter table public.submissions disable trigger trg_card_format_validation;
  insert into public.submissions (
    public_id, seller_id, seller_name, brand, face_value, current_balance, expiry_date,
    card_number, offer_amount, status, sale_mode, approved_at
  ) values (
    'TEST-SUB-' || substr(gen_random_uuid()::text, 1, 8), v_seller, 'Test Seller', 'The Warehouse',
    100, 90, current_date + interval '90 days', '1111222233334444', 70, 'approved', 'instant',
    timezone('utc', now()) - interval '1 hour'
  ) returning id into v_submission_id;
  alter table public.submissions enable trigger trg_card_format_validation;

  v_threw := false;
  begin
    update public.submissions set paid_at = now() where id = v_submission_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: Instant Sell payout before the 24h hold elapsed should have been rejected';
  end if;
  raise notice 'PASS: Instant Sell payout rejected before the 24h hold elapses';

  update public.submissions set approved_at = timezone('utc', now()) - interval '25 hours' where id = v_submission_id;
  update public.submissions set paid_at = now() where id = v_submission_id;
  select paid_at is not null into v_status from public.submissions where id = v_submission_id;
  raise notice 'PASS: Instant Sell payout succeeds once the 24h hold has elapsed';

  raise notice 'ALL TASK 3 TESTS PASSED';
end $$;

rollback;
