-- Task 7 (schema hygiene): two check-constraint values are defined but
-- never written by any code path in this repository. Investigated each
-- rather than blindly wiring both up -- one turns out to be intentionally
-- dead (wiring it up would silently break an existing fraud control), the
-- other is a reasonable future feature with no urgency. Documenting both
-- directly on the schema so the next engineer doesn't mistake either for
-- an oversight, or "fix" the wrong one.

-- ----------------------------------------------------------------------------
-- submissions.status: 'listed' and 'sold' are DEAD ON PURPOSE, not an
-- oversight -- do not wire these up without reading this comment first.
--
-- validate_card_format() computes a seller's trust tier (daily submission
-- cap, new-seller value caps) from:
--   select count(*) into approved_count from submissions
--   where seller_id = ... and status = 'approved'
-- If an approved submission's status were later advanced to 'listed' or
-- 'sold' once its listing goes up / sells, it would stop being counted by
-- approved_count -- silently freezing that seller's trust tier at whatever
-- it was before their first sale, the opposite of the intended effect (a
-- seller should get MORE trusted as they successfully sell more, not less).
-- 'approved' is therefore the durable terminal value for this column;
-- listings.status ('active'/'reserved'/'sold'/'inactive') is the actual
-- source of truth for whether a submission's resulting card has sold.
--
-- Known consequence worth flagging even though it's outside this specific
-- migration's scope: run_reconciliation()'s SUBMISSION_STATE_DRIFT check
-- (migration 20260818194222) fires whenever "listing X is sold but its
-- submission is still status Y" -- given the above, that condition is true
-- for essentially every marketplace submission that has ever sold, and
-- always will be. That check appears to have been written assuming
-- submissions.status WOULD advance to 'sold', which -- per this comment --
-- it deliberately does not. Worth the founder's attention as a
-- reconciliation false-positive to either fix or ignore, not something
-- this migration attempts to resolve.
-- ----------------------------------------------------------------------------

comment on column public.submissions.status is
  'pending_review -> approved -> (approved is TERMINAL and stays approved even after the resulting listing sells; see the check_constraint comment on this table for why). rejected is also terminal. listed/sold are allowed by the check constraint but are DELIBERATELY never written -- listings.status is the real source of truth for sale state once a submission is approved. Do not wire these up without reading the full comment in migration 20260820185500_document_reserved_status_values.sql -- doing so would break the approved_count seller-trust-tier calculation in validate_card_format().';

-- ----------------------------------------------------------------------------
-- listing_offers.status: 'expired' is reserved for a real future feature,
-- not dead -- just not built yet, and not urgent. Offers currently have no
-- expiry concept at all (no expires_at/created_at-based TTL enforced
-- anywhere), so there is nothing for this value to mean today. Wiring it
-- up would need: (1) an expires_at column, set at insert time in
-- enforce_offer_insert(); (2) a lazy sweep function following the exact
-- pattern release_stale_reservations() already established (Task 1,
-- migration 20260820181244) -- called opportunistically from wherever a
-- new offer is submitted, since this project has no cron/scheduled-job
-- infrastructure for a time-based sweep to run on its own.
-- ----------------------------------------------------------------------------

comment on column public.listing_offers.status is
  'pending -> accepted/rejected/countered (seller), or withdrawn (buyer), or countered -> buyer_accepted_counter/rejected (buyer). expired is allowed by the check constraint but NOT YET IMPLEMENTED -- no expires_at/TTL concept exists on this table yet. See the comment in migration 20260820185500_document_reserved_status_values.sql for what building it would actually require.';
