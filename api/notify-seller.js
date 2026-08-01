const { createClient } = require('@supabase/supabase-js');

/**
 * Sends a transactional email to a SPECIFIC seller (approval/rejection
 * outcome), as opposed to /api/send-notification.js which always sends to
 * the fixed admin inbox. These are deliberately separate: an admin acting
 * on a submission doesn't need to be told about their own action, but the
 * seller who's waiting on an outcome does.
 */
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed.' });
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const resendApiKey = process.env.RESEND_API_KEY;
    const emailFrom = process.env.EMAIL_FROM || 'Giftlio <onboarding@resend.dev>';

    if (!supabaseUrl || !supabaseServiceRoleKey || !resendApiKey) {
        console.error('Seller notification endpoint missing required env vars.');
        return res.status(500).json({ error: 'Notification service is not configured.' });
    }

    const { sellerId, subject, bodyHtml, eventType, relatedId } = req.body || {};

    if (typeof sellerId !== 'string' || !sellerId.trim()) {
        return res.status(400).json({ error: 'sellerId is required.' });
    }
    if (typeof subject !== 'string' || !subject.trim()) {
        return res.status(400).json({ error: 'subject is required.' });
    }
    if (typeof bodyHtml !== 'string' || !bodyHtml.trim()) {
        return res.status(400).json({ error: 'bodyHtml is required.' });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { data: seller, error: sellerError } = await supabaseAdmin.from('profiles').select('email, name, notification_preference').eq('id', sellerId).single();

    if (sellerError || !seller?.email) {
        console.error('Could not find seller email:', sellerError);
        return res.status(400).json({ error: 'Could not find this seller\'s email address.' });
    }

    // payout_only sellers (a Marketplace preference) only want to hear
    // about their money moving -- skip everything else. daily_digest isn't
    // implemented yet (no batching job exists), so it behaves like
    // every_event for now rather than silently dropping notifications.
    const payoutOnlyEvents = ['payout_marked_paid'];
    if (seller.notification_preference === 'payout_only' && !payoutOnlyEvents.includes(eventType)) {
        return res.status(200).json({ success: true, skipped: true, reason: 'seller notification preference is payout_only' });
    }

    const { data: queued, error: queueError } = await supabaseAdmin
        .from('email_queue')
        .insert({
            to_email: seller.email,
            subject,
            body_html: bodyHtml,
            event_type: eventType || 'seller_notification',
            related_id: relatedId || null,
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
            body: JSON.stringify({ from: emailFrom, to: seller.email, subject, html: bodyHtml })
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
