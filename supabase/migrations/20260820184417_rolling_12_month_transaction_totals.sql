-- Task 5: a rolling cumulative 12-month transaction-value counter, as a
-- TECHNICAL CAPABILITY only. This does NOT decide, and must not be read as
-- deciding, whether/how any legal threshold (e.g. NZ AML/CFT online-
-- marketplace obligations) applies to Giftlio -- that is a LEGAL QUESTION
-- for counsel, entirely separate from what this migration builds. What
-- this migration guarantees is that the moment counsel says "here's what
-- counts and what the threshold is," the number to check it against
-- already exists and is correct -- rather than having to reconstruct it
-- retroactively from history once there's real transaction volume.
--
-- ============================================================================
-- WHAT COUNTS -- the one place this is decided, so it's easy to find and
-- change later once that legal question is answered. Do not duplicate this
-- logic anywhere else.
-- ============================================================================
-- - Rolling window: a genuine trailing 365 days from the moment of query,
--   recomputed fresh every call -- NOT a calendar-year bucket that resets
--   on 1 January. "Rolling consecutive 12-month period" is not the same
--   thing as "this calendar year," and a naive implementation that resets
--   would be wrong.
-- - Buying: orders where status is 'pending_verification' or 'delivered'
--   -- i.e. Stripe has actually captured the buyer's payment (the order
--   row only ever exists because api/webhook.js's checkout.session.
--   completed handler already ran) -- counted from order creation. A
--   'refunded' order is EXCLUDED entirely, on the reasoning that money
--   which came back shouldn't count toward a value threshold. An order
--   under an open dispute/chargeback still counts UNTIL it is actually
--   refunded -- the money hasn't moved back yet.
-- - Marketplace selling: the seller's payout amount (listings.
--   seller_payout_amount, locked in at listing-approval time) for listings
--   whose resulting order is not refunded, counted from ORDER creation
--   (the moment of sale), not listing creation (the moment it went up for
--   sale) -- a listing can sit active for months before it sells.
-- - Instant Sell selling: the seller's offer_amount for submissions
--   approved in the window (Instant Sell is a sale to Giftlio itself,
--   complete at approval -- independent of whether/when Giftlio later
--   resells the card). Instant Sell is currently disabled product-wide,
--   so this bucket will read zero for everyone until/unless it's
--   re-enabled -- the capability still needs to exist for that day.
-- - Failed/abandoned/cancelled transactions: excluded by construction --
--   this schema never creates an order row for one in the first place (no
--   order exists until Stripe confirms payment via webhook), so there is
--   nothing to explicitly filter out here.
-- - Currency conversion: not applicable -- every amount in this schema is
--   already NZD (Stripe Checkout is hardcoded to currency: 'nzd' in
--   api/create-checkout.js).
--
-- WHAT THIS DOES NOT DO, ON PURPOSE:
-- - Does NOT collapse multiple accounts belonging to one real person.
--   Totals are strictly per profiles.id. There is no capability anywhere
--   in this codebase to detect or merge duplicate accounts (see the
--   launch audit's fraud-controls findings) -- a customer could stay under
--   any future threshold simply by using a second account, and this
--   counter would not catch that.
-- - Does NOT enforce or block anything at any dollar amount. It is a
--   read-only figure for a human (admin) to look at. No submission,
--   listing, checkout, or payout is gated on this number today.
-- ============================================================================

create or replace function public.customer_transaction_totals_365d(p_profile_id uuid default null)
returns table (
  profile_id uuid,
  name text,
  email text,
  buying_total_365d numeric,
  marketplace_selling_total_365d numeric,
  instant_sell_total_365d numeric,
  combined_total_365d numeric
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not is_admin() then
    raise exception 'Not authorized to view customer transaction totals';
  end if;

  return query
  with buying as (
    select o.buyer_id as pid, coalesce(sum(o.total), 0) as total
    from public.orders o
    where o.status in ('pending_verification', 'delivered')
      and o.created_at >= timezone('utc', now()) - interval '365 days'
      and (p_profile_id is null or o.buyer_id = p_profile_id)
    group by o.buyer_id
  ),
  marketplace_selling as (
    select l.seller_id as pid, coalesce(sum(l.seller_payout_amount), 0) as total
    from public.listings l
    join public.orders o on o.listing_id = l.id
    where l.sale_mode = 'marketplace'
      and o.status <> 'refunded'
      and o.created_at >= timezone('utc', now()) - interval '365 days'
      and (p_profile_id is null or l.seller_id = p_profile_id)
    group by l.seller_id
  ),
  instant_selling as (
    select s.seller_id as pid, coalesce(sum(s.offer_amount), 0) as total
    from public.submissions s
    where s.sale_mode = 'instant'
      and s.status = 'approved'
      and s.deleted_at is null
      and s.approved_at >= timezone('utc', now()) - interval '365 days'
      and (p_profile_id is null or s.seller_id = p_profile_id)
    group by s.seller_id
  )
  select
    p.id,
    p.name,
    p.email,
    coalesce(b.total, 0),
    coalesce(ms.total, 0),
    coalesce(ins.total, 0),
    coalesce(b.total, 0) + coalesce(ms.total, 0) + coalesce(ins.total, 0)
  from public.profiles p
  left join buying b on b.pid = p.id
  left join marketplace_selling ms on ms.pid = p.id
  left join instant_selling ins on ins.pid = p.id
  where (p_profile_id is not null and p.id = p_profile_id)
     or (p_profile_id is null and (coalesce(b.total, 0) > 0 or coalesce(ms.total, 0) > 0 or coalesce(ins.total, 0) > 0))
  order by 7 desc;
end;
$function$;

revoke execute on function public.customer_transaction_totals_365d(uuid) from anon;
revoke execute on function public.customer_transaction_totals_365d(uuid) from authenticated;
grant execute on function public.customer_transaction_totals_365d(uuid) to authenticated;
grant execute on function public.customer_transaction_totals_365d(uuid) to service_role;
