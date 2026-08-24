const { createClient } = require('@supabase/supabase-js');
const { EVENTS } = require('../notification-templates.js');

/**
 * Sends a transactional email to whichever real party a given event's
 * recipient actually is (a seller for a submission outcome, a buyer for an
 * offer response, etc). The client supplies only { eventType, entityId } --
 * the recipient address, the authorization check, and every word of the
 * email body come from notification-templates.js reading the entity fresh
 * from the DB. There is no client-supplied recipient, subject, or HTML: an
 * authenticated user can trigger one of these emails only for an entity
 * they're a genuine party to, with content this server wrote.
 */
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed.' });
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const resendApiKey = process.env.RESEND_API_KEY;
    const emailFrom = process.env.EMAIL_FROM || 'Giftlio <onboarding@resend.dev>';

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey || !resendApiKey) {
        console.error('Seller notification endpoint missing required env vars.');
        return res.status(500).json({ error: 'Notification service is not configured.' });
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
        console.error('notify-seller 401: no Bearer token on request.');
        return res.status(401).json({ error: 'Missing authentication token.' });
    }
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser(token);
    if (userError || !userData?.user) {
        console.error('notify-seller 401: token did not resolve to a user.', userError?.message || 'no user on response');
        return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
    }
    const callerId = userData.user.id;

    const { eventType, entityId } = req.body || {};
    if (typeof eventType !== 'string' || !eventType.trim()) {
        console.error('notify-seller 400: eventType missing from request body.', JSON.stringify(req.body));
        return res.status(400).json({ error: 'eventType is required.' });
    }
    if (typeof entityId !== 'string' || !entityId.trim()) {
        console.error(`notify-seller 400: entityId missing from request body for eventType=${eventType}.`, JSON.stringify(req.body));
        return res.status(400).json({ error: 'entityId is required.' });
    }

    const eventDef = EVENTS[eventType]?.seller;
    if (!eventDef) {
        console.error(`notify-seller 400: no seller-half event definition for eventType=${eventType}.`);
        return res.status(400).json({ error: `Unknown or unsupported eventType: ${eventType}` });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const isCallerAdmin = async () => {
        const { data: profile, error: profileError } = await supabaseAdmin.from('profiles').select('role').eq('id', callerId).single();
        if (profileError) {
            console.error(`notify-seller: profile lookup failed for callerId=${callerId}.`, profileError.message);
        }
        return profile?.role === 'admin';
    };

    const ctx = await EVENTS[eventType].fetch(supabaseAdmin, entityId);
    if (!ctx) {
        console.error(`notify-seller 404: fetch() returned no context for eventType=${eventType} entityId=${entityId}.`);
        return res.status(404).json({ error: 'This item could not be found.' });
    }

    const admin = await isCallerAdmin();
    if (!eventDef.authorize(ctx, callerId, admin)) {
        console.error(
            `notify-seller 403: authorize() rejected callerId=${callerId} (isAdmin=${admin}) for eventType=${eventType} entityId=${entityId}, ctx.seller_id=${ctx.seller_id}, ctx.buyer_id=${ctx.buyer_id}.`
        );
        return res.status(403).json({ error: "You aren't authorized to trigger this notification." });
    }

    const recipientEmail = eventDef.recipientEmail(ctx);
    if (!recipientEmail) {
        console.error(`notify-seller 400: no recipient email resolved for eventType=${eventType} entityId=${entityId}.`);
        return res.status(400).json({ error: 'Could not resolve a recipient for this notification.' });
    }

    // payout_only sellers (a Marketplace preference) only want to hear
    // about their money moving -- skip everything else. daily_digest isn't
    // implemented yet (no batching job exists), so it behaves like
    // every_event for now rather than silently dropping notifications.
    const payoutOnlyEvents = ['payout_marked_paid', 'marketplace_payout_released'];
    if (eventDef.recipientPreference?.(ctx) === 'payout_only' && !payoutOnlyEvents.includes(eventType)) {
        console.error(
            `notify-seller 200 skipped: recipientPreference=payout_only for eventType=${eventType} entityId=${entityId}, recipient=${recipientEmail}.`
        );
        return res.status(200).json({ success: true, skipped: true, reason: 'recipient notification preference is payout_only' });
    }

    const subject = eventDef.subject(ctx, req);
    const bodyHtml = eventDef.body(ctx, req);

    const { data: queued, error: queueError } = await supabaseAdmin
        .from('email_queue')
        .insert({
            to_email: recipientEmail,
            subject,
            body_html: bodyHtml,
            event_type: eventType,
            related_id: entityId,
            status: 'pending',
            attempts: 1
        })
        .select('id')
        .single();

    if (queueError) {
        console.error('Failed to queue seller notification:', queueError);
        return res.status(500).json({ error: 'Unable to queue notification.' });
    }

    try {
        const emailResponse = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: emailFrom, to: recipientEmail, subject, html: bodyHtml })
        });

        if (!emailResponse.ok) throw new Error(await emailResponse.text());

        await supabaseAdmin.from('email_queue').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', queued.id);
        return res.status(200).json({ success: true, queued: false });
    } catch (error) {
        console.error('Seller notification send failed, left queued for retry:', error);
        await supabaseAdmin.from('email_queue').update({ status: 'failed', last_error: String(error).slice(0, 500) }).eq('id', queued.id);
        return res.status(200).json({ success: false, queued: true });
    }
};
