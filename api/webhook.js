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
                const { data: updatedListing, error: listingError } = await supabaseAdmin
                    .from('listings')
                    .update({ status: 'sold', sold_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                    .eq('id', metadata.listing_id)
                    .eq('status', 'active')
                    .select('seller_id, seller_name, sale_mode')
                    .single();

                if (listingError) throw listingError;

                const resendApiKey = process.env.RESEND_API_KEY;
                const emailFrom = process.env.EMAIL_FROM || 'Giftlio <onboarding@resend.dev>';

                // Shared send-and-record helper -- queue first, then attempt
                // send. A failed send here must never fail the webhook
                // itself (Stripe would retry the whole order-processing
                // flow), so every notification attempt is wrapped.
                async function queueAndSend(toEmail, subject, bodyHtml, eventType) {
                    try {
                        const { data: queued } = await supabaseAdmin
                            .from('email_queue')
                            .insert({ to_email: toEmail, subject, body_html: bodyHtml, event_type: eventType, related_id: metadata.listing_id, status: 'pending', attempts: 1 })
                            .select('id')
                            .single();

                        if (resendApiKey && queued) {
                            const emailResponse = await fetch('https://api.resend.com/emails', {
                                method: 'POST',
                                headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
                                body: JSON.stringify({ from: emailFrom, to: toEmail, subject, html: bodyHtml })
                            });
                            await supabaseAdmin
                                .from('email_queue')
                                .update(emailResponse.ok ? { status: 'sent', sent_at: new Date().toISOString() } : { status: 'failed', last_error: await emailResponse.text() })
                                .eq('id', queued.id);
                        }
                    } catch (notifyError) {
                        console.error(`Notification (${eventType}) failed:`, notifyError);
                    }
                }

                const adminInbox = process.env.ADMIN_NOTIFY_EMAIL || 'giftlio.co.nz@gmail.com';
                const saleMode = updatedListing?.sale_mode || 'instant';

                // Admin always gets this, both models -- full visibility
                // into every sale regardless of which side of the business
                // it came from.
                await queueAndSend(
                    adminInbox,
                    `Card Sold: ${metadata.brand} to ${metadata.buyer_name}`,
                    `<p><strong>Retailer:</strong> ${metadata.brand}</p>
                     <p><strong>Face Value:</strong> $${Number(metadata.face_value).toFixed(2)}</p>
                     <p><strong>Sale Price:</strong> $${Number(metadata.sale_price).toFixed(2)}</p>
                     <p><strong>Seller:</strong> ${updatedListing?.seller_name || 'Unknown'} (${saleMode} mode)</p>
                     <p><strong>Buyer:</strong> ${metadata.buyer_name} (${metadata.buyer_email})</p>
                     <p><a href="https://${req.headers.host}/admin">View in admin panel</a></p>`,
                    'card_sold'
                );

                // Seller only hears about this for Marketplace listings --
                // they still own the card until it sells, so this is their
                // business to know. Instant Sell sellers already sold the
                // card to Giftlio at approval time; what happens to it
                // after that (including a resale like this one) isn't
                // theirs to be notified about.
                if (saleMode === 'marketplace' && updatedListing?.seller_id) {
                    const { data: sellerProfile } = await supabaseAdmin.from('profiles').select('email, name').eq('id', updatedListing.seller_id).single();
                    if (sellerProfile?.email) {
                        await queueAndSend(
                            sellerProfile.email,
                            `Your ${metadata.brand} card sold!`,
                            `<p>Hi ${sellerProfile.name || ''},</p>
                             <p>Great news — a buyer just purchased your ${metadata.brand} gift card for $${Number(metadata.sale_price).toFixed(2)}.</p>
                             <p>We'll email you again once your payout has been processed.</p>`,
                            'marketplace_card_sold'
                        );
                    }
                }
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
