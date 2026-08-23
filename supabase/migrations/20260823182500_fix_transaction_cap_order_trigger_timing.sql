-- Fixes a second real bug, also caught by tests/transaction_cap.sql before
-- it ever reached the live webhook: trg_enforce_transaction_cap_on_order_insert
-- was a BEFORE INSERT trigger, but transaction_cap_ledger.order_id has a
-- foreign key to orders(id) -- at BEFORE INSERT time the new order row does
-- not exist in public.orders yet (it's only written once the trigger
-- returns), so logging an 'allowed' row referencing new.id violated the FK
-- constraint on every single real order insert.
--
-- Fix: AFTER INSERT instead. This does not weaken the guarantee at all --
-- Postgres aborts the ENTIRE triggering statement (undoing the just-written
-- row) if any trigger, before or after, raises an uncaught exception, so
-- "block before it happens" is preserved exactly. AFTER also means new.id
-- already exists in public.orders by the time this trigger runs, so the FK
-- reference is valid.
--
-- The submissions-approval trigger is untouched -- an UPDATE's row already
-- exists (it's being updated, not newly created), so that FK reference was
-- never a problem there.

drop trigger if exists trg_enforce_transaction_cap_on_order_insert on public.orders;

create trigger trg_enforce_transaction_cap_on_order_insert
after insert on public.orders
for each row execute function public.enforce_transaction_cap_on_order_insert();
