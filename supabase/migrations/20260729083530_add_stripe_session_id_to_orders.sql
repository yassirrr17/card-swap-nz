-- Adds Stripe webhook support to the orders table.
-- Purely additive: existing columns, rows, and policies are untouched.

alter table public.orders
  add column if not exists stripe_session_id text unique;

create index if not exists idx_orders_stripe_session_id on public.orders(stripe_session_id);
