-- Seller payout holding periods. Fixes a real bug: sellers were seeing
-- money as "earned" the instant a submission was approved (Instant Sell)
-- or a listing sold (Marketplace) -- neither means the payout was
-- actually released.
--
-- Marketplace gets a genuinely new mechanism: orders.seller_paid, gated
-- 48 hours after delivered_at (a dedicated timestamp, deliberately
-- separate from updated_at, which could be touched by unrelated future
-- changes and corrupt the holding-period calculation).
--
-- Instant Sell reuses the EXISTING submissions.paid_at mechanism (already
-- built, with working admin action, audit logging, and notifications) --
-- no new table. It's gated 24 hours after approved_at, since approval IS
-- the verification step in this flow; there's no separate "verified" state.

alter table public.orders
  add column seller_paid boolean not null default false,
  add column delivered_at timestamptz,
  add column payout_released_at timestamptz;

comment on column public.orders.delivered_at is 'Dedicated timestamp set only when status first becomes delivered -- deliberately separate from updated_at, which could be touched by unrelated future changes and would corrupt the 48-hour payout holding period calculation.';
comment on column public.orders.seller_paid is 'Marketplace payout release gate. Only becomes true when an admin clicks Release Payout, which is itself only clickable 48 hours after delivered_at.';
