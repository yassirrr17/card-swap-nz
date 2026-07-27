(function initializeSupabaseClient() {
    const SUPABASE_URL = window.SUPABASE_URL || window.ENV?.SUPABASE_URL || 'SUPABASE_URL';
    const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || window.ENV?.SUPABASE_ANON_KEY || 'SUPABASE_ANON_KEY';

    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        console.error('Supabase SDK is not loaded.');
        return;
    }

    if (SUPABASE_URL === 'SUPABASE_URL' || SUPABASE_ANON_KEY === 'SUPABASE_ANON_KEY') {
        console.error('Supabase configuration missing. Set SUPABASE_URL and SUPABASE_ANON_KEY.');
        window.supabaseClient = null;
        return;
    }

    window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
        }
    });
})();
