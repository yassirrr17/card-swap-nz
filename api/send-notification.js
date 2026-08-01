const { createClient } = require('@supabase/supabase-js');

/**
 * Reusable admin notification endpoint. Every event type (submission
 * received, approved, rejected, card sold, payout marked paid, and any
 * future alert -- low inventory, suspicious activity, dispute raised)
 * calls this SAME endpoint with a different eventType/subject/body. Adding
 * a new alert type is a one-line call from wherever that event happens,
 * not a new endpoint.
 *
 * Always queues to email_queue first (status: pending), then attempts to
 * send. If sending fails, the row stays queryable as 'failed' for retry
 * (see api/retry-failed-emails.js) instead of the notification silently
 * vanishing.
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
    const adminInbox = process.env.ADMIN_NOTIFY_EMAIL || 'giftlio.co.nz@gmail.com';

    if (!supabaseUrl || !supabaseServiceRoleKey || !resendApiKey) {
        console.error('Notification endpoint missing required env vars.');
        return res.status(500).json({ error: 'Notification service is not configured.' });
    }

    const { eventType, subject, bodyHtml, relatedId } = req.body || {};

    if (typeof eventType !== 'string' || !eventType.trim()) {
        return res.status(400).json({ error: 'eventType is required.' });
    }
    if (typeof subject !== 'string' || !subject.trim()) {
        return res.status(400).json({ error: 'subject is required.' });
    }
    if (typeof bodyHtml !== 'string' || !bodyHtml.trim()) {
        return res.status(400).json({ error: 'bodyHtml is required.' });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { data: queued, error: queueError } = await supabaseAdmin
        .from('email_queue')
        .insert({
            to_email: adminInbox,
            subject,
            body_html: bodyHtml,
            event_type: eventType,
            related_id: relatedId || null,
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
