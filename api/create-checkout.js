const Stripe = require('stripe');

function formatMoney(value) {
    return `$${Number(value || 0).toFixed(2)}`;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed.' });
    }

    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) {
        console.error('STRIPE_SECRET_KEY is not set in the Vercel project environment variables.');
        return res.status(500).json({ error: 'Payment processing is not configured yet.' });
    }

    const stripe = new Stripe(stripeSecretKey);

    try {
        const { listingId, brand, faceValue, salePrice, serviceFee, total, buyerId, buyerName, buyerEmail, buyerPhone } =
            req.body || {};

        if (!listingId || !salePrice || !total || !buyerId || !buyerEmail) {
            return res.status(400).json({ error: 'Missing required checkout details.' });
        }

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
                            description: 'Discounted gift card purchased via CardSwap NZ'
                        },
                        unit_amount: Math.round(Number(salePrice) * 100)
                    },
                    quantity: 1
                },
                {
                    price_data: {
                        currency: 'nzd',
                        product_data: { name: 'Service Fee (5%)' },
                        unit_amount: Math.round(Number(serviceFee) * 100)
                    },
                    quantity: 1
                }
            ],
            // This metadata is what the webhook (next step) will use to
            // actually create the order row and mark the listing sold --
            // it travels with the Stripe session, so it survives the
            // redirect to Stripe and back.
            metadata: {
                listing_id: listingId,
                buyer_id: buyerId,
                buyer_name: buyerName || '',
                buyer_email: buyerEmail,
                buyer_phone: buyerPhone || '',
                brand: brand || '',
                face_value: String(faceValue ?? ''),
                sale_price: String(salePrice ?? ''),
                service_fee: String(serviceFee ?? ''),
                total: String(total ?? '')
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
