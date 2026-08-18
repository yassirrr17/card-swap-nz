const { createClient } = require('@supabase/supabase-js');

/**
 * Retries failed email_queue rows (up to 5 attempts each). If req.body
 * contains emailId, only that one row is retried -- used by the per-row
 * "Retry" button in the admin panel. With no emailId, every failed row
 * is retried -- used by "Retry All Failed". A scheduled Vercel Cron job
 * could call this automatically -- not wired up yet, this is the manual
 * version.
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
        return res.status(500).json({ error: 'Notification service is not configured.' });
    }

    // Step 1: confirm this request carries a valid, current Supabase
    // session token -- same pattern as deliver-order.js.
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

    // Step 2: confirm that verified user is actually an admin, checked
    // server-side via the service-role client -- never trust a role sent
    // in the request body.
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    const { data: profile, error: profileError } = await supabaseAdmin.from('profiles').select('role').eq('id', userData.user.id).single();
    if (profileError || profile?.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required.' });
    }

    const { emailId } = req.body || {};

    let query = supabaseAdmin.from('email_queue').select('*').eq('status', 'failed').lt('attempts', 5);
    query = emailId ? query.eq('id', emailId) : query;

    const { data: failedRows, error: fetchError } = await query;

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
