-- Manual SQL test script for the $10,000 rolling transaction cap. Same style
-- as tests/task1-6 -- RAISE NOTICE / EXCEPTION assertions, wrapped in
-- begin/rollback so nothing here touches real data.
--
-- Covers the evaluate_transaction_cap / log_transaction_cap_outcome /
-- enforce_transaction_cap split introduced by the
-- 20260823181000_fix_transaction_cap_log_rollback.sql migration -- the first
-- version (a single function that both logged a rejection AND raised) had
-- its log silently undone by Postgres rolling back the whole transaction
-- along with the raise. Test 4 below specifically guards against that
-- regression recurring.

begin;

do $$
declare
  v_buyer uuid;
  v_seller uuid;
  v_seller2 uuid;
  v_seller3 uuid;
  v_listing_id uuid;
  v_listing_id2 uuid;
  v_order_id uuid;
  v_submission_id uuid;
  v_threw boolean;
  v_eval record;
  v_ledger_count integer;
begin
  create temporary table pc_snapshot on commit drop as select * from public.pricing_config where id = 1;

  v_buyer := gen_random_uuid();
  v_seller := gen_random_uuid();
  v_seller2 := gen_random_uuid();
  v_seller3 := gen_random_uuid();

  insert into auth.users (id, email) values
    (v_buyer, 'test-buyer-' || v_buyer || '@example.invalid'),
    (v_seller, 'test-seller-' || v_seller || '@example.invalid'),
    (v_seller2, 'test-seller2-' || v_seller2 || '@example.invalid'),
    (v_seller3, 'test-seller3-' || v_seller3 || '@example.invalid')
  on conflict do nothing;

  insert into public.profiles (id, name, email, role) values
    (v_buyer, 'Test Buyer', (select email from auth.users where id = v_buyer), 'buyer'),
    (v_seller, 'Test Seller', (select email from auth.users where id = v_seller), 'seller'),
    (v_seller2, 'Test Seller2', (select email from auth.users where id = v_seller2), 'seller'),
    (v_seller3, 'Test Seller3', (select email from auth.users where id = v_seller3), 'seller')
  on conflict (id) do update set role = excluded.role;

  -- ------------------------------------------------------------------------
  -- Test 1: evaluate_transaction_cap is read-only -- an allowed evaluation
  -- writes nothing to the ledger.
  -- ------------------------------------------------------------------------
  select * into v_eval from public.evaluate_transaction_cap(v_buyer, 'marketplace_buy', 5000.00);
  if v_eval.resulting_total is distinct from 5000.00 or v_eval.allowed is distinct from true then
    raise exception 'FAIL: expected resulting_total 5000.00 / allowed=true, got %/%', v_eval.resulting_total, v_eval.allowed;
  end if;
  select count(*) into v_ledger_count from public.transaction_cap_ledger where profile_id = v_buyer;
  if v_ledger_count <> 0 then
    raise exception 'FAIL: evaluate_transaction_cap must never write to the ledger, found % rows', v_ledger_count;
  end if;
  raise notice 'PASS: evaluate_transaction_cap is read-only';

  -- ------------------------------------------------------------------------
  -- Test 2: enforce_transaction_cap (the trigger-only entry point), when
  -- allowed, logs exactly one 'allowed' row.
  -- ------------------------------------------------------------------------
  perform public.enforce_transaction_cap(v_buyer, 'marketplace_buy', 5000.00, 'order_insert_trigger');
  select count(*) into v_ledger_count from public.transaction_cap_ledger where profile_id = v_buyer and outcome = 'allowed';
  if v_ledger_count <> 1 then
    raise exception 'FAIL: enforce_transaction_cap should log exactly 1 allowed row, found %', v_ledger_count;
  end if;
  raise notice 'PASS: enforce_transaction_cap logs exactly one allowed row when allowed';

  -- ------------------------------------------------------------------------
  -- Test 3: evaluate_transaction_cap correctly reports not-allowed once the
  -- buyer's rolling total would cross $10,000 (5000 + 5001 = 10001).
  -- ------------------------------------------------------------------------
  select * into v_eval from public.evaluate_transaction_cap(v_buyer, 'marketplace_buy', 5001.00);
  if v_eval.allowed is distinct from false then
    raise exception 'FAIL: a transaction pushing the rolling total to $10001 should evaluate as not allowed';
  end if;
  raise notice 'PASS: evaluate_transaction_cap reports not-allowed once the cap would be crossed';

  -- ------------------------------------------------------------------------
  -- Test 4: THE REGRESSION GUARD. log_transaction_cap_outcome, called as
  -- its OWN separate statement after evaluate_transaction_cap says
  -- not-allowed, durably persists the rejection -- this is the fix for the
  -- original "insert then raise" bug, where the very same insert was
  -- silently rolled back by the raise that followed it.
  -- ------------------------------------------------------------------------
  perform public.log_transaction_cap_outcome(
    v_buyer, 'marketplace_buy', 5001.00, 'rejected',
    v_eval.prior_total, v_eval.resulting_total, v_eval.window_days, v_eval.cap_amount,
    'checkout_precheck', null, null, 'test rejection'
  );
  select count(*) into v_ledger_count from public.transaction_cap_ledger where profile_id = v_buyer and outcome = 'rejected';
  if v_ledger_count <> 1 then
    raise exception 'FAIL: log_transaction_cap_outcome should have durably logged 1 rejected row, found %', v_ledger_count;
  end if;
  raise notice 'PASS: a rejected attempt logged via the separated evaluate+log pattern survives (the original insert-then-raise bug is fixed)';

  -- ------------------------------------------------------------------------
  -- Test 5: exactly at the cap (prior 5000 + amount 5000 = 10000) evaluates
  -- as not allowed -- "to OR over" the threshold, not just strictly over.
  -- ------------------------------------------------------------------------
  select * into v_eval from public.evaluate_transaction_cap(v_buyer, 'marketplace_buy', 5000.00);
  if v_eval.allowed is distinct from false then
    raise exception 'FAIL: landing EXACTLY at the cap should evaluate as not allowed (>=, not just >)';
  end if;
  raise notice 'PASS: landing exactly at the cap evaluates as not allowed';

  -- ------------------------------------------------------------------------
  -- Test 6: missing config blocks with an explicit error, never a silent
  -- fallback. transaction_cap_amount is NOT NULL (can't null it in place --
  -- that's a stronger guarantee than what this test originally tried), so
  -- this simulates "missing config" the only way it can actually happen:
  -- the whole singleton row being absent.
  -- ------------------------------------------------------------------------
  delete from public.pricing_config where id = 1;
  v_threw := false;
  begin
    perform public.evaluate_transaction_cap(v_seller2, 'marketplace_buy', 100.00);
  exception when others then
    v_threw := true;
  end;
  insert into public.pricing_config select * from pc_snapshot;
  if not v_threw then
    raise exception 'FAIL: a missing pricing_config row should block with an explicit error, not silently allow';
  end if;
  raise notice 'PASS: missing cap configuration blocks explicitly rather than silently allowing';

  -- ------------------------------------------------------------------------
  -- Test 7: a refund on the underlying order frees up the buyer's rolling
  -- total immediately (live join to orders.status, not a frozen snapshot).
  -- ------------------------------------------------------------------------
  insert into public.listings (
    public_id, seller_id, seller_name, brand, face_value, sale_price, discount,
    status, expiry_date, sale_mode, seller_payout_amount
  ) values (
    'TEST-CAP-' || substr(gen_random_uuid()::text, 1, 8), v_seller, 'Test Seller',
    'The Warehouse', 6000, 5000, 17, 'sold', current_date + interval '90 days', 'marketplace', 4400.00
  ) returning id into v_listing_id;

  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status
  ) values (
    'TEST-CAP-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_seller2, 'Test Seller2',
    'seller2@example.invalid', 'The Warehouse', 6000, 5000, 0, 5000, 'pending_verification'
  ) returning id into v_order_id;

  perform public.log_transaction_cap_outcome(
    v_seller2, 'marketplace_buy', 5000.00, 'allowed', 0, 5000.00, 365, 10000.00, 'order_insert_trigger', v_order_id
  );

  select * into v_eval from public.evaluate_transaction_cap(v_seller2, 'marketplace_buy', 5001.00);
  if v_eval.allowed is distinct from false then
    raise exception 'FAIL: with the $5000 order still standing, a further $5001 should evaluate as not allowed';
  end if;

  update public.orders set status = 'refunded' where id = v_order_id;

  select * into v_eval from public.evaluate_transaction_cap(v_seller2, 'marketplace_buy', 5001.00);
  if v_eval.allowed is distinct from true or v_eval.resulting_total is distinct from 5001.00 then
    raise exception 'FAIL: after the underlying order is refunded, the rolling total should exclude it (expected allowed=true, resulting_total 5001.00, got allowed=%, resulting_total=%)', v_eval.allowed, v_eval.resulting_total;
  end if;
  raise notice 'PASS: a refunded order stops counting toward the rolling total immediately';

  -- ------------------------------------------------------------------------
  -- Test 8: the orders-insert trigger backstop actually fires and blocks a
  -- real INSERT (not just calling the function directly) when it would
  -- cross the cap for the buyer.
  -- ------------------------------------------------------------------------
  perform public.enforce_transaction_cap(v_seller, 'marketplace_buy', 9999.00, 'order_insert_trigger');

  v_threw := false;
  begin
    insert into public.listings (
      public_id, seller_id, seller_name, brand, face_value, sale_price, discount,
      status, expiry_date, sale_mode, seller_payout_amount
    ) values (
      'TEST-CAP2-' || substr(gen_random_uuid()::text, 1, 8), v_seller2, 'Test Seller2',
      'The Warehouse', 100, 50, 50, 'sold', current_date + interval '90 days', 'marketplace', 44.00
    ) returning id into v_listing_id2;

    insert into public.orders (
      public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
      face_value, sale_price, service_fee, total, status
    ) values (
      'TEST-CAP2-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id2, v_seller, 'Test Seller',
      'seller@example.invalid', 'The Warehouse', 100, 50, 0, 50, 'pending_verification'
    );
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: the orders BEFORE INSERT trigger should block an order that pushes the buyer over the cap';
  end if;
  raise notice 'PASS: the orders-insert trigger backstop blocks a real INSERT that would cross the cap';

  -- ------------------------------------------------------------------------
  -- Test 9: the submissions-approval trigger fires on status -> 'approved'
  -- and blocks it when it would cross the cap for the seller. Uses a fresh
  -- profile (v_seller3) rather than v_seller, which Test 8 already left at
  -- $9,999 -- reusing it here would make even this setup call get rejected
  -- (9999 + 1 = 10000 >= cap) before the real assertion is reached.
  -- ------------------------------------------------------------------------
  perform public.enforce_transaction_cap(v_seller3, 'instant_sell', 9999.00, 'submission_approval_trigger');

  -- Instant Sell is fully blocked at submission-insert time right now
  -- (validate_card_format() rejects any sale_mode='instant' row) -- same
  -- as tests/task5_transaction_totals.sql needing to disable a different
  -- trigger for setup, this test-only disable is just to construct the row;
  -- the trigger under test here (submission-approval cap enforcement) is
  -- untouched and still fires normally below.
  alter table public.submissions disable trigger trg_card_format_validation;
  insert into public.submissions (
    public_id, seller_id, seller_name, brand, face_value, current_balance,
    expiry_date, card_number, offer_amount, status, sale_mode, issue_date
  ) values (
    'TEST-CAP-SUB-' || substr(gen_random_uuid()::text, 1, 8), v_seller3, 'Test Seller3',
    'The Warehouse', 100, 100, current_date + interval '90 days', '1111222233334444',
    50.00, 'pending_review', 'instant', current_date - interval '10 days'
  ) returning id into v_submission_id;
  alter table public.submissions enable trigger trg_card_format_validation;

  v_threw := false;
  begin
    update public.submissions set status = 'approved', approved_at = timezone('utc', now()) where id = v_submission_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: approving a submission that would push the seller over the cap should be blocked';
  end if;
  raise notice 'PASS: the submission-approval trigger backstop blocks an approval that would cross the cap';

  -- ------------------------------------------------------------------------
  -- Test 10: a legitimate marketplace order under the cap actually inserts
  -- fine and logs both buyer and seller 'allowed' rows via the trigger.
  -- Uses v_buyer (sitting at an allowed $5,000, comfortably under cap) as
  -- the buyer here, NOT v_seller -- v_seller is already at $9,999 from
  -- Test 8, so reusing it would make this legitimate order get rejected
  -- too. v_seller2 as seller nets out fine: its only prior allowed row
  -- (Test 7's $5,000) is tied to an order that was refunded, so the live
  -- refund-netting join already excludes it from their rolling total.
  -- ------------------------------------------------------------------------
  insert into public.listings (
    public_id, seller_id, seller_name, brand, face_value, sale_price, discount,
    status, expiry_date, sale_mode, seller_payout_amount
  ) values (
    'TEST-CAP3-' || substr(gen_random_uuid()::text, 1, 8), v_seller2, 'Test Seller2',
    'The Warehouse', 100, 50, 50, 'sold', current_date + interval '90 days', 'marketplace', 44.00
  ) returning id into v_listing_id2;

  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status
  ) values (
    'TEST-CAP3-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id2, v_buyer, 'Test Buyer',
    'buyer@example.invalid', 'The Warehouse', 100, 50, 0, 50, 'pending_verification'
  );

  select count(*) into v_ledger_count from public.transaction_cap_ledger where profile_id = v_buyer and outcome = 'allowed' and transaction_type = 'marketplace_buy';
  if v_ledger_count < 1 then
    raise exception 'FAIL: a legitimate under-cap order should log an allowed marketplace_buy row for the buyer';
  end if;
  select count(*) into v_ledger_count from public.transaction_cap_ledger where profile_id = v_seller2 and outcome = 'allowed' and transaction_type = 'marketplace_sell';
  if v_ledger_count < 1 then
    raise exception 'FAIL: a legitimate under-cap order should log an allowed marketplace_sell row for the seller';
  end if;
  raise notice 'PASS: a legitimate under-cap order inserts fine and logs both buyer and seller allowed rows';

  raise notice 'ALL TRANSACTION CAP TESTS PASSED';
end $$;

rollback;
