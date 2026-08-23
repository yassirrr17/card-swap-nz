-- Fixes a real, exploitable access-control gap in the transaction-cap
-- functions, caught by mcp__Supabase__get_advisors (anon_security_definer_
-- function_executable / authenticated_security_definer_function_executable)
-- right after this feature was built -- not by manual review.
--
-- The previous migrations only ran `revoke all ... from public`, which
-- undoes vanilla Postgres's "functions are PUBLIC-executable by default"
-- grant. It does NOT touch Supabase's own default-privileges rule, which
-- grants EXECUTE directly to the anon and authenticated ROLES (not via
-- PUBLIC) on every newly created function in the public schema. That direct
-- grant survived, meaning any signed-in user -- or an anonymous one --
-- could call evaluate_transaction_cap(), log_transaction_cap_outcome(), and
-- enforce_transaction_cap() directly via PostgREST RPC, for ANY profile_id
-- of their choosing.
--
-- That's a genuine attack surface, not just noise: log_transaction_cap_outcome
-- and enforce_transaction_cap could be called with an arbitrary victim's
-- profile_id and a large amount to insert a bogus 'allowed' ledger row,
-- artificially inflating that victim's rolling total and blocking their next
-- legitimate transaction (a targeted denial-of-service), and evaluate_
-- transaction_cap would leak another customer's current rolling total to
-- anyone who knows (or brute-forces) their profile_id.
--
-- Fix: revoke from anon, authenticated explicitly too (in addition to the
-- existing revoke from public), on every non-trigger function this feature
-- introduced. Only service_role (used by api/create-checkout.js, and by the
-- security-definer trigger functions calling internally, which bypass grants
-- entirely) can call these now.
--
-- The two trigger functions (enforce_transaction_cap_on_order_insert,
-- enforce_transaction_cap_on_submission_approval) were flagged by the same
-- advisor, but calling a trigger function directly via RPC (outside real
-- trigger context) already fails at runtime with a Postgres error regardless
-- of grants -- NEW/OLD/TG_OP aren't set. Revoked anyway here, matching this
-- schema's existing style for every other trigger function
-- (e.g. enforce_payout_release_hold), purely for defense in depth /
-- consistency, not because it closes a live exploit.

revoke all on function public.evaluate_transaction_cap(uuid, text, numeric) from anon, authenticated;
revoke all on function public.log_transaction_cap_outcome(uuid, text, numeric, text, numeric, numeric, integer, numeric, text, uuid, uuid, text) from anon, authenticated;
revoke all on function public.enforce_transaction_cap(uuid, text, numeric, text, uuid, uuid) from anon, authenticated;
revoke all on function public.enforce_transaction_cap_on_order_insert() from anon, authenticated;
revoke all on function public.enforce_transaction_cap_on_submission_approval() from anon, authenticated;
