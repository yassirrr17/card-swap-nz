const { createClient } = require('@supabase/supabase-js');
const { EVENTS } = require('../notification-templates.js');

/**
 * Sends an alert to the fixed admin inbox. The client supplies only
 * { eventType, entityId } -- subject and body come from
 * notification-templates.js, composed from a fresh DB read of the entity.
 * There is no client-supplied subject or HTML: an authenticated user can
 * trigger one of these only for an entity they're a genuine party to
 * (their own submission, their own flagged account), or if they're an
 * admin.
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
    const adminInbox = process.env.ADMIN_NOTIFY_EMAIL || 'giftlio.co.nz@gmail.com';

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey || !resendApiKey) {
        console.error('Notification endpoint missing required env vars.');
        return res.status(500).json({ error: 'Notification service is not configured.' });
    }

    // Called both by admin actions and by an ordinary seller's own
    // submission (submission_received) -- can't be admin-only. Requiring a
    // real session at least ties every alert to an identifiable,
    // suspendable account rather than any anonymous caller on the internet.
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
    const callerId = userData.user.id;

    const { eventType, entityId } = req.body || {};
    if (typeof eventType !== 'string' || !eventType.trim()) {
        return res.status(400).json({ error: 'eventType is required.' });
    }
    if (typeof entityId !== 'string' || !entityId.trim()) {
        return res.status(400).json({ error: 'entityId is required.' });
    }

    const eventDef = EVENTS[eventType]?.admin;
    if (!eventDef) {
        return res.status(400).json({ error: `Unknown or unsupported eventType: ${eventType}` });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', callerId).single();
    const isCallerAdmin = profile?.role === 'admin';

    const ctx = await EVENTS[eventType].fetch(supabaseAdmin, entityId);
    if (!ctx) {
        return res.status(404).json({ error: 'This item could not be found.' });
    }

    if (!eventDef.authorize(ctx, callerId, isCallerAdmin)) {
        return res.status(403).json({ error: "You aren't authorized to trigger this notification." });
    }

    const subject = eventDef.subject(ctx, req);
    const bodyHtml = eventDef.body(ctx, req);

    const { data: queued, error: queueError } = await supabaseAdmin
        .from('email_queue')
        .insert({
            to_email: adminInbox,
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
        console.error('Failed to queue notification:', queueError);
        return res.status(500).json({ error: 'Unable to queue notification.' });
    }

    try {
        const emailResponse = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${resendApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ from: emailFrom, to: adminInbox, subject, html: bodyHtml })
        });

        if (!emailResponse.ok) {
            const errorBody = await emailResponse.text();
            throw new Error(errorBody);
        }

        await supabaseAdmin.from('email_queue').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', queued.id);
        return res.status(200).json({ success: true, queued: false });
    } catch (error) {
        console.error('Notification send failed, left queued for retry:', error);
        await supabaseAdmin
            .from('email_queue')
            .update({ status: 'failed', last_error: String(error).slice(0, 500) })
            .eq('id', queued.id);
        // Still 200 -- the notification is safely queued even though the
        // immediate send failed. The caller shows a "queued" warning
        // rather than treating this as a hard failure.
        return res.status(200).json({ success: false, queued: true });
    }
};
