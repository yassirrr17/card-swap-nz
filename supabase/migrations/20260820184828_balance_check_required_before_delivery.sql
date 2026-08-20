-- Task 6: api/deliver-order.js re-verifies the Stripe PAYMENT before
-- decrypting and emailing a card -- but never re-checks the card's
-- BALANCE. A card validated once at submission could be drained before the
-- buyer ever receives it, and nothing would catch that at the moment of
-- delivery. There is no automated retailer balance API anywhere in this
-- codebase (balance_checks.source='automated' is schema-ready for one, but
-- no writer exists) -- so this is, correctly, a human confirmation gate,
-- not a fabricated automated check. It requires a real, recent
-- balance_checks row (an admin who actually read the retailer's balance
-- page), not just a rubber-stamped default.

alter table public.pricing_config
  add column if not exists balance_check_freshness_hours integer not null default 72
  check (balance_check_freshness_hours > 0);

comment on column public.pricing_config.balance_check_freshness_hours is
  'How recent a pre_delivery balance_checks row must be to allow an order to be marked delivered. Deliberately tighter than the general 7-day "worth another look" staleness badge shown elsewhere in the admin listings table (BALANCE_CHECK_STALE_DAYS in app.js) -- this one is a hard gate on real money-equivalent credentials being sent, not a soft prompt.';

create or replace function public.enforce_balance_check_before_delivery()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_freshness_hours integer;
  v_has_fresh_check boolean;
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    select balance_check_freshness_hours into v_freshness_hours from public.pricing_config where id = 1;
    if v_freshness_hours is null then
      raise exception 'Balance-check freshness configuration is missing. Contact support -- this is not something you can fix by retrying.';
    end if;

    select exists (
      select 1 from public.balance_checks bc
      where bc.listing_id = new.listing_id
        and bc.check_type = 'pre_delivery'
        and bc.status = 'completed'
        and bc.created_at >= timezone('utc', now()) - (v_freshness_hours || ' hours')::interval
    ) into v_has_fresh_check;

    if not v_has_fresh_check then
      raise exception 'A balance check (pre-delivery, within the last % hours) is required before this order can be marked delivered.', v_freshness_hours;
    end if;
  end if;

  return new;
end;
$function$;

revoke execute on function public.enforce_balance_check_before_delivery() from anon, authenticated;

drop trigger if exists trg_enforce_balance_check_before_delivery on public.orders;
create trigger trg_enforce_balance_check_before_delivery
before update on public.orders
for each row execute function public.enforce_balance_check_before_delivery();
