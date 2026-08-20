-- Task C (Giftlio follow-up): proportionate chargeback mitigation.
--
-- A Marketplace payout hold protects against in-app disputes filed within
-- dispute_claim_window_hours. It does nothing for a Stripe card chargeback,
-- which can arrive up to ~120 days after the original payment -- long
-- after any realistic hold has expired and the payout has been released.
--
-- The real fix (collecting seller bank/payment details so a clawback is
-- technically possible) is a product decision, not a bug fix: Giftlio
-- currently stores no bank-account or payment-instrument data for a seller
-- at all, and starting to would be a deliberate new category of sensitive
-- financial data. This migration does NOT do that. It adds a manual
-- checkpoint only: high-value orders get flagged for a human to look at
-- twice before release, nothing more. It mitigates the exposure; it does
-- not close it.

alter table public.orders
  add column if not exists chargeback_risk_reviewed boolean not null default false,
  add column if not exists chargeback_risk_notes text;

comment on column public.orders.chargeback_risk_reviewed is
  'Manual admin acknowledgement that a high-value order''s chargeback exposure (dollars that cannot be automatically clawed back from a seller if a card-network chargeback lands after payout) has been looked at. Set from the admin payout queue, not automatically -- there is no automated clawback mechanism to pair it with.';

comment on column public.orders.chargeback_risk_notes is
  'Free-text notes an admin leaves when reviewing chargeback risk on a high-value order (e.g. why it was judged acceptable to release).';

alter table public.pricing_config
  add column if not exists chargeback_review_threshold_amount numeric(10,2) not null default 250.00
  check (chargeback_review_threshold_amount > 0);

comment on column public.pricing_config.chargeback_review_threshold_amount is
  'Orders with total >= this amount get an extra "chargeback risk" flag in the admin payout queue, prompting a manual second look before release (chargeback windows run well past the standard payout hold). Config-driven so there is no hardcoded dollar figure to hunt down in app code -- tune it directly in Platform Economics as real order volume comes in. Not a hard gate: this is a visibility aid, not an automated block, and it does not by itself prevent a chargeback loss.';
