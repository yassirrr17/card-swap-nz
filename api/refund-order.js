const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

// Admin-triggered refund. This endpoint only ever calls Stripe -- it does
// NOT write orders.status itself. The webhook's charge.refunded handler
// (api/webhook.js) is the single source of truth for that transition, so
// there is exactly one code path that can ever set status='refunded',
// whether the refund came from here, the Stripe dashboard, or anywhere
// else. This avoids two different code paths racing to update the same
// row.
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed.' });
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
        console.error('Supabase environment variables are not fully configured.');
        return res.status(500).json({ error: 'Server is not configured.' });
    }
    if (!stripeSecretKey) {
        console.error('STRIPE_SECRET_KEY is not configured -- cannot issue a refund.');
        return res.status(500).json({ error: 'Payment processing is not configured.' });
    }
    const stripe = new Stripe(stripeSecretKey);

    // Same two-step pattern as api/deliver-order.js and
    // api/retry-failed-emails.js: verify the caller's own session token,
    // then re-check their role server-side via the service-role client --
    // never trust a client-asserted role.
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

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    const { data: profile, error: profileError } = await supabaseAdmin.from('profiles').select('role').eq('id', userData.user.id).single();
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

        if (order.status === 'refunded') {
            return res.status(400).json({ error: `Order ${order.public_id} has already been refunded.` });
        }
        if (!order.stripe_payment_intent_id) {
            return res.status(400).json({ error: `Order ${order.public_id} has no associated Stripe payment intent and cannot be refunded through Stripe.` });
        }

        await stripe.refunds.create({ payment_intent: order.stripe_payment_intent_id });

        // Deliberately not updating orders.status here -- see the comment
        // at the top of this file. Stripe's charge.refunded webhook event
        // will flip it to 'refunded' once the refund actually settles,
        // which is also when the seller's payout gets blocked (Task 3
        // treats a refunded order the same as an open dispute).
        return res.status(200).json({ success: true, message: `Refund submitted for order ${order.public_id}. Its status will update automatically once Stripe confirms it.` });
    } catch (error) {
        console.error(`Failed to refund order (orderId=${orderId}):`, error);
        return res.status(500).json({ error: 'Unable to issue this refund. Please try again.' });
    }
};
