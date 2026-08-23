const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

function formatMoney(value) {
    return `$${Number(value || 0).toFixed(2)}`;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed.' });
    }

    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!stripeSecretKey) {
        console.error('STRIPE_SECRET_KEY is not set in the Vercel project environment variables.');
        return res.status(500).json({ error: 'Payment processing is not configured yet.' });
    }
    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
        console.error('Supabase env vars missing -- cannot verify checkout price server-side.');
        return res.status(500).json({ error: 'Payment processing is not configured yet.' });
    }

    const stripe = new Stripe(stripeSecretKey);
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // The buyer's identity must come from a verified session, never from
    // the request body -- otherwise anyone could check out AS someone else
    // (their name/email would land on someone else's order). Reject
    // anonymous calls entirely.
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: 'Missing authentication token.' });
    }
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser(token);
    if (userError || !userData?.user) {
        return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
    }
    const buyerId = userData.user.id;

    try {
        const { listingId, brand, faceValue, salePrice, buyerName, buyerEmail, buyerPhone } = req.body || {};

        if (!listingId || !salePrice || !buyerEmail) {
            return res.status(400).json({ error: 'Missing required checkout details.' });
        }

        // Best-effort, opportunistic sweep: there is no cron infrastructure in
        // this project, so any reservation left over from an abandoned
        // checkout gets released here, lazily, the next time anyone tries to
        // buy anything. Must never block or fail this request.
        try {
            await supabaseAdmin.rpc('release_stale_reservations');
        } catch (sweepError) {
            console.warn('release_stale_reservations sweep failed (non-fatal):', sweepError);
        }

        // CRITICAL: never trust a client-provided price. The browser
        // request is fully attacker-controlled -- without this check,
        // anyone could tamper with the request and buy any listing at any
        // price. The only prices that are ever valid are: (a) the
        // listing's real public sale_price, or (b) an offer this specific
        // buyer has an ACCEPTED agreement for on this listing.
        //
        // commission_rate/sale_mode are read from the listing here too --
        // this is the rate THIS listing was actually priced with at
        // approval time (never re-derived from today's config, which may
        // have since changed, and never trusted from the client) -- and
        // passed through to the webhook via metadata so the order's
        // gross_commission instrumentation reflects what this seller was
        // actually promised, not a possibly-drifted current rate.
        const { data: listing, error: listingError } = await supabaseAdmin
            .from('listings')
            .select('sale_price, status, suspended, seller_id, brand, commission_rate, sale_mode, seller_payout_amount')
            .eq('id', listingId)
            .single();

        if (listingError || !listing) {
            return res.status(400).json({ error: 'This listing could not be found.' });
        }
        if (listing.status !== 'active') {
            return res.status(400).json({ error: 'This listing is no longer available.' });
        }

        // Kill switches, enforced server-side using the service-role
        // client -- which bypasses RLS entirely, so the RLS-level
        // suspension check on this table does NOT protect this endpoint by
        // itself. "Suspend listing" and "suspend seller" must both
        // actually block a sale here, not just hide the listing from the
        // browse grid.
        if (listing.suspended) {
            return res.status(400).json({ error: 'This listing is no longer available.' });
        }
        const { data: sellerProfile } = await supabaseAdmin.from('profiles').select('suspended').eq('id', listing.seller_id).single();
        if (sellerProfile?.suspended) {
            return res.status(400).json({ error: 'This listing is no longer available.' });
        }

        // Retailer kill switch, enforced server-side too -- a client-side
        // disabled button is a UI convenience, not security. Without this
        // check here, disabling a retailer in the admin panel wouldn't
        // actually stop a determined buyer from completing a purchase.
        const { data: brandConfig } = await supabaseAdmin.from('brand_discounts').select('retailer_enabled').eq('brand', listing.brand).maybeSingle();
        if (brandConfig && brandConfig.retailer_enabled === false) {
            return res.status(400).json({ error: `${listing.brand} is temporarily unavailable for purchase right now.` });
        }

        const submittedPrice = Number(salePrice);
        const centsMatch = (a, b) => Math.round(Number(a) * 100) === Math.round(Number(b) * 100);

        let verifiedPrice = null;

        if (centsMatch(submittedPrice, listing.sale_price)) {
            verifiedPrice = Number(listing.sale_price);
        } else {
            const { data: acceptedOffer } = await supabaseAdmin
                .from('listing_offers')
                .select('offer_amount, counter_amount, status')
                .eq('listing_id', listingId)
                .eq('buyer_id', buyerId)
                .in('status', ['accepted', 'buyer_accepted_counter'])
                .order('responded_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            const agreedAmount = acceptedOffer?.status === 'buyer_accepted_counter' ? acceptedOffer.counter_amount : acceptedOffer?.offer_amount;

            if (acceptedOffer && centsMatch(submittedPrice, agreedAmount)) {
                verifiedPrice = Number(agreedAmount);
            }
        }

        if (verifiedPrice === null) {
            console.warn(`Checkout price mismatch for listing ${listingId}: submitted ${submittedPrice}, listing price ${listing.sale_price}, buyer ${buyerId}`);
            return res.status(400).json({ error: 'This price is no longer valid. Please refresh the listing and try again.' });
        }

        // $10k rolling transaction cap: a read-only pre-check
        // (evaluate_transaction_cap never writes to the ledger or raises on
        // cap logic) -- if it comes back not-allowed, log_transaction_cap_outcome
        // is called as its OWN separate statement to durably record the
        // rejection, since a single function that both logs and raises
        // would have that log undone by Postgres rolling back the whole
        // transaction along with the raise (this is exactly what the first
        // version of this feature got wrong -- see
        // supabase/migrations/20260823181000_fix_transaction_cap_log_rollback.sql).
        // An allowed result here logs nothing -- the orders-insert trigger
        // in the webhook is the only place an 'allowed' row is ever written,
        // so one real sale can never be double-counted.
        //
        // Checked for the buyer always; for the seller only when this is a
        // genuine Marketplace listing -- an Instant-Sell-sourced listing
        // being resold here has Giftlio as its effective seller for cap
        // purposes, not the original submitter, who was already checked at
        // their own approval time. A rejection on EITHER side returns the
        // same generic message to the buyer -- telling them "the seller is
        // over their limit" would leak another user's financial state.
        async function evaluateAndLogCapRejection(profileId, transactionType, amount) {
            const { data: evalRows, error: evalError } = await supabaseAdmin.rpc('evaluate_transaction_cap', {
                p_profile_id: profileId,
                p_transaction_type: transactionType,
                p_amount: amount
            });
            if (evalError) throw evalError;
            const evalResult = Array.isArray(evalRows) ? evalRows[0] : evalRows;
            if (!evalResult.allowed) {
                const { error: logError } = await supabaseAdmin.rpc('log_transaction_cap_outcome', {
                    p_profile_id: profileId,
                    p_transaction_type: transactionType,
                    p_amount: amount,
                    p_outcome: 'rejected',
                    p_prior_total: evalResult.prior_total,
                    p_resulting_total: evalResult.resulting_total,
                    p_window_days: evalResult.window_days,
                    p_cap_amount: evalResult.cap_amount,
                    p_source: 'checkout_precheck',
                    p_rejection_reason: `Would reach/exceed the $${evalResult.cap_amount} rolling ${evalResult.window_days}-day cap (existing total $${evalResult.prior_total} + this $${amount})`
                });
                if (logError) console.error('Failed to log transaction cap rejection:', logError);
                return false;
            }
            return true;
        }

        try {
            const buyerAllowed = await evaluateAndLogCapRejection(buyerId, 'marketplace_buy', verifiedPrice);
            let sellerAllowed = true;
            if (listing.sale_mode === 'marketplace' && listing.seller_payout_amount !== null && listing.seller_payout_amount !== undefined) {
                sellerAllowed = await evaluateAndLogCapRejection(listing.seller_id, 'marketplace_sell', listing.seller_payout_amount);
            }
            if (!buyerAllowed || !sellerAllowed) {
                console.warn(`Transaction cap pre-check blocked checkout for listing ${listingId}, buyer ${buyerId} (buyerAllowed=${buyerAllowed}, sellerAllowed=${sellerAllowed}).`);
                return res.status(400).json({ error: 'This purchase can\'t be completed right now. Please contact support.' });
            }
        } catch (capError) {
            console.error(`Transaction cap pre-check failed for listing ${listingId}, buyer ${buyerId}:`, capError.message);
            return res.status(500).json({ error: 'Unable to start checkout. Please try again.' });
        }

        // The actual race fix: an atomic active->reserved transition. Two
        // concurrent buyers can both reach this line, but only one UPDATE
        // can win the row -- the loser gets a clean 409 here and no Stripe
        // session is ever created for them. This must be the LAST
        // availability check before Stripe, immediately before session
        // creation -- everything above (suspension, kill switch, price) is
        // eligibility, not availability, and doesn't need to be atomic.
        const { data: reserved, error: reserveError } = await supabaseAdmin.rpc('reserve_listing_for_checkout', {
            p_listing_id: listingId,
            p_buyer_id: buyerId
        });
        if (reserveError) {
            console.error('reserve_listing_for_checkout failed:', reserveError);
            return res.status(500).json({ error: 'Unable to start checkout. Please try again.' });
        }
        if (!reserved) {
            return res.status(409).json({ error: 'Someone else is already buying this card. Please check back in a few minutes -- if their payment doesn’t go through, it will become available again.' });
        }

        const { data: pricingConfig } = await supabaseAdmin.from('pricing_config').select('checkout_reservation_ttl_minutes').eq('id', 1).single();
        const ttlMinutes = pricingConfig?.checkout_reservation_ttl_minutes || 30;

        const origin = req.headers.origin || `https://${req.headers.host}`;

        let session;
        try {
            // No buyer-side fee -- the buyer pays exactly the verified sale
            // price. A single line item, nothing added on top.
            session = await stripe.checkout.sessions.create({
                mode: 'payment',
                payment_method_types: ['card'],
                customer_email: buyerEmail,
                // Matches the reservation TTL above -- when this Stripe
                // session expires, the checkout.session.expired webhook
                // handler releases this exact reservation back to 'active'.
                // Stripe enforces a 30-minute floor on this value, which is
                // why the TTL/config check constraint also enforces >= 30.
                expires_at: Math.floor(Date.now() / 1000) + ttlMinutes * 60,
                line_items: [
                    {
                        price_data: {
                            currency: 'nzd',
                            product_data: {
                                name: `${brand} Gift Card - ${formatMoney(faceValue)} value`,
                                description: 'Discounted gift card purchased via Giftlio'
                            },
                            unit_amount: Math.round(verifiedPrice * 100)
                        },
                        quantity: 1
                    }
                ],
                // This metadata is what the webhook (next step) will use to
                // actually create the order row and mark the listing sold --
                // it travels with the Stripe session, so it survives the
                // redirect to Stripe and back. Uses the server-VERIFIED price,
                // never the raw client-submitted one. commission_rate/sale_mode
                // come from the listing row above, also never client-supplied.
                metadata: {
                    listing_id: listingId,
                    buyer_id: buyerId,
                    buyer_name: buyerName || '',
                    buyer_email: buyerEmail,
                    buyer_phone: buyerPhone || '',
                    brand: brand || '',
                    face_value: String(faceValue ?? ''),
                    sale_price: String(verifiedPrice),
                    sale_mode: listing.sale_mode || '',
                    commission_rate: listing.commission_rate !== null && listing.commission_rate !== undefined ? String(listing.commission_rate) : ''
                },
                success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}#checkout`,
                cancel_url: `${origin}/?checkout=cancelled#checkout`
            });
        } catch (stripeError) {
            // The listing is now reserved but there is no Stripe session for
            // this buyer to ever complete or expire -- release it
            // immediately rather than leaving it locked for the full TTL.
            await supabaseAdmin
                .from('listings')
                .update({ status: 'active', reserved_at: null, reserved_by: null })
                .eq('id', listingId)
                .eq('status', 'reserved')
                .eq('reserved_by', buyerId);
            throw stripeError;
        }

        return res.status(200).json({ url: session.url });
    } catch (error) {
        console.error('Stripe checkout session creation failed:', error);
        return res.status(500).json({ error: 'Unable to start checkout. Please try again.' });
    }
};
