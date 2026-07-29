const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

// Vercel must NOT parse the request body for this endpoint -- Stripe's
// signature verification needs the exact raw, untouched bytes of the
// request, not a re-serialized JSON object.
module.exports.config = {
    api: {
        bodyParser: false
    }
};

function readRawBody(readable) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readable.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
        readable.on('end', () => resolve(Buffer.concat(chunks)));
        readable.on('error', reject);
    });
}

function generatePublicOrderId(sessionId) {
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = sessionId.slice(-8).toUpperCase();
    return `CS-${datePart}-${suffix}`;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).send('Method not allowed.');
    }

    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!stripeSecretKey || !webhookSecret) {
        console.error('Stripe environment variables are not configured for the webhook.');
        return res.status(500).send('Webhook not configured.');
    }
    if (!supabaseUrl || !supabaseServiceRoleKey) {
        console.error('Supabase service role environment variables are not configured for the webhook.');
        return res.status(500).send('Supabase not configured for webhook.');
    }

    const stripe = new Stripe(stripeSecretKey);
    const signature = req.headers['stripe-signature'];

    let event;
    try {
        const rawBody = await readRawBody(req);
        event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (error) {
        // This catches both a missing/invalid signature and a tampered
        // payload -- either way, reject it. This is what actually proves
        // the request came from Stripe and not anywhere else.
        console.error('Webhook signature verification failed:', error.message);
        return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const metadata = session.metadata || {};

        // Service role key: bypasses RLS entirely. Required here because
        // this request has no logged-in user session for RLS to check
        // against -- but it means this client must never be reused
        // anywhere else or exposed to the frontend.
        const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

        try {
            const { error: orderError } = await supabaseAdmin.from('orders').insert({
                public_id: generatePublicOrderId(session.id),
                listing_id: metadata.listing_id,
                buyer_id: metadata.buyer_id,
                buyer_name: metadata.buyer_name,
                buyer_email: metadata.buyer_email,
                buyer_phone: metadata.buyer_phone,
                brand: metadata.brand,
                face_value: Number(metadata.face_value),
                sale_price: Number(metadata.sale_price),
                service_fee: Number(metadata.service_fee),
                total: Number(metadata.total),
                status: 'pending_verification',
                stripe_session_id: session.id
            });

            if (orderError) {
                if (orderError.code === '23505') {
                    // Unique violation on stripe_session_id -- this exact
                    // session was already processed by an earlier webhook
                    // delivery. Stripe retries webhooks by design, so this
                    // is expected sometimes, not an error to surface.
                    console.warn(`Order for session ${session.id} already exists, skipping duplicate webhook delivery.`);
                } else {
                    throw orderError;
                }
            } else {
                const { error: listingError } = await supabaseAdmin
                    .from('listings')
                    .update({ status: 'sold', sold_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                    .eq('id', metadata.listing_id)
                    .eq('status', 'active');

                if (listingError) throw listingError;
            }
        } catch (error) {
            console.error('Failed to finalize order from Stripe webhook:', error);
            // Returning 500 tells Stripe to retry this delivery later.
            return res.status(500).send('Failed to process order.');
        }
    }

    // Any other event type is intentionally ignored -- must still return
    // 200 so Stripe doesn't keep retrying it forever.
    return res.status(200).json({ received: true });
};
