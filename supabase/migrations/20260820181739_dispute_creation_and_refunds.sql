-- Task 2: a buyer who receives a drained/invalid card currently has NO
-- in-app way to open a dispute. The disputes table has full admin
-- read/update/resolve code, but no INSERT policy exists for a buyer or
-- seller -- only "Admins manage disputes" (for all) and a select-only
-- policy for the buyer/seller. This migration adds the missing insert
-- path, plus wires real Stripe refund/chargeback events into it, so
-- run_reconciliation()'s existing PAYOUT_WITH_OPEN_DISPUTE check has
-- something real to protect against (Task 3 makes that check a hard block,
-- not just a detector).

-- ----------------------------------------------------------------------------
-- Config: claim window, not hardcoded. 48 hours to match the wording
-- already sent to every buyer in the delivery email ("verify the balance
-- within 48 hours") -- that copy is a promise; this makes it a real,
-- enforced window instead of just words in an email.
-- ----------------------------------------------------------------------------

alter table public.pricing_config
  add column if not exists dispute_claim_window_hours integer not null default 48
  check (dispute_claim_window_hours > 0);

comment on column public.pricing_config.dispute_claim_window_hours is
  'How long after delivered_at a buyer can open a dispute on an order. Matches the "verify within 48 hours" wording in the delivery email (api/deliver-order.js) -- keep these in sync if either changes.';

-- ----------------------------------------------------------------------------
-- disputes.source: distinguishes a genuine buyer report from a dispute this
-- migration auto-creates when Stripe reports a card-network chargeback
-- (charge.dispute.created) -- an admin looking at the queue needs to know
-- which one they're looking at; a chargeback needs different handling
-- (it's already gone to Stripe's own dispute process) than a buyer's "the
-- balance was wrong" report.
-- ----------------------------------------------------------------------------

alter table public.disputes
  add column if not exists source text not null default 'buyer'
  check (source in ('buyer', 'stripe_chargeback'));

-- Traces a dispute/refund back to the Stripe event that caused it, and
-- lets webhook.js find the order a charge.refunded / charge.dispute.created
-- event belongs to -- orders only ever stored stripe_session_id before,
-- and neither of those event types carries a Checkout Session id.
alter table public.orders
  add column if not exists stripe_payment_intent_id text;

create index if not exists idx_orders_stripe_payment_intent on public.orders(stripe_payment_intent_id);

-- ----------------------------------------------------------------------------
-- enforce_dispute_insert(): every field a buyer could lie about is either
-- validated against the real order or overwritten with the server-derived
-- value, same pattern as enforce_offer_insert(). Two callers:
--   1. A real buyer, from the app (auth.uid() = the order's buyer).
--   2. The webhook (service role, auth.uid() is null) auto-creating a
--      dispute when Stripe reports a chargeback -- not subject to the
--      "must be delivered" / claim-window rules a genuine buyer report is,
--      since a card network dispute can happen regardless of delivery
--      status or how long ago it was delivered.
-- Admins can also insert directly (existing "Admins manage disputes" policy
-- already grants this) with the same relaxed rules as the service-role path.
-- ----------------------------------------------------------------------------

create or replace function public.enforce_dispute_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order record;
  v_claim_window_hours integer;
  v_seller_id uuid;
begin
  if new.order_id is null then
    raise exception 'A dispute must reference an order.';
  end if;

  select o.buyer_id, o.listing_id, o.status, o.delivered_at
    into v_order
  from public.orders o
  where o.id = new.order_id;

  if not found then
    raise exception 'That order does not exist.';
  end if;

  if exists (
    select 1 from public.disputes d
    where d.order_id = new.order_id and d.status in ('open', 'investigating')
  ) then
    raise exception 'There is already an open dispute for this order.';
  end if;

  if is_admin() or auth.uid() is null then
    -- Admin, or the service-role webhook auto-creating a chargeback
    -- dispute -- buyer_id/source come from the caller (webhook sets
    -- source='stripe_chargeback' and buyer_id from the order it already
    -- looked up), not re-derived here, and not subject to the
    -- delivered/claim-window rules below.
    if new.buyer_id is null then
      new.buyer_id := v_order.buyer_id;
    end if;
  else
    -- A real buyer reporting their own order, from the app.
    if v_order.buyer_id != auth.uid() then
      raise exception 'You can only report an issue with your own order.';
    end if;
    if v_order.status != 'delivered' then
      raise exception 'You can only report an issue once this order has been delivered.';
    end if;

    select dispute_claim_window_hours into v_claim_window_hours from public.pricing_config where id = 1;
    if v_claim_window_hours is null then
      raise exception 'Dispute configuration is missing. Contact support -- this is not something you can fix by retrying.';
    end if;

    if v_order.delivered_at is null or timezone('utc', now()) > v_order.delivered_at + (v_claim_window_hours || ' hours')::interval then
      raise exception 'The window to report an issue with this order has closed (% hours after delivery). Contact support directly.', v_claim_window_hours;
    end if;

    new.buyer_id := auth.uid();
    new.source := 'buyer';
  end if;

  select l.seller_id into v_seller_id from public.listings l where l.id = v_order.listing_id;

  new.listing_id := v_order.listing_id;
  new.seller_id := v_seller_id;
  new.status := 'open';
  new.public_id := 'DSP-' || to_char(timezone('utc', now()), 'YYYYMMDD') || '-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
  new.resolved_at := null;

  if new.buyer_message is null or length(trim(new.buyer_message)) = 0 then
    raise exception 'Please describe the issue.';
  end if;

  return new;
end;
$function$;

revoke execute on function public.enforce_dispute_insert() from anon, authenticated;

drop trigger if exists trg_enforce_dispute_insert on public.disputes;
create trigger trg_enforce_dispute_insert
before insert on public.disputes
for each row execute function public.enforce_dispute_insert();

-- The RLS gate: a buyer can insert a dispute row at all only if buyer_id
-- ends up being their own uid. The trigger above runs BEFORE this check and
-- forces buyer_id := auth.uid() on the genuine-buyer path, so this policy
-- evaluates against the corrected, trustworthy value -- not whatever the
-- client originally submitted.
drop policy if exists "buyers_can_report_their_own_delivered_order" on public.disputes;
create policy "buyers_can_report_their_own_delivered_order"
on public.disputes
for insert
with check (buyer_id = auth.uid());
