const { createClient } = require('@supabase/supabase-js');

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
        const { data: decryptedCardNumber, error: cardNumError } = await supabaseAdmin.rpc('decrypt_card_value', { ciphertext_base64: card.card_number });
        if (cardNumError) throw cardNumError;
        let decryptedPin = null;
        if (card.pin) {
            const { data: pinValue, error: pinError } = await supabaseAdmin.rpc('decrypt_card_value', { ciphertext_base64: card.pin });
            if (pinError) throw pinError;
            decryptedPin = pinValue;
        }

        const emailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
                <h2 style="color:#1a237e;">Your ${order.brand} Gift Card</h2>
                <p>Thanks for your purchase from Giftlio! Here are your gift card details:</p>
                <div style="background:#f8f9fa; border-radius:8px; padding:20px; margin: 20px 0;">
                    <p><strong>Card Number:</strong> ${decryptedCardNumber}</p>
                    ${decryptedPin ? `<p><strong>PIN:</strong> ${decryptedPin}</p>` : ''}
                    <p><strong>Value:</strong> $${Number(card.current_balance).toFixed(2)}</p>
                    <p><strong>Expiry:</strong> ${card.expiry_date}</p>
                </div>
                <p>Please verify the balance within 24 hours of receiving this email and contact support@giftlio.co.nz immediately if there's any issue.</p>
                <p style="color:#999; font-size:12px;">Order ID: ${order.public_id}</p>
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
            console.error('Resend API error:', errorBody);
            throw new Error('Failed to send the email.');
        }

        const { error: updateOrderError } = await supabaseAdmin
            .from('orders')
            .update({ status: 'delivered', updated_at: new Date().toISOString() })
            .eq('id', orderId);
        if (updateOrderError) throw updateOrderError;

        const { error: updateCardError } = await supabaseAdmin.from('card_vault').update({ is_redeemed: true }).eq('id', card.id);
        if (updateCardError) throw updateCardError;

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('Failed to deliver order:', error);
        return res.status(500).json({ error: 'Unable to deliver this order. Please try again.' });
    }
};
