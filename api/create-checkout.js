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
            .select('sale_price, status, suspended, seller_id, brand, commission_rate, sale_mode')
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

        const origin = req.headers.origin || `https://${req.headers.host}`;

        // No buyer-side fee -- the buyer pays exactly the verified sale
        // price. A single line item, nothing added on top.
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            customer_email: buyerEmail,
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

        return res.status(200).json({ url: session.url });
    } catch (error) {
        console.error('Stripe checkout session creation failed:', error);
        return res.status(500).json({ error: 'Unable to start checkout. Please try again.' });
    }
};
