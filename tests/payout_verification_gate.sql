-- Manual SQL test script for the payout verification gate (unverified
-- sellers can list/sell, but payout is held until verification_status =
-- 'verified', with an admin-override escape hatch). Same style as
-- tests/task1-6 -- RAISE NOTICE / EXCEPTION assertions, wrapped in
-- begin/rollback so nothing here touches real data.

begin;

do $$
declare
  v_admin uuid;
  v_nonadmin uuid;
  v_seller_unverified uuid;
  v_seller_verified uuid;
  v_seller_instant uuid;
  v_listing_id uuid;
  v_listing_id2 uuid;
  v_order_id uuid;
  v_order_id2 uuid;
  v_submission_id uuid;
  v_threw boolean;
  v_row record;
  v_ledger_count integer;
begin
  v_admin := gen_random_uuid();
  v_nonadmin := gen_random_uuid();
  v_seller_unverified := gen_random_uuid();
  v_seller_verified := gen_random_uuid();
  v_seller_instant := gen_random_uuid();

  insert into auth.users (id, email) values
    (v_admin, 'test-admin-' || v_admin || '@example.invalid'),
    (v_nonadmin, 'test-nonadmin-' || v_nonadmin || '@example.invalid'),
    (v_seller_unverified, 'test-seller-unv-' || v_seller_unverified || '@example.invalid'),
    (v_seller_verified, 'test-seller-v-' || v_seller_verified || '@example.invalid'),
    (v_seller_instant, 'test-seller-instant-' || v_seller_instant || '@example.invalid')
  on conflict do nothing;

  alter table public.profiles disable trigger trg_prevent_self_privilege_escalation;
  insert into public.profiles (id, name, email, role, verification_status) values
    (v_admin, 'Test Admin', (select email from auth.users where id = v_admin), 'admin', 'unverified'),
    (v_nonadmin, 'Test Non-Admin', (select email from auth.users where id = v_nonadmin), 'buyer', 'unverified'),
    (v_seller_unverified, 'Test Seller Unverified', (select email from auth.users where id = v_seller_unverified), 'seller', 'unverified'),
    (v_seller_verified, 'Test Seller Verified', (select email from auth.users where id = v_seller_verified), 'seller', 'verified'),
    (v_seller_instant, 'Test Seller Instant', (select email from auth.users where id = v_seller_instant), 'seller', 'unverified')
  on conflict (id) do update set role = excluded.role, verification_status = excluded.verification_status;
  alter table public.profiles enable trigger trg_prevent_self_privilege_escalation;

  -- ------------------------------------------------------------------------
  -- Setup: a delivered Marketplace order for the UNVERIFIED seller, past
  -- its hold window, no open dispute -- everything else about this order is
  -- already eligible for release except verification.
  -- ------------------------------------------------------------------------
  insert into public.listings (
    public_id, seller_id, seller_name, brand, face_value, sale_price, discount,
    status, expiry_date, sale_mode, seller_payout_amount
  ) values (
    'TEST-VERGATE-' || substr(gen_random_uuid()::text, 1, 8), v_seller_unverified, 'Test Seller Unverified',
    'The Warehouse', 100, 50, 50, 'sold', current_date + interval '90 days', 'marketplace', 44.00
  ) returning id into v_listing_id;

  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status, delivered_at
  ) values (
    'TEST-VERGATE-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id, v_nonadmin, 'Test Non-Admin',
    'nonadmin@example.invalid', 'The Warehouse', 100, 50, 0, 50, 'delivered', timezone('utc', now()) - interval '100 hours'
  ) returning id into v_order_id;

  -- ------------------------------------------------------------------------
  -- Test 1: even bypassing RLS entirely (this test runs as postgres), the
  -- trigger ITSELF blocks release for an unverified seller with no override
  -- -- this is the "DB level, not just app code" requirement.
  -- ------------------------------------------------------------------------
  v_threw := false;
  begin
    update public.orders set seller_paid = true where id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: releasing payout for an unverified seller with no override should be blocked';
  end if;
  raise notice 'PASS: payout release is blocked for an unverified seller with no override';

  -- ------------------------------------------------------------------------
  -- Test 2: a non-admin cannot override, even with a reason supplied --
  -- the TRIGGER's own is_admin() check, independent of RLS. Deliberately
  -- NOT switching to the authenticated role here: this session stays
  -- privileged (bypassing RLS, same as Test 1) and only simulates the
  -- calling identity via request.jwt.claims -- if this instead switched to
  -- `authenticated`, the orders_update_admin RLS policy would silently
  -- match zero rows for a non-admin (no error, no trigger firing at all),
  -- which would prove RLS works but say nothing about whether the TRIGGER
  -- itself would still block a service-role call that bypasses RLS.
  -- ------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_nonadmin)::text, true);
  v_threw := false;
  begin
    update public.orders
    set seller_paid = true, payout_verification_override_reason = 'trying to sneak this through'
    where id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: a non-admin should not be able to override the verification hold, even with a reason';
  end if;
  raise notice 'PASS: only an admin can use the verification override (enforced by the trigger itself, not just RLS)';

  -- ------------------------------------------------------------------------
  -- Test 3: an admin override with an EMPTY reason is rejected.
  -- ------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  v_threw := false;
  begin
    update public.orders
    set seller_paid = true, payout_verification_override_reason = '   '
    where id = v_order_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: an admin override with a blank/whitespace-only reason should be rejected';
  end if;
  raise notice 'PASS: an empty override reason is rejected even from an admin';

  -- ------------------------------------------------------------------------
  -- Test 4: a real admin override, with a real reason, succeeds -- and
  -- override_by/override_at get stamped, and the release itself completes.
  -- ------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  update public.orders
  set seller_paid = true, payout_verification_override_reason = 'Seller needs urgent payout, verification feature not live yet'
  where id = v_order_id;

  select payout_status, payout_verification_override_reason, payout_verification_override_by, payout_verification_override_at
  into v_row from public.orders where id = v_order_id;
  if v_row.payout_status is distinct from 'released' then
    raise exception 'FAIL: the override should have let the release complete, payout_status is %', v_row.payout_status;
  end if;
  if v_row.payout_verification_override_by is distinct from v_admin then
    raise exception 'FAIL: payout_verification_override_by should be stamped with the admin who overrode it';
  end if;
  if v_row.payout_verification_override_at is null then
    raise exception 'FAIL: payout_verification_override_at should be stamped';
  end if;
  raise notice 'PASS: a valid admin override releases the payout and stamps who/when';

  -- ------------------------------------------------------------------------
  -- Test 5: that override is captured in admin_audit_log (via the extended
  -- audit_orders_changes()), not just silently applied.
  -- ------------------------------------------------------------------------
  select count(*) into v_ledger_count from public.admin_audit_log
  where target_id = v_order_id and details->>'payout_verification_override_reason' is not null;
  if v_ledger_count < 1 then
    raise exception 'FAIL: the verification override should be visible in admin_audit_log, found % matching rows', v_ledger_count;
  end if;
  raise notice 'PASS: the admin override is captured in admin_audit_log';

  -- ------------------------------------------------------------------------
  -- Test 6: a VERIFIED seller's payout releases normally, no override
  -- needed at all -- the gate should be a no-op for them.
  -- ------------------------------------------------------------------------
  insert into public.listings (
    public_id, seller_id, seller_name, brand, face_value, sale_price, discount,
    status, expiry_date, sale_mode, seller_payout_amount
  ) values (
    'TEST-VERGATE2-' || substr(gen_random_uuid()::text, 1, 8), v_seller_verified, 'Test Seller Verified',
    'The Warehouse', 100, 50, 50, 'sold', current_date + interval '90 days', 'marketplace', 44.00
  ) returning id into v_listing_id2;

  insert into public.orders (
    public_id, listing_id, buyer_id, buyer_name, buyer_email, brand,
    face_value, sale_price, service_fee, total, status, delivered_at
  ) values (
    'TEST-VERGATE2-ORD-' || substr(gen_random_uuid()::text, 1, 8), v_listing_id2, v_nonadmin, 'Test Non-Admin',
    'nonadmin@example.invalid', 'The Warehouse', 100, 50, 0, 50, 'delivered', timezone('utc', now()) - interval '100 hours'
  ) returning id into v_order_id2;

  update public.orders set seller_paid = true where id = v_order_id2;

  select payout_status, payout_verification_override_reason into v_row from public.orders where id = v_order_id2;
  if v_row.payout_status is distinct from 'released' then
    raise exception 'FAIL: a verified seller''s payout should release normally, got status %', v_row.payout_status;
  end if;
  if v_row.payout_verification_override_reason is not null then
    raise exception 'FAIL: a verified seller''s release should never touch the override columns';
  end if;
  raise notice 'PASS: a verified seller''s payout releases normally with no override involved';

  -- ------------------------------------------------------------------------
  -- Test 7: Instant Sell -- same gate, on submissions.paid_at. Uses a fresh
  -- unverified seller. Submission insert needs validate_card_format's
  -- Instant-Sell block disabled temporarily (same as the transaction-cap
  -- test), since Instant Sell submissions can't be created at all today.
  -- ------------------------------------------------------------------------
  alter table public.submissions disable trigger trg_card_format_validation;
  insert into public.submissions (
    public_id, seller_id, seller_name, brand, face_value, current_balance,
    expiry_date, card_number, offer_amount, status, sale_mode, issue_date, approved_at
  ) values (
    'TEST-VERGATE-SUB-' || substr(gen_random_uuid()::text, 1, 8), v_seller_instant, 'Test Seller Instant',
    'The Warehouse', 100, 100, current_date + interval '90 days', '1111222233334444',
    50.00, 'approved', 'instant', current_date - interval '10 days', timezone('utc', now()) - interval '100 hours'
  ) returning id into v_submission_id;
  alter table public.submissions enable trigger trg_card_format_validation;

  v_threw := false;
  begin
    update public.submissions set paid_at = timezone('utc', now()) where id = v_submission_id;
  exception when others then
    v_threw := true;
  end;
  if not v_threw then
    raise exception 'FAIL: marking an unverified Instant Sell seller''s submission paid with no override should be blocked';
  end if;
  raise notice 'PASS: Instant Sell payout is blocked for an unverified seller with no override';

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  update public.submissions
  set paid_at = timezone('utc', now()), payout_verification_override_reason = 'Urgent manual payout, verification feature not live yet'
  where id = v_submission_id;

  select payout_verification_override_by, paid_at into v_row from public.submissions where id = v_submission_id;
  if v_row.payout_verification_override_by is distinct from v_admin then
    raise exception 'FAIL: Instant Sell override should stamp the admin who overrode it';
  end if;
  raise notice 'PASS: Instant Sell admin override works and stamps who overrode it';

  raise notice 'ALL PAYOUT VERIFICATION GATE TESTS PASSED';
end $$;

rollback;
