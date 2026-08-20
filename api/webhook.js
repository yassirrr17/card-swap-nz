const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const GiftlioPricing = require('../pricing-helper.js');

// Fallback ONLY -- used when Stripe's actual balance transaction fee isn't
// yet available (rare, but the balance transaction can lag a few seconds
// behind the charge). This is a rough, generic NZD card-present rate, NOT
// Giftlio's actual negotiated Stripe rate -- rows using this are always
// marked stripe_fee_is_estimated = true so the admin dashboard and anyone
// reading the orders table can tell an estimate from Stripe's real number.
const ESTIMATED_STRIPE_FEE_RATE = 0.029;
const ESTIMATED_STRIPE_FEE_FIXED = 0.3;

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
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
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
            const salePrice = Number(metadata.sale_price);

            // Gross commission: uses the rate THIS listing was actually
            // priced with (passed through from create-checkout.js's
            // metadata, itself read from the listing row, never the
            // client) -- via the shared pricing helper, same as every
            // other place commission is calculated. Instant Sell listings
            // have no commission_rate at all, so this stays null for them
            // by design, not zero.
            let grossCommission = null;
            if (metadata.sale_mode === 'marketplace' && metadata.commission_rate) {
                const commissionRateFraction = Number(metadata.commission_rate) / 100;
                const payout = GiftlioPricing.calculateMarketplacePayout(salePrice, commissionRateFraction);
                if (!payout.error) grossCommission = payout.commission;
            }

            // Stripe's own reported fee from the charge's balance
            // transaction -- the real number, not an estimate, whenever
            // it's available. Falls back to a rough estimate (flagged)
            // only if the balance transaction isn't ready yet or the
            // lookup fails for any reason -- this must never block order
            // creation, a buyer who already paid needs their order row
            // regardless of whether the fee lookup succeeded.
            let stripeFee = null;
            let stripeFeeIsEstimated = null;
            try {
                const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent, {
                    expand: ['latest_charge.balance_transaction']
                });
                const balanceTransaction = paymentIntent?.latest_charge?.balance_transaction;
                if (balanceTransaction && typeof balanceTransaction.fee === 'number') {
                    stripeFee = Math.round(balanceTransaction.fee) / 100;
                    stripeFeeIsEstimated = false;
                }
            } catch (feeError) {
                console.warn(`Unable to fetch Stripe's actual fee for session ${session.id}, falling back to an estimate:`, feeError.message);
            }
            if (stripeFee === null) {
                stripeFee = Math.round((salePrice * ESTIMATED_STRIPE_FEE_RATE + ESTIMATED_STRIPE_FEE_FIXED) * 100) / 100;
                stripeFeeIsEstimated = true;
            }

            const netContribution = grossCommission !== null ? Math.round((grossCommission - stripeFee) * 100) / 100 : null;

            const { error: orderError } = await supabaseAdmin.from('orders').insert({
                public_id: generatePublicOrderId(session.id),
                listing_id: metadata.listing_id,
                buyer_id: metadata.buyer_id,
                buyer_name: metadata.buyer_name,
                buyer_email: metadata.buyer_email,
                buyer_phone: metadata.buyer_phone,
                brand: metadata.brand,
                face_value: Number(metadata.face_value),
                sale_price: salePrice,
                service_fee: 0,
                total: salePrice,
                status: 'pending_verification',
                stripe_session_id: session.id,
                // charge.refunded / charge.dispute.created events carry a
                // payment intent (or a charge, which itself references one),
                // never a Checkout Session id -- without this column there
                // is no way for those handlers below to find the order they
                // belong to.
                stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
                gross_commission: grossCommission,
                stripe_fee: stripeFee,
                stripe_fee_is_estimated: stripeFeeIsEstimated,
                net_contribution: netContribution
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
                // The listing was moved active->reserved atomically at
                // Checkout-session creation (api/create-checkout.js), so
                // the only legal transition into 'sold' is FROM 'reserved'
                // -- not 'active'. reserved_by is checked too: harmless in
                // the normal case (only one buyer can ever hold the
                // reservation), but it means this update can never
                // accidentally claim a listing for the wrong buyer if
                // reservation state was ever manipulated out of band.
                const { data: updatedListing, error: listingError } = await supabaseAdmin
                    .from('listings')
                    .update({ status: 'sold', sold_at: new Date().toISOString(), updated_at: new Date().toISOString(), reserved_at: null, reserved_by: null })
                    .eq('id', metadata.listing_id)
                    .eq('status', 'reserved')
                    .eq('reserved_by', metadata.buyer_id)
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

    // A buyer's card issuer/Stripe refunded the charge. This is the ONLY
    // place orders.status is ever set to 'refunded' -- whether the refund
    // was triggered by an admin (api/refund-order.js calls
    // stripe.refunds.create, but does not touch the DB itself -- this event
    // is what actually finalizes the order's state) or done directly in the
    // Stripe dashboard outside this app entirely.
    if (event.type === 'charge.refunded') {
        const charge = event.data.object;
        const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
        if (paymentIntentId) {
            const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
            // Idempotent by construction: only ever moves a non-refunded
            // order to refunded. A replayed event, or a second partial
            // refund on the same charge, is a no-op here rather than a
            // double-transition.
            const { error: refundUpdateError } = await supabaseAdmin
                .from('orders')
                .update({ status: 'refunded', updated_at: new Date().toISOString() })
                .eq('stripe_payment_intent_id', paymentIntentId)
                .neq('status', 'refunded');
            if (refundUpdateError) {
                console.error(`Failed to mark order as refunded for payment_intent ${paymentIntentId}:`, refundUpdateError);
                return res.status(500).send('Failed to process refund.');
            }
        }
        return res.status(200).json({ received: true });
    }

    // A card-network chargeback -- the buyer's bank is disputing the charge
    // directly with Stripe, separate from anything happening in this app.
    // Auto-creates a disputes row (source='stripe_chargeback') via
    // enforce_dispute_insert() -- NOT subject to that trigger's
    // delivered/claim-window rules for a genuine buyer report, since a
    // chargeback can land regardless of delivery status. An open dispute of
    // either source blocks payout release (Task 3).
    if (event.type === 'charge.dispute.created') {
        const dispute = event.data.object;
        const paymentIntentId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id;
        if (paymentIntentId) {
            const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
            const { data: order } = await supabaseAdmin
                .from('orders')
                .select('id, public_id, buyer_id, brand, total')
                .eq('stripe_payment_intent_id', paymentIntentId)
                .maybeSingle();

            if (order) {
                const { error: disputeInsertError } = await supabaseAdmin.from('disputes').insert({
                    order_id: order.id,
                    buyer_id: order.buyer_id,
                    source: 'stripe_chargeback',
                    buyer_message: `Stripe chargeback opened by the buyer's card issuer (dispute ${dispute.id}, reason: ${dispute.reason || 'unknown'}).`
                });

                // enforce_dispute_insert() raises an exception if an
                // open/investigating dispute already exists for this order
                // -- expected and harmless on a replayed event, not a
                // failure to surface.
                if (disputeInsertError && !/already an open dispute/i.test(disputeInsertError.message || '')) {
                    console.error(`Failed to auto-create dispute for chargeback on order ${order.public_id}:`, disputeInsertError);
                    return res.status(500).send('Failed to process chargeback.');
                }

                if (!disputeInsertError) {
                    const resendApiKey = process.env.RESEND_API_KEY;
                    const emailFrom = process.env.EMAIL_FROM || 'Giftlio <onboarding@resend.dev>';
                    const adminInbox = process.env.ADMIN_NOTIFY_EMAIL || 'giftlio.co.nz@gmail.com';
                    const bodyHtml = `<p><strong>A card-network chargeback was opened for order ${order.public_id}.</strong></p>
                         <p><strong>Brand:</strong> ${order.brand}</p>
                         <p><strong>Amount:</strong> $${Number(order.total).toFixed(2)}</p>
                         <p>This order's payout is now blocked until the dispute is resolved. <a href="https://${req.headers.host}/admin">View in admin panel</a></p>`;
                    try {
                        const { data: queued } = await supabaseAdmin
                            .from('email_queue')
                            .insert({ to_email: adminInbox, subject: `Chargeback opened: order ${order.public_id}`, body_html: bodyHtml, event_type: 'chargeback_opened', related_id: order.id, status: 'pending', attempts: 1 })
                            .select('id')
                            .single();
                        if (resendApiKey && queued) {
                            const emailResponse = await fetch('https://api.resend.com/emails', {
                                method: 'POST',
                                headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
                                body: JSON.stringify({ from: emailFrom, to: adminInbox, subject: `Chargeback opened: order ${order.public_id}`, html: bodyHtml })
                            });
                            await supabaseAdmin
                                .from('email_queue')
                                .update(emailResponse.ok ? { status: 'sent', sent_at: new Date().toISOString() } : { status: 'failed', last_error: await emailResponse.text() })
                                .eq('id', queued.id);
                        }
                    } catch (notifyError) {
                        console.error('Chargeback admin notification failed:', notifyError);
                    }
                }
            } else {
                console.warn(`charge.dispute.created for payment_intent ${paymentIntentId} but no matching order was found.`);
            }
        }
        return res.status(200).json({ received: true });
    }

    // A Checkout Session that was never completed -- the buyer abandoned it,
    // or it simply hit its expires_at (set to match the listing reservation
    // TTL in api/create-checkout.js). Release the reservation immediately
    // rather than waiting for the next buyer's lazy sweep to notice it.
    // Guarded on status='reserved' AND reserved_by=this buyer so a listing
    // that has since legitimately sold (or been re-reserved after this
    // session's own TTL window) is never touched by a late-arriving event.
    if (event.type === 'checkout.session.expired') {
        const session = event.data.object;
        const metadata = session.metadata || {};
        if (metadata.listing_id && metadata.buyer_id) {
            const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
            const { error: releaseError } = await supabaseAdmin
                .from('listings')
                .update({ status: 'active', reserved_at: null, reserved_by: null, updated_at: new Date().toISOString() })
                .eq('id', metadata.listing_id)
                .eq('status', 'reserved')
                .eq('reserved_by', metadata.buyer_id);
            if (releaseError) {
                console.error(`Failed to release expired reservation for listing ${metadata.listing_id}:`, releaseError);
                // Non-fatal: the lazy sweep (release_stale_reservations, called
                // from create-checkout.js) will still catch this once the TTL
                // window passes. Still return 200 -- retrying this exact event
                // won't help if the update itself is the problem.
            }
        }
        return res.status(200).json({ received: true });
    }

    // Any other event type is intentionally ignored -- must still return
    // 200 so Stripe doesn't keep retrying it forever.
    return res.status(200).json({ received: true });
};
