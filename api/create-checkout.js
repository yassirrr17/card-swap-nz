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
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!stripeSecretKey) {
        console.error('STRIPE_SECRET_KEY is not set in the Vercel project environment variables.');
        return res.status(500).json({ error: 'Payment processing is not configured yet.' });
    }
    if (!supabaseUrl || !supabaseServiceRoleKey) {
        console.error('Supabase env vars missing -- cannot verify checkout price server-side.');
        return res.status(500).json({ error: 'Payment processing is not configured yet.' });
    }

    const stripe = new Stripe(stripeSecretKey);
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    try {
        const { listingId, brand, faceValue, salePrice, serviceFee, total, buyerId, buyerName, buyerEmail, buyerPhone } =
            req.body || {};

        if (!listingId || !salePrice || !total || !buyerId || !buyerEmail) {
            return res.status(400).json({ error: 'Missing required checkout details.' });
        }

        // CRITICAL: never trust a client-provided price. The browser
        // request is fully attacker-controlled -- without this check,
        // anyone could tamper with the request and buy any listing at any
        // price. The only prices that are ever valid are: (a) the
        // listing's real public sale_price, or (b) an offer this specific
        // buyer has an ACCEPTED agreement for on this listing.
        const { data: listing, error: listingError } = await supabaseAdmin
            .from('listings')
            .select('sale_price, status, brand')
            .eq('id', listingId)
            .single();

        if (listingError || !listing) {
            return res.status(400).json({ error: 'This listing could not be found.' });
        }
        if (listing.status !== 'active') {
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

        const verifiedFee = Math.round(verifiedPrice * 0.05 * 100) / 100;
        const verifiedTotal = Math.round((verifiedPrice + verifiedFee) * 100) / 100;

        const origin = req.headers.origin || `https://${req.headers.host}`;

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
                },
                {
                    price_data: {
                        currency: 'nzd',
                        product_data: { name: 'Service Fee (5%)' },
                        unit_amount: Math.round(verifiedFee * 100)
                    },
                    quantity: 1
                }
            ],
            // This metadata is what the webhook (next step) will use to
            // actually create the order row and mark the listing sold --
            // it travels with the Stripe session, so it survives the
            // redirect to Stripe and back. Uses the server-VERIFIED price,
            // never the raw client-submitted one.
            metadata: {
                listing_id: listingId,
                buyer_id: buyerId,
                buyer_name: buyerName || '',
                buyer_email: buyerEmail,
                buyer_phone: buyerPhone || '',
                brand: brand || '',
                face_value: String(faceValue ?? ''),
                sale_price: String(verifiedPrice),
                service_fee: String(verifiedFee),
                total: String(verifiedTotal)
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
