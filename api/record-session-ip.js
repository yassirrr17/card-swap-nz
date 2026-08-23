const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Capture-only endpoint for the linked-account-detection signal work -- no
// matching/detection logic here, just recording one row per signup/login.
// Never blocks or fails the caller's actual signup/login -- app.js fires
// this fire-and-forget after auth already succeeded.
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed.' });
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const hashPepper = process.env.LINKED_ACCOUNT_HASH_PEPPER;

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
        console.error('Supabase env vars missing -- cannot record session IP.');
        return res.status(500).json({ error: 'Not configured.' });
    }
    // No silent fallback -- an unpepper'd (or differently-peppered) hash
    // would silently break future exact-match correlation across rows, so
    // this must be treated as a hard configuration error, not skipped.
    if (!hashPepper) {
        console.error('LINKED_ACCOUNT_HASH_PEPPER is not set -- cannot record session IP.');
        return res.status(500).json({ error: 'Not configured.' });
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: 'Missing authentication token.' });
    }
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser(token);
    if (userError || !userData?.user) {
        return res.status(401).json({ error: 'Invalid or expired session.' });
    }

    const eventType = req.body?.eventType;
    if (eventType !== 'signup' && eventType !== 'login') {
        return res.status(400).json({ error: 'Invalid eventType.' });
    }

    // Vercel sets x-forwarded-for to "client, proxy1, proxy2..." -- the
    // first entry is the original client. Falls back to the raw socket
    // address, which is only ever Vercel's own edge infra if this header
    // is missing, but that's still better than recording nothing.
    const forwardedFor = req.headers['x-forwarded-for'];
    const ipAddress = (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : null) || req.socket?.remoteAddress || null;

    if (!ipAddress) {
        // Nothing usable to record -- not an error the caller needs to see,
        // this is a best-effort signal.
        return res.status(200).json({ recorded: false });
    }

    const ipAddressHash = crypto.createHmac('sha256', hashPepper).update(ipAddress).digest('hex');

    try {
        const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
        const { error: insertError } = await supabaseAdmin.from('account_ip_events').insert({
            profile_id: userData.user.id,
            ip_address: ipAddress,
            ip_address_hash: ipAddressHash,
            event_type: eventType
        });
        if (insertError) throw insertError;
        return res.status(200).json({ recorded: true });
    } catch (error) {
        console.error('Failed to record session IP event:', error);
        // Still 200 -- this is a capture-only signal, never worth surfacing
        // as a user-facing error on top of a successful signup/login.
        return res.status(200).json({ recorded: false });
    }
};
