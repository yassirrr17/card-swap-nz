const { createClient } = require('@supabase/supabase-js');

/**
 * Retries every 'failed' row in email_queue (up to 5 attempts each).
 * Triggered manually via a button in the admin panel. A scheduled Vercel
 * Cron job could call this automatically -- not wired up yet, this is the
 * manual version.
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
        return res.status(500).json({ error: 'Notification service is not configured.' });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { data: failedRows, error: fetchError } = await supabaseAdmin
        .from('email_queue')
        .select('*')
        .eq('status', 'failed')
        .lt('attempts', 5);

    if (fetchError) {
        return res.status(500).json({ error: 'Unable to fetch failed emails.' });
    }

    let retried = 0;
    let stillFailed = 0;

    for (const row of failedRows || []) {
        try {
            const emailResponse = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: emailFrom, to: row.to_email, subject: row.subject, html: row.body_html })
            });

            if (!emailResponse.ok) throw new Error(await emailResponse.text());

            await supabaseAdmin
                .from('email_queue')
                .update({ status: 'sent', sent_at: new Date().toISOString(), attempts: row.attempts + 1 })
                .eq('id', row.id);
            retried++;
        } catch (error) {
            await supabaseAdmin
                .from('email_queue')
                .update({ attempts: row.attempts + 1, last_error: String(error).slice(0, 500) })
                .eq('id', row.id);
            stillFailed++;
        }
    }

    return res.status(200).json({ retried, stillFailed, total: (failedRows || []).length });
};
