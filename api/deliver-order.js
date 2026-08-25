const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const { escapeHtml } = require('../notification-templates.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed.' });
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const resendApiKey = process.env.RESEND_API_KEY;
    // Works out of the box with no domain set up -- Resend's own test
    // sender. Once a domain is verified, set EMAIL_FROM in Vercel to
    // something like "Giftlio <noreply@giftlio.co.nz>" instead.
    const emailFrom = process.env.EMAIL_FROM || 'Giftlio <onboarding@resend.dev>';

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
        console.error('Supabase environment variables are not fully configured.');
        return res.status(500).json({ error: 'Server is not configured.' });
    }
    if (!resendApiKey) {
        console.error('RESEND_API_KEY is not configured.');
        return res.status(500).json({ error: 'Email service is not configured.' });
    }
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) {
        console.error('STRIPE_SECRET_KEY is not configured -- cannot verify payment before delivery.');
        return res.status(500).json({ error: 'Payment verification is not configured.' });
    }
    const stripe = new Stripe(stripeSecretKey);

    // Step 1: confirm this request really carries a valid, current
    // Supabase session token -- not just a request shaped like one.
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

    // Step 2: confirm that verified user is actually an admin. Uses the
    // service role client (bypasses RLS) since we're checking BY id we
    // already trust from step 1, not letting the caller assert their own role.
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('role')
        .eq('id', userData.user.id)
        .single();

    if (profileError || profile?.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.' });
    }

    const { orderId } = req.body || {};
    if (!orderId) {
        return res.status(400).json({ error: 'Missing orderId.' });
    }

    try {
        const { data: order, error: orderError } = await supabaseAdmin.from('orders').select('*').eq('id', orderId).single();
        if (orderError || !order) throw orderError || new Error('Order not found.');
        if (order.status === 'delivered') {
            return res.status(400).json({ error: 'This order has already been delivered.' });
        }

        // The DB row alone is never proof this order was actually paid for
        // -- RLS on `orders` only prevents forgery going forward, it can't
        // retroactively vouch for rows or protect against a future bug
        // reintroducing one. The only real proof of payment is Stripe
        // itself: a stripe_session_id that Stripe confirms is paid, for
        // the exact amount this order claims. Every check below runs
        // BEFORE anything is decrypted.
        if (!order.stripe_session_id) {
            console.error(`Delivery blocked: order ${order.id} (${order.public_id}) has no stripe_session_id.`);
            return res.status(400).json({ error: `Order ${order.public_id} has no associated Stripe payment and cannot be delivered.` });
        }

        let stripeSession;
        try {
            stripeSession = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
        } catch (stripeError) {
            console.error(`Failed to retrieve Stripe session ${order.stripe_session_id} for order ${order.id}:`, stripeError);
            return res.status(400).json({ error: `Could not verify payment for order ${order.public_id} with Stripe. Refusing to deliver.` });
        }

        if (stripeSession.payment_status !== 'paid') {
            console.error(`Delivery blocked: Stripe session ${order.stripe_session_id} for order ${order.id} has payment_status="${stripeSession.payment_status}", not "paid".`);
            return res.status(400).json({ error: `Payment for order ${order.public_id} is not confirmed as paid. Refusing to deliver.` });
        }

        const expectedAmountCents = Math.round(Number(order.total) * 100);
        if (stripeSession.amount_total !== expectedAmountCents) {
            console.error(
                `Delivery blocked: Stripe session ${order.stripe_session_id} amount_total=${stripeSession.amount_total} does not match order ${order.id} total=${order.total} (expected ${expectedAmountCents} cents).`
            );
            return res.status(400).json({ error: `Payment amount for order ${order.public_id} does not match its recorded total. Refusing to deliver.` });
        }

        // A card validated once at submission could have been drained by
        // the time it's actually about to be sent -- this must be checked
        // BEFORE anything below decrypts or emails the card, not after.
        // The database has a matching trigger
        // (enforce_balance_check_before_delivery, migration
        // 20260820201500) that blocks the orders.status update itself as a
        // defense-in-depth backstop against a direct API call bypassing
        // this file entirely -- but checking only there would be too late
        // here: this function already decrypts and emails the card BEFORE
        // it ever touches orders.status, so relying solely on that
        // backstop would mean the buyer already has the card by the time
        // the block fires.
        const { data: pricingConfig } = await supabaseAdmin.from('pricing_config').select('balance_check_freshness_hours').eq('id', 1).single();
        const freshnessHours = pricingConfig?.balance_check_freshness_hours;
        if (!freshnessHours) {
            console.error('Delivery blocked: balance_check_freshness_hours is not configured.');
            return res.status(500).json({ error: 'Balance-check configuration is missing. Contact support before retrying.' });
        }
        const freshnessCutoff = new Date(Date.now() - freshnessHours * 60 * 60 * 1000).toISOString();
        const { data: freshCheck, error: freshCheckError } = await supabaseAdmin
            .from('balance_checks')
            .select('id')
            .eq('listing_id', order.listing_id)
            .eq('check_type', 'pre_delivery')
            .eq('status', 'completed')
            .gte('created_at', freshnessCutoff)
            .limit(1)
            .maybeSingle();
        if (freshCheckError) throw freshCheckError;
        if (!freshCheck) {
            return res.status(400).json({
                error: `Order ${order.public_id} needs a fresh pre-delivery balance check (within the last ${freshnessHours} hours) before it can be delivered. Record one from this listing's balance check history first.`
            });
        }

        const { data: listing, error: listingError } = await supabaseAdmin
            .from('listings')
            .select('*')
            .eq('id', order.listing_id)
            .single();
        if (listingError || !listing) throw listingError || new Error('Listing not found for this order.');

        const { data: card, error: cardError } = await supabaseAdmin
            .from('card_vault')
            .select('*')
            .eq('id', listing.card_vault_id)
            .single();
        if (cardError || !card) throw cardError || new Error('Card details not found in vault.');

        // card_vault.card_number/pin are encrypted at rest -- decrypt here,
        // server-side only, right before they go into the email. This is
        // the ONLY place in the whole app the real plaintext values ever
        // exist outside the database.
        //
        // If this ever hits data that isn't valid ciphertext (corrupted,
        // or a row that predates encryption and was never migrated), it
        // fails HERE -- before the email is sent, before order.status is
        // touched, before card_vault.is_redeemed is set. The buyer has
        // already been charged by this point (payment happens at
        // checkout, well before an admin clicks Deliver), so the order is
        // deliberately left in its prior "pending" status rather than
        // "delivered" -- it stays visibly stuck in the admin queue rather
        // than silently succeeding with no card ever sent. This is
        // flagged as a distinct error (not a generic failure) so the
        // admin sees a message telling them not to just retry, and the
        // log line carries every id needed to find and fix the row by
        // hand -- never the ciphertext, never a decrypted value.
        let decryptedCardNumber;
        let decryptedPin = null;
        try {
            const { data: cardNumberValue, error: cardNumError } = await supabaseAdmin.rpc('decrypt_card_value', { ciphertext_base64: card.card_number });
            if (cardNumError) throw cardNumError;
            decryptedCardNumber = cardNumberValue;

            if (card.pin) {
                const { data: pinValue, error: pinError } = await supabaseAdmin.rpc('decrypt_card_value', { ciphertext_base64: card.pin });
                if (pinError) throw pinError;
                decryptedPin = pinValue;
            }
        } catch (decryptError) {
            console.error(
                'Card decryption failed during delivery -- buyer has already been charged and has NOT received a card. ' +
                    `order.id=${order.id} order.public_id=${order.public_id} order.brand=${order.brand} ` +
                    `order.buyer_email=${order.buyer_email} listing.id=${listing.id} card_vault.id=${card.id}`,
                decryptError
            );
            return res.status(500).json({
                error: `Could not decrypt this card's stored details (order ${order.public_id}). This buyer has already been charged and has not received their card. Do not retry -- this needs manual investigation, not another click.`
            });
        }

        // Balance-checker links, using only URLs actually confirmed in the
        // retailer research done earlier -- a broken link in a real email
        // to a real buyer is worse than no link, so brands without a
        // confirmed official page get a safe search fallback instead of a
        // guessed URL.
        const BALANCE_CHECK_URLS = {
            'The Warehouse': 'https://www.thewarehouse.co.nz/gift-card-balance-check.html',
            Woolworths: 'https://giftcardbalance.woolworths.co.nz/en-nz/checkbalance',
            'New World': 'https://www.giftstation.co.nz/',
            "Pak'nSave": 'https://www.giftstation.co.nz/',
            'Noel Leeming': 'https://www.noelleeming.co.nz/gift-card-balance-checker'
        };
        const balanceCheckUrl = BALANCE_CHECK_URLS[order.brand] || `https://www.google.com/search?q=${encodeURIComponent(order.brand + ' gift card balance check')}`;

        const emailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
                <h2 style="color:#10142E;">Your ${escapeHtml(order.brand)} Gift Card</h2>
                <p>Thanks for your purchase from Giftlio! This card was reviewed and approved by our team before it was ever listed. Here are your details:</p>
                <div style="background:#f8f9fa; border-radius:8px; padding:20px; margin: 20px 0;">
                    <p><strong>Card Number:</strong> ${escapeHtml(decryptedCardNumber)}</p>
                    ${decryptedPin ? `<p><strong>PIN:</strong> ${escapeHtml(decryptedPin)}</p>` : ''}
                    <p><strong>Value:</strong> $${Number(card.current_balance).toFixed(2)}</p>
                    <p><strong>Expiry:</strong> ${card.expiry_date ? escapeHtml(card.expiry_date) : 'No expiry'}</p>
                </div>
                <p style="text-align:center; margin: 24px 0;">
                    <a href="${balanceCheckUrl}" style="display:inline-block; background:#10142E; color:#ffffff; padding:12px 24px; border-radius:6px; text-decoration:none; font-weight:bold;">Verify Your Balance</a>
                </p>
                <p>Please verify the balance within 48 hours of receiving this email. If anything's wrong, contact <a href="mailto:support@giftlio.co.nz">support@giftlio.co.nz</a> immediately and we'll make it right.</p>
                <p style="text-align:center;">
                    <a href="mailto:support@giftlio.co.nz?subject=Issue%20with%20order%20${encodeURIComponent(order.public_id)}" style="color:#c0392b; font-size:13px;">Report an Issue with This Card</a>
                </p>
                <p style="color:#999; font-size:12px;">Order ID: ${escapeHtml(order.public_id)}</p>
            </div>
        `;

        const emailResponse = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${resendApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: emailFrom,
                to: order.buyer_email,
                subject: `Your ${order.brand} Gift Card from Giftlio`,
                html: emailHtml
            })
        });

        if (!emailResponse.ok) {
            const errorBody = await emailResponse.text();
            console.error(`Resend API error (order.id=${order.id} order.public_id=${order.public_id}):`, errorBody);
            throw new Error('Failed to send the email.');
        }

        // The email has now genuinely been sent -- the buyer DOES have
        // their card from this point on. If either of these updates
        // fails, that's a bookkeeping problem, not a "buyer got nothing"
        // problem: log it distinctly so it's never mistaken for the
        // decrypt-failure case above, and so nobody re-sends a duplicate
        // email chasing a status that just failed to update.
        try {
            const { error: updateOrderError } = await supabaseAdmin
                .from('orders')
                .update({ status: 'delivered', delivered_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                .eq('id', orderId);
            if (updateOrderError) throw updateOrderError;

            const { error: updateCardError } = await supabaseAdmin.from('card_vault').update({ is_redeemed: true }).eq('id', card.id);
            if (updateCardError) throw updateCardError;
        } catch (postDeliveryError) {
            console.error(
                'Email was sent successfully but a post-delivery update failed -- the buyer HAS their card, but this order may still ' +
                    `show as pending. Fix the order/card_vault status by hand, do NOT resend the email. ` +
                    `order.id=${order.id} order.public_id=${order.public_id} card_vault.id=${card.id}`,
                postDeliveryError
            );
            return res.status(500).json({
                error: `The card was emailed successfully, but order ${order.public_id}'s status failed to update. The buyer already has their card -- do not click Deliver again. This needs a manual status fix.`
            });
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error(`Failed to deliver order (orderId=${orderId}):`, error);
        return res.status(500).json({ error: 'Unable to deliver this order. Please try again.' });
    }
};
