const DEFAULT_CHECKOUT_STEP = 1;
const MAX_CHECKOUT_STEP = 4;
const MARKETPLACE_COMMISSION_RATE = 0.10;

const TOAST_ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>'
};

/**
 * Shows a toast notification. type: 'success' | 'error' | 'warning' | 'info'
 * Replaces alert() throughout the app so nothing blocks the UI with a browser dialog.
 */
function showToast(type, message, duration = 5000) {
    const container = document.getElementById('toastContainer');
    if (!container) {
        // Fallback in the unlikely event the container isn't in the DOM yet
        console.warn('Toast container missing, falling back to console:', message);
        return;
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
        <span class="toast-message"></span>
        <button class="toast-close" aria-label="Dismiss notification">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
        </button>
    `;
    toast.querySelector('.toast-message').textContent = message;

    const remove = () => {
        toast.classList.add('closing');
        setTimeout(() => toast.remove(), 200);
    };
    toast.querySelector('.toast-close').addEventListener('click', remove);
    const timer = setTimeout(remove, duration);
    toast.addEventListener('mouseenter', () => clearTimeout(timer));

    container.appendChild(toast);
}

/** Escapes a value for safe embedding inside a single-quoted JS string
    literal within an inline HTML event handler attribute (onclick="...").
    Needed because escapeHtml alone doesn't protect against this -- the
    browser HTML-decodes attribute values BEFORE handing them to the JS
    engine, so an HTML-escaped apostrophe still becomes a raw apostrophe by
    the time it reaches the JS parser and breaks the string literal. */
function escapeJsString(str) {
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const AppState = {
    currentUser: null,
    currentListing: null,
    checkoutStep: DEFAULT_CHECKOUT_STEP,
    currentOrder: null,
    activeCategory: null,
    brandDiscounts: {},
    auditLogRows: [],
    allListings: []
};

/**
 * Fetches every brand's current discount percentage from the database and
 * caches it in AppState. Called fresh whenever admin approval or the brand
 * discount management page needs current values, so a change an admin just
 * saved takes effect on the very next approval -- no redeploy, no stale
 * in-memory copy from page load.
 */
/**
 * Fetches every brand's current discount percentage AND Instant Sell
 * availability from the database, caching in AppState. Always called fresh
 * (never assumed still valid from an earlier load) anywhere it matters --
 * admin approval, the sell form, and the brand discounts admin page --
 * so a change an admin just saved takes effect on the very next read, no
 * stale in-memory copy and no redeploy.
 */
/**
 * Subscribes to live changes on brand_discounts via Supabase Realtime,
 * set up once at app startup. This is what makes an admin's saved change
 * reach an ALREADY-OPEN Sell page or admin table instantly -- re-fetching
 * on navigation (which renderSellPage/renderBrandDiscountsTable already do)
 * only helps a page opened AFTER the change; this covers the page that was
 * already sitting open when the change happened, with no refresh, no
 * re-navigation, nothing for the user to do.
 */
function subscribeToBrandDiscountChanges() {
    supabaseClient
        .channel('brand_discounts_live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'brand_discounts' }, async () => {
            await loadBrandDiscounts();

            // If the Sell page is the one currently visible, refresh its
            // tile picker and live offer estimate immediately.
            const sellSection = document.getElementById('sell-section');
            if (sellSection && !sellSection.classList.contains('hidden')) {
                populateBrandDropdown();
                updateOffer();
            }

            // Browse grid: re-run the current filters so cards immediately
            // reflect the new discount % / availability badge, with no
            // page reload and no re-navigation needed.
            const browseSection = document.getElementById('browse-section');
            if (browseSection && !browseSection.classList.contains('hidden')) {
                applyFilters();
            }

            // Listing detail page: re-render so the Buy Now button and
            // availability badge update live if someone's looking at a
            // listing whose retailer just got toggled.
            const listingSection = document.getElementById('listing-detail-section');
            if (listingSection && !listingSection.classList.contains('hidden') && AppState.currentListing) {
                viewListing(AppState.currentListing.id, { historyMode: 'none' });
            }

            // If the admin's Brand Discounts table is currently visible,
            // refresh it too, so a second admin (or a second tab) sees the
            // other's change live.
            const brandTable = document.getElementById('brandDiscountsTable');
            if (brandTable && brandTable.closest('.page-section') && !brandTable.closest('.page-section').classList.contains('hidden')) {
                await renderBrandDiscountsTable();
            }
        })
        .subscribe();
}

async function loadBrandDiscounts() {
    const { data, error } = await supabaseClient.from('brand_discounts').select('brand, discount_percent, instant_sell_available, retailer_enabled');
    if (error) {
        console.error('Failed to load brand discounts:', error);
        return AppState.brandDiscounts;
    }
    const map = {};
    (data || []).forEach((row) => {
        map[row.brand] = {
            discountPercent: Number(row.discount_percent),
            instantSellAvailable: row.instant_sell_available !== false,
            // The authoritative whole-retailer toggle. Every page that
            // needs to know "can this retailer be bought or sold right
            // now" reads THIS field, from THIS single loader -- never a
            // locally cached copy, never a hardcoded assumption.
            retailerEnabled: row.retailer_enabled !== false
        };
    });
    AppState.brandDiscounts = map;
    return map;
}

function toggleSafeItem(button) {
    const item = button.closest('.safe-item');
    const isOpen = item.classList.contains('open');
    item.classList.toggle('open', !isOpen);
    button.setAttribute('aria-expanded', String(!isOpen));
}

async function handleNavSearch(query) {
    if (!query.trim()) return;
    const browseSearchInput = document.getElementById('searchInput');
    if (browseSearchInput) browseSearchInput.value = query;
    await router('browse');
}

/**
 * Called when a "Browse by Retailer" tile is clicked. Navigates to Browse
 * and pre-filters results down to just that retailer. The search value is
 * set BEFORE navigating, since router('browse') already triggers
 * applyFilters() internally via renderBrowse() -- setting it first means
 * that first render is already correctly filtered, with no flash of
 * unfiltered results and no redundant second fetch.
 */
/**
 * Navigate to Browse fresh, with any previous search/filter cleared. Used by
 * every plain "Browse Cards" entry point (nav, hero, CTAs, empty states) so
 * a stale filter from a previous retailer-tile click never leaks into a
 * general browse visit. filterByBrand() is the one deliberate exception --
 * it sets the search value on purpose.
 */
function goToBrowse() {
    const input = document.getElementById('searchInput');
    if (input) input.value = '';
    AppState.activeCategory = null;
    router('browse');
}

async function filterByBrand(brand) {
    const browseSearchInput = document.getElementById('searchInput');
    if (browseSearchInput) browseSearchInput.value = brand;
    await router('browse');
}

const PAGE_SECTION_MAP = {
    home: 'home-section',
    browse: 'browse-section',
    listing: 'listing-detail-section',
    checkout: 'checkout-section',
    login: 'login-section',
    signup: 'signup-section',
    'forgot-password': 'forgot-password-section',
    'reset-password': 'reset-password-section',
    orders: 'my-orders-section',
    'seller-dashboard': 'seller-dashboard-section',
    sell: 'sell-section',
    admin: 'admin-section',
    privacy: 'privacy-section',
    terms: 'terms-section',
    'how-it-works': 'how-it-works-section',
    contact: 'contact-section',
    about: 'about-section',
    'not-found': 'not-found-section'
};

/* Clean-URL routing (History API). Every page above maps to a real path;
   vercel.json rewrites all non-static/non-api paths to index.html so these
   resolve correctly on hard refresh and direct link too. */
const PAGE_TO_PATH = {
    home: '/',
    browse: '/browse',
    listing: '/listing',
    checkout: '/checkout',
    login: '/login',
    signup: '/signup',
    'forgot-password': '/forgot-password',
    'reset-password': '/reset-password',
    orders: '/my-orders',
    'seller-dashboard': '/seller-dashboard',
    sell: '/sell',
    admin: '/admin-dashboard',
    privacy: '/privacy',
    terms: '/terms',
    'how-it-works': '/how-it-works',
    contact: '/contact',
    about: '/about',
    'not-found': '/404'
};

const PATH_TO_PAGE = Object.fromEntries(Object.entries(PAGE_TO_PATH).map(([page, path]) => [path, page]));

const PAGE_TITLES = {
    home: "Giftlio | New Zealand's Gift Card Marketplace",
    browse: 'Browse Gift Cards — Giftlio',
    listing: 'Gift Card Details — Giftlio',
    checkout: 'Checkout — Giftlio',
    login: 'Log In — Giftlio',
    signup: 'Create Account — Giftlio',
    'forgot-password': 'Reset Password — Giftlio',
    'reset-password': 'Set New Password — Giftlio',
    orders: 'My Orders — Giftlio',
    'seller-dashboard': 'Seller Dashboard — Giftlio',
    sell: 'Sell a Gift Card — Giftlio',
    admin: 'Admin — Giftlio',
    privacy: 'Privacy Policy — Giftlio',
    terms: 'Terms &amp; Conditions — Giftlio',
    'how-it-works': 'How It Works — Giftlio',
    contact: 'Contact Us — Giftlio',
    about: 'About Giftlio',
    'not-found': 'Page Not Found — Giftlio'
};

function setPageTitle(page) {
    const raw = PAGE_TITLES[page] || PAGE_TITLES.home;
    // Titles are defined with HTML entities above for readability; decode
    // for the actual document.title (not rendered as HTML there).
    const el = document.createElement('textarea');
    el.innerHTML = raw;
    document.title = el.value;
}

/**
 * Category groupings. Categories are NOT a real column in the database --
 * listings only have a `brand`. Each category here is just a curated group
 * of retailers, with an honest note on how balance verification actually
 * works for that group (matters for buyer trust, per real research into
 * each retailer's balance-check process).
 */
const CATEGORIES = {
    'food-groceries': {
        label: 'Food & Groceries',
        brands: ['Woolworths', 'New World'],
        keywords: ['food', 'grocery', 'groceries', 'supermarket'],
        verification: 'manual',
        note: 'New World balance checks require a Foodstuffs account or in-store verification, so these cards are confirmed through our manual process.'
    },
    'retail-fashion': {
        label: 'Retail & Fashion',
        brands: ['The Warehouse', 'Farmers', 'Briscoes'],
        keywords: ['retail', 'fashion', 'clothing', 'clothes'],
        verification: 'instant',
        note: 'All three retailers have official online balance checkers.'
    },
    'home-garden': {
        label: 'Home & Garden',
        brands: ['The Warehouse', 'Briscoes'],
        keywords: ['home', 'garden', 'homeware'],
        verification: 'instant',
        note: 'Both retailers stock homeware and have official online balance checkers.'
    },
    electronics: {
        label: 'Electronics',
        brands: ['Noel Leeming', 'PB Tech'],
        keywords: ['electronics', 'tech', 'technology', 'gadgets'],
        verification: 'manual',
        note: 'PB Tech requires adding an item to cart and applying the card to check balance -- more manual, but still verifiable.'
    },
    'health-beauty': {
        label: 'Health & Beauty',
        brands: ['Farmers'],
        keywords: ['health', 'beauty', 'cosmetics', 'makeup'],
        verification: 'instant',
        note: 'Farmers stocks beauty products alongside fashion, with an official online balance checker.'
    }
};

const BRAND_COLORS = {
    'The Warehouse': '#E4002B',
    Woolworths: '#1B7339',
    'New World': '#00843d',
    Farmers: '#E6007E',
    'Noel Leeming': '#0033a0',
    Briscoes: '#e31837',
    'Rebel Sport': '#1a1a1a',
    'PB Tech': '#ff6600',
    "Pak'nSave": '#FFD100'
};

// Pak'nSave is yellow-and-black, not yellow-and-white -- badge text color
// needs to flip for this one brand so it's actually readable/on-brand.
const BRAND_TEXT_COLORS = {
    "Pak'nSave": '#000000'
};

/**
 * Renders a retailer badge: bold retailer name on their real brand color.
 * We can't embed actual trademarked retailer logos (Wikimedia's licence for
 * those images doesn't extend to commercial reuse in an unaffiliated
 * marketplace product), so this styled text badge is the permanent,
 * legally-safe treatment -- not a temporary fallback. max-height: 40px per
 * spec, sized to sit cleanly in a card header.
 */
function retailerBadgeHTML(brand) {
    const safeBrand = escapeHtml(brand);
    const color = BRAND_COLORS[brand] || '#10142E';
    const textColor = BRAND_TEXT_COLORS[brand] || '#ffffff';
    return `<span class="retailer-badge" style="background:${color};color:${textColor}">${safeBrand}</span>`;
}

const STATUS_MAP = {
    submission: {
        pending_review: 'Pending Review',
        approved: 'Approved',
        rejected: 'Rejected',
        listed: 'Listed',
        sold: 'Sold'
    },
    order: {
        pending_verification: 'Pending Verification',
        delivered: 'Delivered',
        refunded: 'Refunded'
    },
    listing: {
        active: 'active',
        sold: 'sold',
        inactive: 'inactive'
    }
};

let loadingCount = 0;

function formatCurrency(value = 0) {
    return `$${Number(value).toFixed(2)}`;
}

function escapeHtml(value = '') {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('\"', '&quot;')
        .replaceAll("'", "&#39;");
}

function generatePublicId(prefix) {
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cryptoObj = window.crypto;

    if (cryptoObj?.randomUUID) {
        return `${prefix}-${datePart}-${cryptoObj.randomUUID().split('-')[0].toUpperCase()}`;
    }

    if (!cryptoObj?.getRandomValues) {
        throw new Error('Secure random generator is unavailable in this browser.');
    }

    const randomBytes = new Uint8Array(8);
    cryptoObj.getRandomValues(randomBytes);
    const randomPart = Array.from(randomBytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `${prefix}-${datePart}-${randomPart}`;
}

function normalizeCheckoutStep(step) {
    if (step === null || step === undefined || step === '') return DEFAULT_CHECKOUT_STEP;
    const parsedStep = parseInt(step, 10);
    if (isNaN(parsedStep)) return DEFAULT_CHECKOUT_STEP;
    return Math.max(DEFAULT_CHECKOUT_STEP, Math.min(MAX_CHECKOUT_STEP, parsedStep));
}

function getPageFromPath() {
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    return PATH_TO_PAGE[path] || 'not-found';
}

function buildRouteState(page, routeState = {}) {
    const state = {};

    if (page === 'listing' && AppState.currentListing) {
        state.listingId = AppState.currentListing.id;
    }

    if (page === 'checkout') {
        state.checkoutStep = AppState.checkoutStep;
        if (AppState.currentOrder) {
            state.currentOrder = AppState.currentOrder;
        } else if (AppState.currentListing) {
            state.listingId = AppState.currentListing.id;
        }
    }

    return { ...state, ...routeState, page };
}

function syncHistory(page, historyMode = 'replace', routeState = null) {
    setPageTitle(page);
    if (historyMode === 'none') return;

    const nextState = routeState ? { ...routeState, page } : buildRouteState(page);
    const nextUrl = PAGE_TO_PATH[page] || '/';

    if (historyMode === 'replace') {
        window.history.replaceState(nextState, '', nextUrl);
        return;
    }

    window.history.pushState(nextState, '', nextUrl);
}

function setLoading(isLoading) {
    if (isLoading) {
        loadingCount += 1;
    } else {
        loadingCount = Math.max(loadingCount - 1, 0);
    }

    const overlay = document.getElementById('globalLoading');
    if (!overlay) return;

    const shouldShow = loadingCount > 0;
    overlay.classList.toggle('hidden', !shouldShow);
    document.body.classList.toggle('is-loading', shouldShow);
}

async function withLoading(task) {
    setLoading(true);
    try {
        return await task();
    } finally {
        setLoading(false);
    }
}

function clearErrors() {
    document.querySelectorAll('.error-msg').forEach((e) => {
        e.textContent = '';
    });
    document.querySelectorAll('.field-error').forEach((el) => {
        el.classList.remove('field-error');
    });
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
    return EMAIL_PATTERN.test(email.trim());
}

/** Sets an inline error message and a red border on the matching field. */
function setFieldError(inputId, errorId, message) {
    const input = document.getElementById(inputId);
    const errorEl = document.getElementById(errorId);
    if (input) input.classList.add('field-error');
    if (errorEl) errorEl.textContent = message;
}

function showError(error, fallback = 'Something went wrong. Please try again.') {
    console.error(error);
    showToast('error', error?.message || fallback);
}

function listingRowToView(row) {
    return {
        id: row.id,
        brand: row.brand,
        faceValue: Number(row.face_value),
        salePrice: Number(row.sale_price),
        discount: Number(row.discount),
        seller: row.seller_name,
        sellerSince: row.seller_since,
        cardsSold: Number(row.cards_sold || 0),
        status: STATUS_MAP.listing[row.status] || row.status,
        date: row.created_at,
        expiry: row.expiry_date,
        createdAt: row.created_at,
        sellerId: row.seller_id,
        submissionId: row.submission_id,
        cardVaultId: row.card_vault_id,
        saleMode: row.sale_mode || 'instant',
        sellerPayoutAmount: row.seller_payout_amount !== null && row.seller_payout_amount !== undefined ? Number(row.seller_payout_amount) : null,
        suspended: Boolean(row.suspended),
        suspendedReason: row.suspended_reason || null
    };
}

function submissionRowToView(row) {
    return {
        id: row.public_id,
        dbId: row.id,
        sellerId: row.seller_id,
        sellerName: row.seller_name,
        brand: row.brand,
        faceValue: Number(row.face_value),
        currentBalance: Number(row.current_balance),
        expiryDate: row.expiry_date,
        cardNumber: row.card_number,
        pin: row.pin,
        receiptFilename: row.receipt_filename || '',
        offerAmount: Number(row.offer_amount),
        saleMode: row.sale_mode || 'instant',
        sellerSetPrice: row.seller_set_price !== null && row.seller_set_price !== undefined ? Number(row.seller_set_price) : null,
        status: STATUS_MAP.submission[row.status] || row.status,
        statusKey: row.status,
        adminNotes: row.admin_notes || '',
        createdAt: row.created_at
    };
}

function orderRowToView(row) {
    return {
        id: row.public_id,
        dbId: row.id,
        listingId: row.listing_id,
        buyerId: row.buyer_id,
        buyerName: row.buyer_name,
        buyerEmail: row.buyer_email,
        buyerPhone: row.buyer_phone,
        brand: row.brand,
        faceValue: Number(row.face_value),
        salePrice: Number(row.sale_price),
        serviceFee: Number(row.service_fee),
        total: Number(row.total),
        status: STATUS_MAP.order[row.status] || row.status,
        statusKey: row.status,
        date: row.created_at
    };
}

async function fetchProfile(userId) {
    const { data, error } = await supabaseClient
        .from('profiles')
        .select('id, name, email, role, created_at, suspended, suspended_reason')
        .eq('id', userId)
        .single();

    if (error) throw error;

    return {
        id: data.id,
        name: data.name,
        email: data.email,
        role: data.role,
        created: data.created_at?.split('T')[0],
        suspended: Boolean(data.suspended),
        suspendedReason: data.suspended_reason || null
    };
}

async function checkAuth() {
    await withLoading(async () => {
        const {
            data: { session },
            error
        } = await supabaseClient.auth.getSession();

        if (error) throw error;

        if (!session?.user) {
            AppState.currentUser = null;
            updateNavForUser();
            return;
        }

        AppState.currentUser = await fetchProfile(session.user.id);
        updateNavForUser();
    });
}

async function handleAuthStateChange(event, session) {
    if (event === 'PASSWORD_RECOVERY') {
        router('reset-password', { historyMode: 'replace' });
        return;
    }

    if (event === 'SIGNED_OUT') {
        AppState.currentUser = null;
        updateNavForUser();
        if (getPageFromPath() !== 'home') router('home', { historyMode: 'replace' });
        return;
    }

    if (session?.user) {
        try {
            AppState.currentUser = await fetchProfile(session.user.id);
            updateNavForUser();
        } catch (error) {
            showError(error, 'Unable to refresh your account information.');
        }
    }
}

function updateNavForUser() {
    const authDiv = document.getElementById('navAuth');
    const userDiv = document.getElementById('navUser');
    const adminLink = document.getElementById('adminLink');

    if (AppState.currentUser) {
        authDiv.classList.add('hidden');
        userDiv.classList.remove('hidden');
        document.getElementById('userNameDisplay').textContent = (AppState.currentUser.name?.split(' ')[0]) || 'User';

        if (AppState.currentUser.role === 'admin') {
            adminLink.classList.remove('hidden');
        } else {
            adminLink.classList.add('hidden');
        }
    } else {
        authDiv.classList.remove('hidden');
        userDiv.classList.add('hidden');
        adminLink.classList.add('hidden');
    }
}

async function handleSignup() {
    clearErrors();

    const name = document.getElementById('signupName').value.trim();
    const email = document.getElementById('signupEmail').value.trim().toLowerCase();
    const password = document.getElementById('signupPassword').value;
    const confirm = document.getElementById('signupConfirm').value;
    const terms = document.getElementById('signupTerms').checked;

    let hasError = false;

    if (name.length < 2) {
        setFieldError('signupName', 'signupNameError', 'Name must be at least 2 characters');
        hasError = true;
    }

    if (!isValidEmail(email)) {
        setFieldError('signupEmail', 'signupEmailError', 'Please enter a valid email');
        hasError = true;
    }

    if (password.length < 8) {
        setFieldError('signupPassword', 'signupPasswordError', 'Password must be at least 8 characters');
        hasError = true;
    }

    if (password !== confirm) {
        setFieldError('signupConfirm', 'signupConfirmError', 'Passwords do not match');
        hasError = true;
    }

    if (!terms) {
        document.getElementById('signupTermsError').textContent = 'You must agree to the terms';
        hasError = true;
    }

    if (hasError) return;

    try {
        await withLoading(async () => {
            const { data, error } = await supabaseClient.auth.signUp({
                email,
                password,
                options: {
                    data: { name }
                }
            });

            if (error) throw error;

            // NOTE: the profiles row is created automatically by the
            // handle_new_user() database trigger (SECURITY DEFINER) as soon
            // as the auth.users row is inserted, so no client-side insert is
            // needed here. Writing it from the client was removed because it
            // ran under the user's own (often not-yet-authenticated) session
            // and was rejected by the profiles_insert_own RLS policy
            // whenever there was no active session yet -- e.g. when
            // "Confirm email" is enabled and signUp() returns a user but no
            // session until the confirmation link is clicked.

            if (data.session?.user) {
                AppState.currentUser = await fetchProfile(data.session.user.id);
                updateNavForUser();
                showToast('success', 'Account created successfully!');
                router('home');
                return;
            }

            showToast('success', 'Account created. Please verify your email and then sign in.');
            router('login');
        });
    } catch (error) {
        if ((error?.message || '').toLowerCase().includes('already registered')) {
            document.getElementById('signupEmailError').textContent = 'Email already registered';
            return;
        }
        showError(error, 'Unable to create your account.');
    }
}

async function handleLogin() {
    clearErrors();

    const email = document.getElementById('loginEmail').value.trim().toLowerCase();
    const password = document.getElementById('loginPassword').value;

    let hasError = false;
    if (!email) {
        setFieldError('loginEmail', 'loginEmailError', 'Enter your email address');
        hasError = true;
    } else if (!isValidEmail(email)) {
        setFieldError('loginEmail', 'loginEmailError', 'Enter a valid email address');
        hasError = true;
    }
    if (!password) {
        setFieldError('loginPassword', 'loginPasswordError', 'Enter your password');
        hasError = true;
    }
    if (hasError) return;

    try {
        await withLoading(async () => {
            const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) throw error;

            AppState.currentUser = await fetchProfile(data.user.id);
            updateNavForUser();
            router('home');
        });
    } catch (error) {
        setFieldError('loginPassword', 'loginPasswordError', 'Invalid email or password');
    }
}

async function handleContactSubmit() {
    clearErrors();

    const name = document.getElementById('contactName').value.trim();
    const email = document.getElementById('contactEmail').value.trim();
    const subject = document.getElementById('contactSubject').value;
    const message = document.getElementById('contactMessage').value.trim();

    let hasError = false;
    if (name.length < 2) {
        setFieldError('contactName', 'contactNameError', 'Enter your full name');
        hasError = true;
    }
    if (!isValidEmail(email)) {
        setFieldError('contactEmail', 'contactEmailError', 'Enter a valid email address');
        hasError = true;
    }
    if (!subject) {
        setFieldError('contactSubject', 'contactSubjectError', 'Select a subject');
        hasError = true;
    }
    if (message.length < 10) {
        setFieldError('contactMessage', 'contactMessageError', 'Tell us a little more (at least 10 characters)');
        hasError = true;
    }
    if (hasError) return;

    const submitBtn = document.getElementById('contactSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    try {
        const response = await fetch('/api/contact-form', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, subject, message })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to send your message.');

        showToast('success', 'Your message has been sent — we will reply within 24 hours.');
        document.getElementById('contactForm').reset();
    } catch (error) {
        showError(error, 'Unable to send your message. Please email support@giftlio.co.nz directly.');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Message';
    }
}

async function handleForgot() {
    clearErrors();
    const email = document.getElementById('forgotEmail').value.trim();

    if (!email) {
        setFieldError('forgotEmail', 'forgotEmailError', 'Enter your email address');
        return;
    }
    if (!isValidEmail(email)) {
        setFieldError('forgotEmail', 'forgotEmailError', 'Enter a valid email address');
        return;
    }

    try {
        await withLoading(async () => {
            const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
                redirectTo: `${window.location.origin}${window.location.pathname}`
            });

            if (error) throw error;
        });

        showToast('info', `If this email exists in our system, a reset link has been sent to ${email}`);
        router('login');
    } catch (error) {
        showError(error, 'Unable to request a reset link.');
    }
}

async function handleResetPassword() {
    clearErrors();

    const password = document.getElementById('resetPassword').value;
    const confirm = document.getElementById('resetPasswordConfirm').value;

    let hasError = false;

    if (password.length < 8) {
        setFieldError('resetPassword', 'resetPasswordError', 'Password must be at least 8 characters');
        hasError = true;
    }

    if (password !== confirm) {
        setFieldError('resetPasswordConfirm', 'resetPasswordConfirmError', 'Passwords do not match');
        hasError = true;
    }

    if (hasError) return;

    try {
        await withLoading(async () => {
            const { error } = await supabaseClient.auth.updateUser({ password });
            if (error) throw error;
        });

        showToast('success', 'Your password has been updated. Please log in with your new password.');

        // The recovery session Supabase created to allow this update is not a
        // normal login session -- sign out so the user lands on a clean login
        // screen and re-authenticates with the new password.
        await supabaseClient.auth.signOut();
        AppState.currentUser = null;
        updateNavForUser();
        document.getElementById('resetPasswordForm').reset();
        router('login', { historyMode: 'replace' });
    } catch (error) {
        showError(error, 'Unable to update your password. Please request a new reset link.');
    }
}

async function logout() {
    try {
        await withLoading(async () => {
            const { error } = await supabaseClient.auth.signOut();
            if (error) throw error;
        });

        AppState.currentUser = null;
        AppState.currentOrder = null;
        AppState.currentListing = null;
        updateNavForUser();
        router('home');
    } catch (error) {
        showError(error, 'Unable to sign out.');
    }
}

async function getActiveListings() {
    const { data, error } = await supabaseClient
        .from('listings')
        .select('*')
        .eq('status', 'active')
        .eq('suspended', false)
        .order('created_at', { ascending: false });

    if (error) throw error;

    // Defense in depth: a listing should never have a zero/negative sale
    // price or face value (the pricing helper prevents this at creation),
    // but if one somehow exists -- a direct DB edit, a bug elsewhere -- it
    // must never be purchasable to a buyer. Filtered out here, not just
    // hidden with CSS.
    return (data || [])
        .map(listingRowToView)
        .filter((l) => l.salePrice > 0 && l.faceValue > 0);
}

/**
 * Looks up how a brand's balance gets verified, using CATEGORIES as the
 * source of truth. Brands not in any defined category (Rebel Sport,
 * Pak'nSave -- neither was covered by the verified category research)
 * default to "manual" rather than assuming instant, since that hasn't
 * actually been confirmed for them.
 */
function getBrandVerification(brand) {
    for (const cat of Object.values(CATEGORIES)) {
        if (cat.brands.includes(brand)) {
            return { verification: cat.verification, note: cat.note };
        }
    }
    return {
        verification: 'manual',
        note: `${brand} balance is confirmed through our manual verification process.`
    };
}

function renderListingCard(listing) {
    const safeSeller = escapeHtml(listing.seller || 'Verified Seller');
    const { verification, note } = getBrandVerification(listing.brand);
    const isInstant = verification === 'instant';
    const verifyBadge = isInstant
        ? `<span class="card-verify instant" title="${escapeHtml(note)}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>Instant verified</span>`
        : `<span class="card-verify manual" title="${escapeHtml(note)}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>Manually verified</span>`;

    // PB Tech's balance-check process (add to cart, apply the card) is
    // different enough from a standard online checker that buyers might
    // wonder why -- a quick explanation reassures them the result is the
    // same regardless of method.
    const infoTooltip =
        listing.brand === 'PB Tech'
            ? `<span class="card-info-tip" tabindex="0" role="button" aria-label="How this card was verified">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                <span class="card-info-tip-bubble">Verified by adding the card to a PB Tech cart and applying it -- a more manual check, but just as reliable.</span>
               </span>`
            : '';

    // Retailer-level kill switch, checked from the SAME single source of
    // truth every other page reads (AppState.brandDiscounts, loaded via
    // loadBrandDiscounts()). The listing itself is never hidden or removed
    // when its retailer is disabled -- only the purchase action is blocked,
    // with a clear badge explaining why.
    const brandConfig = AppState.brandDiscounts[listing.brand];
    const retailerUnavailable = brandConfig && brandConfig.retailerEnabled === false;

    const buyButton = retailerUnavailable
        ? `<button class="btn btn-disabled" aria-label="${escapeHtml(listing.brand)} is temporarily unavailable" onclick="event.stopPropagation(); showRetailerUnavailableNotice('${escapeJsString(listing.brand)}')">Temporarily Unavailable</button>`
        : `<button class="btn btn-primary" aria-label="View ${escapeHtml(listing.brand)} gift card, ${formatCurrency(listing.salePrice)}, save ${listing.discount} percent" onclick="event.stopPropagation(); viewListing('${listing.id}')">Buy Now</button>`;

    return `
        <div class="listing-card ${retailerUnavailable ? 'listing-card-unavailable' : ''}" onclick="${retailerUnavailable ? `event.stopPropagation(); showRetailerUnavailableNotice('${escapeJsString(listing.brand)}')` : `viewListing('${listing.id}')`}">
            <div class="listing-card-header">
                ${retailerBadgeHTML(listing.brand)}
                ${retailerUnavailable ? '<span class="unavailable-badge">Temporarily Unavailable</span>' : verifyBadge}
            </div>
            <div class="listing-card-body">
                <div class="listing-value">${formatCurrency(listing.faceValue)}</div>
                <div class="listing-price">${formatCurrency(listing.salePrice)}</div>
                <div class="listing-meta-row">
                    <span class="discount-badge">Save ${listing.discount}%</span>
                    <span class="gst-note">GST included</span>
                </div>
                <div class="listing-seller-verified">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px; margin-right:3px;"><circle cx="12" cy="9" r="6"/><path d="M9 9l2 2 4-4"/></svg>Verified · ${safeSeller}${infoTooltip}
                </div>
                ${buyButton}
            </div>
        </div>
    `;
}

function renderSkeletonCards(count) {
    return Array.from({ length: count })
        .map(
            () => `
        <div class="listing-card skeleton-card" aria-hidden="true">
            <div class="skel skel-badge"></div>
            <div class="skel skel-line" style="width:60%; margin-top:10px;"></div>
            <div class="skel skel-line" style="width:40%; height:22px; margin-top:10px;"></div>
            <div class="skel skel-line" style="width:80%;"></div>
            <div class="skel skel-btn"></div>
        </div>
    `
        )
        .join('');
}

/** Skeleton placeholders matching .summary-card, for dashboard/admin stats. */
function renderSkeletonStatCards(count) {
    return Array.from({ length: count })
        .map(
            () => `
        <div class="summary-card" aria-hidden="true">
            <div class="skel skel-line" style="width:70%; height:12px;"></div>
            <div class="skel skel-line" style="width:45%; height:26px; margin-top:10px;"></div>
        </div>
    `
        )
        .join('');
}

/** Skeleton table rows matching a real <table>'s column count, for orders,
    submissions, and admin tables while data loads. */
function renderSkeletonTableRows(columnCount, rowCount = 4) {
    const cells = Array.from({ length: columnCount })
        .map(() => `<td><div class="skel skel-line" style="width:${60 + Math.floor(Math.random() * 30)}%;"></div></td>`)
        .join('');
    return `
        <table aria-hidden="true">
            <tbody>
                ${Array.from({ length: rowCount })
                    .map(() => `<tr>${cells}</tr>`)
                    .join('')}
            </tbody>
        </table>
    `;
}

/** Skeleton lines for simple list content like "Recent Activity". */
function renderSkeletonLines(count = 4) {
    return Array.from({ length: count })
        .map(
            () => `<div class="skel skel-line" style="width:${70 + Math.floor(Math.random() * 25)}%; height:16px; margin-bottom:12px;"></div>`
        )
        .join('');
}

async function renderHome() {
    const categoryGrid = document.getElementById('categoryGrid');
    categoryGrid.innerHTML = Object.entries(CATEGORIES)
        .map(([key, cat]) => {
            const isInstant = cat.verification === 'instant';
            const verifyBadge = isInstant
                ? `<span class="cat-verify instant"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>Instant online check</span>`
                : `<span class="cat-verify manual"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>Manually verified</span>`;
            return `
        <div class="category-card" tabindex="0" role="button" aria-label="Browse ${escapeHtml(cat.label)} category: ${cat.brands.map(escapeHtml).join(', ')}" onclick="filterByCategory('${key}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault(); filterByCategory('${key}');}">
            <h3>${escapeHtml(cat.label)}</h3>
            <p class="cat-brands">${cat.brands.map(escapeHtml).join(' · ')}</p>
            ${verifyBadge}
        </div>
    `;
        })
        .join('');

    const brands = ['The Warehouse', 'Woolworths', "Pak'nSave", 'New World', 'Farmers', 'Noel Leeming', 'Briscoes', 'Rebel Sport', 'PB Tech'];
    const brandsGrid = document.getElementById('brandsGrid');
    brandsGrid.innerHTML = brands
        .map(
            (b) => `
        <div class="brand-card" tabindex="0" role="button" aria-label="Browse ${escapeHtml(b)} gift cards" onclick="filterByBrand('${escapeJsString(b)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault(); filterByBrand('${escapeJsString(b)}');}">
            ${retailerBadgeHTML(b)}
            <p>Up to 20% off</p>
        </div>
    `
        )
        .join('');

    // Show skeletons immediately so the page never looks blank while data loads
    document.getElementById('featuredGrid').innerHTML = renderSkeletonCards(4);
    document.getElementById('recommendedGrid').innerHTML = renderSkeletonCards(4);

    try {
        await withLoading(async () => {
            const allListings = await getActiveListings();
            document.getElementById('featuredGrid').innerHTML = allListings.slice(0, 4).map((l) => renderListingCard(l)).join('');
            const recommended = allListings.slice(4, 8).length ? allListings.slice(4, 8) : allListings.slice(0, 4);
            document.getElementById('recommendedGrid').innerHTML = recommended.length
                ? recommended.map((l) => renderListingCard(l)).join('')
                : '<p style="color: var(--gray-500);">More listings coming soon.</p>';
        });
    } catch (error) {
        document.getElementById('featuredGrid').innerHTML = '<p style="color: var(--gray-500);">Unable to load featured listings.</p>';
        document.getElementById('recommendedGrid').innerHTML = '';
        showError(error, 'Unable to load featured listings.');
    }
}

async function renderBrowse() {
    document.getElementById('browseGrid').innerHTML = renderSkeletonCards(8);
    document.getElementById('browseEmpty').classList.add('hidden');
    await applyFilters();
}

/**
 * Real text search across brand name, near-value price matching, and
 * category keywords -- not just exact brand substring matching.
 * "$20" or "20" matches cards within $5 of that face value or sale price.
 * "grocery" matches any listing whose brand belongs to a category whose
 * label/keywords mention groceries (Woolworths, New World), etc.
 */
const NUMBER_WORDS = {
    ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100
};

function extractSearchNumber(q) {
    const digitMatch = q.match(/\$?\s*(\d+(?:\.\d+)?)/);
    if (digitMatch) return parseFloat(digitMatch[1]);

    // "twenty five" (two words) is common for $25 -- check compound forms
    // before single words, so "twenty five" doesn't just match "twenty".
    const compact = q.replace(/[\s-]+/g, '');
    if (compact.includes('twentyfive')) return 25;
    if (compact.includes('seventyfive')) return 75;

    for (const [word, value] of Object.entries(NUMBER_WORDS)) {
        if (q.includes(word)) return value;
    }
    return null;
}

function listingMatchesSearch(listing, rawQuery) {
    const q = rawQuery.toLowerCase().trim();
    if (!q) return true;

    if (listing.brand.toLowerCase().includes(q)) return true;

    const target = extractSearchNumber(q);
    if (target !== null) {
        const tolerance = 5;
        if (Math.abs(listing.faceValue - target) <= tolerance) return true;
        if (Math.abs(listing.salePrice - target) <= tolerance) return true;
    }

    for (const cat of Object.values(CATEGORIES)) {
        const keywordMatch = cat.keywords.some((kw) => q.includes(kw) || kw.includes(q));
        if (keywordMatch && cat.brands.includes(listing.brand)) return true;
    }

    return false;
}

async function applyFilters() {
    try {
        await withLoading(async () => {
            const [allListings] = await Promise.all([getActiveListings(), loadBrandDiscounts()]);
            let listings = allListings;
            const search = document.getElementById('searchInput').value;
            const discountFilter = document.getElementById('discountFilter').value;
            const sort = document.getElementById('sortSelect').value;

            // Category filter and text search are independent dimensions --
            // they stack (AND together), neither resets the other.
            if (AppState.activeCategory && CATEGORIES[AppState.activeCategory]) {
                const allowedBrands = CATEGORIES[AppState.activeCategory].brands;
                listings = listings.filter((l) => allowedBrands.includes(l.brand));
            }

            if (search) {
                listings = listings.filter((l) => listingMatchesSearch(l, search));
            }

            if (discountFilter) {
                listings = listings.filter((l) => l.discount >= parseInt(discountFilter, 10));
            }

            if (sort === 'newest') {
                listings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            } else if (sort === 'discount') {
                listings.sort((a, b) => b.discount - a.discount);
            } else if (sort === 'price-low') {
                listings.sort((a, b) => a.salePrice - b.salePrice);
            } else if (sort === 'price-high') {
                listings.sort((a, b) => b.salePrice - a.salePrice);
            }

            document.getElementById('resultsCount').textContent = `${listings.length} card${listings.length !== 1 ? 's' : ''} found`;
            renderActiveCategoryBanner();

            const grid = document.getElementById('browseGrid');
            const empty = document.getElementById('browseEmpty');

            if (listings.length === 0) {
                grid.innerHTML = '';
                empty.classList.remove('hidden');
                renderBrowseEmptyState(allListings.length === 0);
            } else {
                empty.classList.add('hidden');
                grid.innerHTML = listings.map((l) => renderListingCard(l)).join('');
            }
        });
    } catch (error) {
        showError(error, 'Unable to load listings.');
    }
}

function renderActiveCategoryBanner() {
    const banner = document.getElementById('activeCategoryBanner');
    if (!banner) return;
    const cat = AppState.activeCategory && CATEGORIES[AppState.activeCategory];
    if (!cat) {
        banner.classList.add('hidden');
        banner.innerHTML = '';
        return;
    }
    banner.classList.remove('hidden');
    banner.innerHTML = `
        <span>Showing <strong>${escapeHtml(cat.label)}</strong> (${cat.brands.map(escapeHtml).join(', ')})</span>
        <button onclick="clearCategoryFilter()">Clear<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg></button>
    `;
}

function clearCategoryFilter() {
    AppState.activeCategory = null;
    applyFilters();
}

/**
 * Called when a category tile is clicked. Navigates to Browse with that
 * category's retailer group applied as a filter. Does NOT touch the search
 * text box -- category and search compose together rather than resetting
 * each other.
 */
async function filterByCategory(categoryKey) {
    AppState.activeCategory = categoryKey;
    await router('browse');
}

/**
 * Two genuinely different empty states, not one generic message:
 * - Database has zero listings at all (pre-launch / nothing sold yet) ->
 *   invite them to be the first seller, link to /sell.
 * - Database has listings, but the current search/filter matched none ->
 *   offer to clear filters instead.
 */
function renderBrowseEmptyState(isDatabaseEmpty) {
    const empty = document.getElementById('browseEmpty');
    if (isDatabaseEmpty) {
        empty.innerHTML = `
            <div class="empty-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="9" width="18" height="12" rx="1.5"/><rect x="3" y="9" width="18" height="4" rx="1"/><path d="M10.5 9V21"/><path d="M13.5 9V21"/><path d="M12 9C12 9 8 8 8 5.5C8 4 9.3 3 10.5 3.5C11.7 4 12 6 12 9Z"/><path d="M12 9C12 9 16 8 16 5.5C16 4 14.7 3 13.5 3.5C12.3 4 12 6 12 9Z"/></svg></div>
            <p class="empty-title">No gift cards available right now</p>
            <p class="empty-sub">Be the first to sell one! It only takes a couple of minutes, and every card is manually verified before it goes live.</p>
            <button class="btn btn-primary" onclick="router('sell')">Sell a Gift Card</button>
        `;
    } else {
        empty.innerHTML = `
            <div class="empty-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></div>
            <p class="empty-title">No gift cards found</p>
            <p class="empty-sub">Try a different search term, or clear your filters to see everything on offer</p>
            <button class="btn btn-secondary" onclick="clearFilters()">Clear Filters</button>
        `;
    }
}

function clearFilters() {
    document.getElementById('searchInput').value = '';
    document.getElementById('discountFilter').value = '';
    document.getElementById('sortSelect').value = 'newest';
    AppState.activeCategory = null;
    applyFilters();
}

const OFFER_RANGE_PCT = 0.25;

/**
 * Renders the buyer-facing offer panel on a Marketplace listing's detail
 * page. Checks for an existing offer from this buyer on this listing first
 * -- the UI branches entirely on that offer's status (or its absence)
 * rather than always showing a fresh "make an offer" form.
 */
async function renderOfferPanel(listing) {
    const panel = document.getElementById('offerPanel');
    if (!panel) return;

    try {
        const { data: existing, error } = await supabaseClient
            .from('listing_offers')
            .select('*')
            .eq('listing_id', listing.id)
            .eq('buyer_id', AppState.currentUser.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw error;

        const minOffer = listing.salePrice * (1 - OFFER_RANGE_PCT);
        const maxOffer = listing.salePrice * (1 + OFFER_RANGE_PCT);

        if (!existing || ['rejected', 'expired', 'withdrawn'].includes(existing.status)) {
            panel.innerHTML = `
                <div class="offer-panel">
                    <button class="btn btn-outline" style="width: 100%;" onclick="toggleOfferForm()">Make an Offer</button>
                    <div class="offer-form hidden" id="offerFormBox">
                        <label for="offerAmountInput">Your offer (between ${formatCurrency(minOffer)} and ${formatCurrency(maxOffer)})</label>
                        <input type="number" id="offerAmountInput" step="0.01" min="${minOffer.toFixed(2)}" max="${maxOffer.toFixed(2)}">
                        <span class="error-msg" id="offerAmountError"></span>
                        <button class="btn btn-primary" style="width: 100%; margin-top: 8px;" onclick="submitOffer('${listing.id}', '${escapeJsString(listing.sellerId)}', ${listing.salePrice})">Send Offer</button>
                    </div>
                </div>
            `;
        } else if (existing.status === 'pending') {
            panel.innerHTML = `<div class="offer-panel offer-status-box"><p>Your offer of <strong>${formatCurrency(existing.offer_amount)}</strong> is waiting for the seller to respond.</p><button class="btn btn-outline btn-sm" onclick="withdrawOffer('${existing.id}')">Withdraw Offer</button></div>`;
        } else if (existing.status === 'countered') {
            panel.innerHTML = `
                <div class="offer-panel offer-status-box">
                    <p>The seller countered your offer of ${formatCurrency(existing.offer_amount)} with <strong>${formatCurrency(existing.counter_amount)}</strong>.</p>
                    <div style="display: flex; gap: 8px; margin-top: 8px;">
                        <button class="btn btn-primary" onclick="respondToCounter('${existing.id}', true)">Accept ${formatCurrency(existing.counter_amount)}</button>
                        <button class="btn btn-outline" onclick="respondToCounter('${existing.id}', false)">Walk Away</button>
                    </div>
                </div>
            `;
        } else if (existing.status === 'accepted' || existing.status === 'buyer_accepted_counter') {
            const agreedPrice = existing.status === 'buyer_accepted_counter' ? existing.counter_amount : existing.offer_amount;
            panel.innerHTML = `<div class="offer-panel offer-status-box"><p>Your offer was accepted! You can buy this card at your agreed price of <strong>${formatCurrency(agreedPrice)}</strong>.</p><button class="btn btn-gold" style="width: 100%; margin-top: 8px;" onclick="startCheckout(${agreedPrice})">Buy Now - ${formatCurrency(agreedPrice)} NZD</button></div>`;
        }
    } catch (error) {
        console.error('Unable to load offer status:', error);
    }
}

function toggleOfferForm() {
    document.getElementById('offerFormBox').classList.toggle('hidden');
}

async function submitOffer(listingId, sellerId, originalPrice) {
    const input = document.getElementById('offerAmountInput');
    const errorEl = document.getElementById('offerAmountError');
    errorEl.textContent = '';
    input.classList.remove('field-error');

    const amount = Number(input.value);
    const min = originalPrice * (1 - OFFER_RANGE_PCT);
    const max = originalPrice * (1 + OFFER_RANGE_PCT);

    if (!input.value || Number.isNaN(amount) || amount <= 0) {
        input.classList.add('field-error');
        errorEl.textContent = 'Enter a valid amount.';
        return;
    }
    if (amount < min || amount > max) {
        input.classList.add('field-error');
        errorEl.textContent = `Must be between ${formatCurrency(min)} and ${formatCurrency(max)}.`;
        return;
    }

    try {
        await withLoading(async () => {
            const { error } = await supabaseClient.from('listing_offers').insert({
                listing_id: listingId,
                buyer_id: AppState.currentUser.id,
                seller_id: sellerId,
                original_price: originalPrice,
                offer_amount: amount,
                status: 'pending'
            });
            if (error) throw error;
        });

        await notifySeller(
            sellerId,
            `New offer on your listing: ${formatCurrency(amount)}`,
            `<p>${escapeHtml(AppState.currentUser.name)} sent an offer of <strong>${formatCurrency(amount)}</strong> on your listing (listed at ${formatCurrency(originalPrice)}).</p>
             <p><a href="${window.location.origin}/seller-dashboard">Respond to this offer</a></p>`,
            'offer_received',
            listingId
        );

        showToast('success', 'Offer sent to the seller.');
        viewListing(listingId, { historyMode: 'none' });
    } catch (error) {
        showError(error, 'Unable to send your offer.');
    }
}

async function withdrawOffer(offerId) {
    try {
        await withLoading(async () => {
            const { error } = await supabaseClient.from('listing_offers').update({ status: 'withdrawn', responded_at: new Date().toISOString() }).eq('id', offerId);
            if (error) throw error;
        });
        showToast('info', 'Offer withdrawn.');
        viewListing(AppState.currentListing.id, { historyMode: 'none' });
    } catch (error) {
        showError(error, 'Unable to withdraw offer.');
    }
}

async function respondToCounter(offerId, accept) {
    try {
        await withLoading(async () => {
            const { error } = await supabaseClient
                .from('listing_offers')
                .update({ status: accept ? 'buyer_accepted_counter' : 'rejected', responded_at: new Date().toISOString() })
                .eq('id', offerId);
            if (error) throw error;
        });
        showToast(accept ? 'success' : 'info', accept ? 'Counter accepted! You can now buy at the agreed price.' : 'Counter declined.');
        viewListing(AppState.currentListing.id, { historyMode: 'none' });
    } catch (error) {
        showError(error, 'Unable to respond to the counter offer.');
    }
}

async function viewListing(id, options = {}) {
    const { historyMode = 'push' } = options;

    try {
        await withLoading(async () => {
            const [{ data, error }] = await Promise.all([supabaseClient.from('listings').select('*').eq('id', id).single(), loadBrandDiscounts()]);
            if (error) throw error;

            const listing = listingRowToView(data);
            const safeBrand = escapeHtml(listing.brand);
            const safeSeller = escapeHtml(listing.seller);
            const safeSellerSince = escapeHtml(listing.sellerSince || 'N/A');
            AppState.currentListing = listing;

            const { data: similarData, error: similarError } = await supabaseClient
                .from('listings')
                .select('*')
                .eq('brand', listing.brand)
                .neq('id', listing.id)
                .eq('status', 'active')
                .order('created_at', { ascending: false })
                .limit(3);

            if (similarError) throw similarError;

            const similar = (similarData || []).map(listingRowToView);

            const detailBrandConfig = AppState.brandDiscounts[listing.brand];
            const detailRetailerUnavailable = detailBrandConfig && detailBrandConfig.retailerEnabled === false;

            document.getElementById('detailLayout').innerHTML = `
                <div class="detail-left">
                    <h1 class="visually-hidden">${escapeHtml(listing.brand)} gift card, ${formatCurrency(listing.faceValue)} value</h1>
                    <div class="detail-brand-badge">${retailerBadgeHTML(listing.brand)}${detailRetailerUnavailable ? '<span class="unavailable-badge">Temporarily Unavailable</span>' : ''}</div>
                    <div class="detail-value">${formatCurrency(listing.faceValue)}</div>
                    <div class="detail-price">${formatCurrency(listing.salePrice)}</div>
                    <span class="gst-note">GST included</span>
                    <span class="detail-discount">You save ${formatCurrency(listing.faceValue - listing.salePrice)} (${listing.discount}%)</span>
                    <div style="margin-top: 16px;">
                        <span class="badge badge-green">Available</span>
                    </div>
                </div>
                <div class="detail-right">
                    <div class="detail-section">
                        <h3>Seller Information</h3>
                        <p><strong>Seller:</strong> ${safeSeller}</p>
                        <p><strong>Member since:</strong> ${safeSellerSince}</p>
                        <p><strong>Cards sold:</strong> ${listing.cardsSold}</p>
                    </div>
                    <div class="detail-section">
                        <h3>Description</h3>
                        <p>This is a genuine ${safeBrand} gift card with a verified balance. Card details will be delivered via email within 24 hours of purchase after manual verification.</p>
                    </div>
                    <div class="detail-section trust-icon-row">
                        <div class="trust-icon-item">
                            <span><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="6"/><path d="M9 9l2 2 4-4"/></svg></span>
                            <p>Balance<br>verified</p>
                        </div>
                        <div class="trust-icon-item">
                            <span><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></span>
                            <p>Secure<br>Stripe pay</p>
                        </div>
                        <div class="trust-icon-item">
                            <span><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg></span>
                            <p>Delivered<br>in 24hrs</p>
                        </div>
                    </div>
                    <div class="detail-section">
                        <h3>What you'll receive</h3>
                        <div class="delivery-preview">
                            <div class="delivery-preview-head">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>
                                Email preview
                            </div>
                            <div class="delivery-preview-card" style="background: linear-gradient(135deg, var(--navy-light), var(--navy-dark));">
                                <div class="dp-brand">${safeBrand} Gift Card</div>
                                <div class="dp-number">•••• •••• •••• <span class="dp-last4">7719</span></div>
                                <span class="dp-balance-stamp">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="6"/><path d="M9 9l2 2 4-4"/></svg>
                                    Verified Balance: ${formatCurrency(listing.faceValue)}
                                </span>
                            </div>
                            <p class="delivery-preview-note">Full card number and PIN are only ever shown inside your own Giftlio account after purchase — never in the pre-purchase preview.</p>
                        </div>
                    </div>
                    <div class="detail-action">
                        ${
                            detailRetailerUnavailable
                                ? `<button class="btn btn-disabled" onclick="showRetailerUnavailableNotice('${escapeJsString(listing.brand)}')">Temporarily Unavailable</button>
                                   <p style="font-size: 12px; color: var(--gray-600); margin-top: 8px; text-align: center;">${escapeHtml(listing.brand)} is temporarily unavailable for purchase right now. Please check back soon.</p>`
                                : `<button class="btn btn-gold" onclick="startCheckout()">
                            Buy Now - ${formatCurrency(listing.salePrice)} NZD
                        </button>
                        <p style="font-size: 12px; color: var(--gray-500); margin-top: 8px; text-align: center;">Includes service fee</p>`
                        }
                    </div>
                    ${!detailRetailerUnavailable && listing.saleMode === 'marketplace' && AppState.currentUser && AppState.currentUser.id !== listing.sellerId ? '<div id="offerPanel"></div>' : ''}
                    ${
                        similar.length > 0
                            ? `<div class="detail-section">
                        <h3>Similar Cards</h3>
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px;">
                            ${similar
                                .map(
                                    (s) => `
                                <div style="background: var(--gray-50); padding: 12px; border-radius: var(--radius); cursor: pointer;" onclick="viewListing('${s.id}')">
                                    <div style="font-weight: 700; font-size: 14px;">${escapeHtml(s.brand)}</div>
                                    <div style="color: var(--green); font-weight: 700;">${formatCurrency(s.salePrice)}</div>
                                    <div style="font-size: 12px; color: var(--gray-500);">Save ${s.discount}%</div>
                                </div>
                            `
                                )
                                .join('')}
                        </div>
                    </div>`
                            : ''
                    }
                </div>
            `;

            if (!detailRetailerUnavailable && listing.saleMode === 'marketplace' && AppState.currentUser && AppState.currentUser.id !== listing.sellerId) {
                await renderOfferPanel(listing);
            }

            router('listing', { historyMode });
        });
    } catch (error) {
        showError(error, 'Unable to load listing details.');
    }
}

function startCheckout(agreedPrice) {
    if (!AppState.currentUser) {
        router('login');
        return;
    }
    if (!AppState.currentListing) return;

    // agreedPrice comes from an accepted Marketplace offer/counter -- this
    // buyer negotiated a different price than the listing's public
    // sale_price, and checkout must charge THEM that agreed amount, not
    // what everyone else sees on the listing.
    const effectivePrice = typeof agreedPrice === 'number' ? agreedPrice : AppState.currentListing.salePrice;

    AppState.checkoutStep = DEFAULT_CHECKOUT_STEP;
    AppState.currentOrder = {
        listing: { ...AppState.currentListing, salePrice: effectivePrice },
        buyerName: AppState.currentUser.name,
        buyerEmail: AppState.currentUser.email,
        buyerPhone: '',
        ...GiftlioPricing.calculateCheckoutTotal(effectivePrice)
    };

    updateCheckoutSteps();
    renderCheckoutSummary();
    hydrateCheckoutBuyerFields();
    router('checkout', { historyMode: 'push' });
}

function hydrateCheckoutBuyerFields() {
    if (!AppState.currentOrder) return;
    document.getElementById('buyerName').value = AppState.currentOrder.buyerName || '';
    document.getElementById('buyerEmail').value = AppState.currentOrder.buyerEmail || '';
    document.getElementById('buyerPhone').value = AppState.currentOrder.buyerPhone || '';
}

function updateCheckoutSteps() {
    for (let i = 1; i <= MAX_CHECKOUT_STEP; i++) {
        document.getElementById(`step${i}`).classList.toggle('active', i <= AppState.checkoutStep);
    }

    document.getElementById('checkoutStep1').classList.toggle('hidden', AppState.checkoutStep !== 1);
    document.getElementById('checkoutStep2').classList.toggle('hidden', AppState.checkoutStep !== 2);
    document.getElementById('checkoutStep3').classList.toggle('hidden', AppState.checkoutStep !== 3);
    document.getElementById('checkoutStep4').classList.toggle('hidden', AppState.checkoutStep !== 4);
}

function renderCheckoutSummary() {
    const listing = AppState.currentOrder?.listing;
    if (!listing) return;

    const fee = AppState.currentOrder.serviceFee;
    const total = AppState.currentOrder.total;

    document.getElementById('orderSummary').innerHTML = `
        <h3 style="margin-bottom: 16px; color: var(--navy);">Order Summary</h3>
        <div class="summary-row">
            <span>${listing.brand} Gift Card</span>
            <span>${formatCurrency(listing.faceValue)} value</span>
        </div>
        <div class="summary-row">
            <span>Selling Price</span>
            <span>${formatCurrency(listing.salePrice)}</span>
        </div>
        <div class="summary-row">
            <span>Service Fee (5%)</span>
            <span>${formatCurrency(fee)}</span>
        </div>
        <div class="summary-row total">
            <span>Total</span>
            <span>${formatCurrency(total)}</span>
        </div>
        <p class="gst-note" style="text-align: right; margin-top: 4px;">GST included</p>
    `;
}

function goToCheckoutStep(step) {
    if (step === 3) {
        clearErrors();
        const name = document.getElementById('buyerName').value.trim();
        const email = document.getElementById('buyerEmail').value.trim();
        const phone = document.getElementById('buyerPhone').value.trim();

        let hasError = false;
        if (name.length < 2) {
            setFieldError('buyerName', 'nameError', 'Enter your full name');
            hasError = true;
        }
        if (!isValidEmail(email)) {
            setFieldError('buyerEmail', 'emailError', 'Enter a valid email address');
            hasError = true;
        }
        if (phone.length < 8) {
            setFieldError('buyerPhone', 'phoneError', 'Enter a valid phone number');
            hasError = true;
        }
        if (hasError) return;

        AppState.currentOrder.buyerName = name;
        AppState.currentOrder.buyerEmail = email;
        AppState.currentOrder.buyerPhone = phone;
    }

    AppState.checkoutStep = normalizeCheckoutStep(step);
    updateCheckoutSteps();
    syncHistory('checkout', 'push');
}

async function placeOrder() {
    document.getElementById('termsCheckError').textContent = '';
    if (!document.getElementById('termsCheck').checked) {
        document.getElementById('termsCheckError').textContent = 'You must agree to the Terms and Conditions and Privacy Policy to continue';
        showToast('warning', 'Please agree to the Terms and Conditions');
        return;
    }

    if (!AppState.currentOrder?.listing || !AppState.currentUser) return;

    const listing = AppState.currentOrder.listing;

    try {
        await withLoading(async () => {
            const response = await fetch('/api/create-checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    listingId: listing.id,
                    brand: listing.brand,
                    faceValue: listing.faceValue,
                    salePrice: listing.salePrice,
                    serviceFee: AppState.currentOrder.serviceFee,
                    total: AppState.currentOrder.total,
                    buyerId: AppState.currentUser.id,
                    buyerName: AppState.currentOrder.buyerName,
                    buyerEmail: AppState.currentOrder.buyerEmail,
                    buyerPhone: AppState.currentOrder.buyerPhone
                })
            });

            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to start checkout.');

            // Hand off to Stripe's own hosted payment page. The order row
            // and listing status change only happen after Stripe confirms
            // the payment succeeded (handled server-side, not here).
            window.location.href = data.url;
        });
    } catch (error) {
        showError(error, 'Unable to start checkout. Please try again.');
    }
}

/**
 * Handles the browser landing back on the app after Stripe Checkout,
 * via the success_url / cancel_url set in api/create-checkout.js.
 * NOTE: the order itself is created by the webhook (server-side), not
 * here -- this just gives the buyer immediate feedback and cleans up the
 * URL. There can be a short delay between this redirect and the order
 * actually appearing in My Orders while the webhook finishes running.
 */
function handleStripeRedirectReturn() {
    const params = new URLSearchParams(window.location.search);
    const checkoutResult = params.get('checkout');
    if (!checkoutResult) return;

    // Clean the query params out of the URL so refreshing doesn't re-trigger this.
    // The subsequent router() call below sets the final correct path.
    const cleanUrl = `${window.location.origin}${window.location.pathname}`;
    window.history.replaceState(window.history.state, '', cleanUrl);

    if (checkoutResult === 'success') {
        showToast('success', "Payment received! We're finalising your order now — it will appear in My Orders shortly.");
        router('orders', { historyMode: 'replace' });
    } else if (checkoutResult === 'cancelled') {
        showToast('info', 'Checkout was cancelled. Your card was not charged.');
        router('browse', { historyMode: 'replace' });
    }
}

async function renderOrders() {
    if (!AppState.currentUser) {
        router('login');
        return;
    }

    const table = document.getElementById('ordersTable');
    document.getElementById('ordersEmpty').classList.add('hidden');
    table.innerHTML = renderSkeletonTableRows(7);

    try {
        await withLoading(async () => {
            const { data, error } = await supabaseClient
                .from('orders')
                .select('*')
                .eq('buyer_id', AppState.currentUser.id)
                .order('created_at', { ascending: false });

            if (error) throw error;

            const orders = (data || []).map(orderRowToView);
            const empty = document.getElementById('ordersEmpty');

            if (orders.length === 0) {
                table.innerHTML = '';
                empty.classList.remove('hidden');
                return;
            }

            empty.classList.add('hidden');

            const badgeClass = {
                'Pending Verification': 'badge-yellow',
                Delivered: 'badge-green',
                Refunded: 'badge-red'
            };

            table.innerHTML = `
                <table>
                    <thead>
                        <tr>
                            <th>Order ID</th>
                            <th>Brand</th>
                            <th>Value</th>
                            <th>Price Paid</th>
                            <th>Date</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${orders
                            .map(
                                (o) => `
                            <tr>
                                <td data-label="Order ID">${o.id}</td>
                                <td data-label="Brand">${o.brand}</td>
                                <td data-label="Value">${formatCurrency(o.faceValue)}</td>
                                <td data-label="Price Paid">${formatCurrency(o.total)}</td>
                                <td data-label="Date">${new Date(o.date).toLocaleDateString('en-NZ')}</td>
                                <td data-label="Status"><span class="badge ${badgeClass[o.status] || 'badge-gray'}">${o.status}</span></td>
                                <td data-label="Actions"><button class="btn btn-outline btn-sm" onclick="viewOrderDetail('${o.dbId}')">View</button></td>
                            </tr>
                        `
                            )
                            .join('')}
                    </tbody>
                </table>
            `;
        });
    } catch (error) {
        showError(error, 'Unable to load orders.');
    }
}

async function viewOrderDetail(orderDbId) {
    try {
        await withLoading(async () => {
            const { data, error } = await supabaseClient.from('orders').select('*').eq('id', orderDbId).single();
            if (error) throw error;

            const order = orderRowToView(data);
            const isDelivered = order.status === 'Delivered';

            document.getElementById('modalContent').innerHTML = `
                <h2 style="color: var(--navy); margin-bottom: 20px;">Order Details</h2>
                <div style="display: grid; gap: 12px; margin-bottom: 20px;">
                    <p><strong>Order ID:</strong> ${order.id}</p>
                    <p><strong>Brand:</strong> ${order.brand}</p>
                    <p><strong>Card Value:</strong> ${formatCurrency(order.faceValue)}</p>
                    <p><strong>Price Paid:</strong> ${formatCurrency(order.total)} (includes ${formatCurrency(order.serviceFee)} fee, GST included)</p>
                    <p><strong>Purchase Date:</strong> ${new Date(order.date).toLocaleString('en-NZ')}</p>
                    <p><strong>Status:</strong> <span class="badge ${order.status === 'Pending Verification' ? 'badge-yellow' : order.status === 'Delivered' ? 'badge-green' : 'badge-red'}">${order.status}</span></p>
                    <p><strong>Delivery Email:</strong> ${order.buyerEmail}</p>
                </div>
                ${
                    isDelivered
                        ? `
                    <div style="background: var(--green-light); padding: 16px; border-radius: var(--radius); margin-bottom: 20px;">
                        <p style="font-weight: 700; color: var(--green); margin-bottom: 8px;">Your Gift Card Details</p>
                        <p><strong>Card Number:</strong> Securely stored in your account vault</p>
                        <p><strong>PIN:</strong> Securely stored in your account vault</p>
                        <p style="font-size: 12px; color: var(--gray-600); margin-top: 8px;">Full details sent to your email</p>
                    </div>
                `
                        : `
                    <div style="background: var(--yellow-light); padding: 16px; border-radius: var(--radius); margin-bottom: 20px;">
                        <p>Your card is being verified. You will receive an email within 24 hours with the gift card details.</p>
                    </div>
                `
                }
                <button class="btn btn-primary" onclick="closeModal()">Close</button>
            `;

            document.getElementById('modalOverlay').classList.remove('hidden');
            document.getElementById('detailModal').classList.remove('hidden');
        });
    } catch (error) {
        showError(error, 'Unable to load order details.');
    }
}

/**
 * Renders the Sell page. Always fetches brand discounts fresh (never
 * trusts a value loaded earlier in the session) so an admin's just-saved
 * change to a discount percentage or Instant Sell availability takes
 * effect the moment a seller opens this page -- no stale cache, no
 * redeploy needed.
 */
async function renderSellPage() {
    await loadBrandDiscounts();
    populateBrandDropdown();
    updateOffer();
}

/**
 * Fills the retailer dropdown based on the currently selected sale mode.
 * Instant Sell only shows brands with instant_sell_available = true in the
 * database. Marketplace mode is never restricted by that flag -- a brand
 * hidden from Instant Sell must still be sellable on the Marketplace.
 */
/**
 * Renders the retailer tile picker on the Sell form. Every retailer is
 * ALWAYS shown, in its normal position -- disabling a retailer in the
 * admin panel never removes or hides it here. A disabled retailer instead
 * gets a "Temporarily Unavailable" badge and becomes unselectable, with a
 * toast explaining why if a seller taps it anyway.
 *
 * A retailer can be unavailable two ways: retailer_enabled=false blocks it
 * for every sale mode; instant_sell_available=false blocks Instant Sell
 * specifically while leaving Marketplace open (the older, more granular
 * toggle, still respected alongside the newer whole-retailer one).
 */
function populateBrandDropdown() {
    const select = document.getElementById('subBrand');
    const tileGrid = document.getElementById('brandTilePicker');
    if (!select || !tileGrid) return;

    const mode = getSelectedSaleMode();
    const previousValue = select.value;
    const allBrands = Object.keys(BRAND_COLORS).sort();

    const isUnavailable = (brand) => {
        const config = AppState.brandDiscounts[brand];
        if (!config) return false; // no row yet -- stays selectable, just unapprovable later
        if (!config.retailerEnabled) return true;
        if (mode === 'instant' && !config.instantSellAvailable) return true;
        return false;
    };

    // Hidden select stays in sync for every bit of existing code that
    // reads document.getElementById('subBrand').value.
    select.innerHTML =
        '<option value="">Select a brand</option>' +
        allBrands.map((b) => `<option ${b === previousValue ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('') +
        '<option value="Other"' + (previousValue === 'Other' ? ' selected' : '') + '>Other</option>';

    tileGrid.innerHTML = allBrands
        .map((brand) => {
            const unavailable = isUnavailable(brand);
            const selected = brand === previousValue;
            return `
                <button type="button" class="retailer-tile ${selected ? 'selected' : ''} ${unavailable ? 'unavailable' : ''}"
                        role="radio" aria-checked="${selected}" ${unavailable ? 'aria-disabled="true"' : ''}
                        onclick="${unavailable ? `showRetailerUnavailableNotice('${escapeJsString(brand)}')` : `selectBrandTile('${escapeJsString(brand)}')`}">
                    ${retailerBadgeHTML(brand)}
                    ${unavailable ? '<span class="unavailable-badge">Temporarily Unavailable</span>' : ''}
                </button>
            `;
        })
        .join('');

    if (previousValue && isUnavailable(previousValue)) {
        select.value = '';
        updateOffer();
        populateBrandDropdown();
    }
}

function selectBrandTile(brand) {
    document.getElementById('subBrand').value = brand;
    populateBrandDropdown();
    updateOffer();
}

function showRetailerUnavailableNotice(brand) {
    showToast('warning', `${brand} is temporarily unavailable right now. You can't submit a card for this retailer until it's re-enabled -- try another retailer or check back soon.`);
}

function showSellerTab(tab, event) {
    document.querySelectorAll('.seller-tab').forEach((t) => t.classList.add('hidden'));
    document.querySelectorAll('.sidebar-btn').forEach((b) => b.classList.remove('active'));

    const tabMap = {
        overview: 'sellerOverview',
        submit: 'sellerSubmit',
        submissions: 'sellerSubmissions',
        earnings: 'sellerEarnings',
        settings: 'sellerSettings',
        offers: 'sellerOffers'
    };

    const targetTabId = tabMap[tab];
    if (!targetTabId) return;

    document.getElementById(targetTabId).classList.remove('hidden');
    if (event?.target) {
        event.target.classList.add('active');
    }

    if (tab === 'submissions') renderSellerSubmissions();
    if (tab === 'earnings') renderSellerEarnings();
    if (tab === 'settings') renderSellerSettings();
    if (tab === 'offers') renderSellerOffers();
}

async function renderSellerDashboard() {
    if (!AppState.currentUser) {
        router('login');
        return;
    }

    document.getElementById('sellerOverviewEmpty').classList.add('hidden');
    document.getElementById('sellerOverviewStats').classList.add('hidden');
    const skeletonEl = document.getElementById('sellerOverviewSkeleton');
    skeletonEl.innerHTML = renderSkeletonStatCards(4);
    skeletonEl.classList.remove('hidden');

    try {
        await withLoading(async () => {
            const [{ data: submissionsData, error: submissionsError }, { data: listingsData, error: listingsError }] = await Promise.all([
                supabaseClient
                    .from('submissions')
                    .select('*')
                    .eq('seller_id', AppState.currentUser.id)
                    .order('created_at', { ascending: false }),
                supabaseClient
                    .from('listings')
                    .select('*')
                    .eq('seller_id', AppState.currentUser.id)
                    .order('created_at', { ascending: false })
            ]);

            if (submissionsError) throw submissionsError;
            if (listingsError) throw listingsError;

            const submissions = (submissionsData || []).map(submissionRowToView);
            const listings = (listingsData || []).map(listingRowToView);

            document.getElementById('sellerOverviewSkeleton').classList.add('hidden');

            const emptyState = document.getElementById('sellerOverviewEmpty');
            const statsView = document.getElementById('sellerOverviewStats');

            if (submissions.length === 0) {
                emptyState.classList.remove('hidden');
                statsView.classList.add('hidden');
                return;
            }

            emptyState.classList.add('hidden');
            statsView.classList.remove('hidden');

            const totalSubmitted = submissions.length;
            const cardsSold = listings.filter((l) => l.status === 'sold').length;

            const instantEarned = submissions
                .filter((s) => s.saleMode === 'instant' && ['Listed', 'Sold', 'Approved'].includes(s.status))
                .reduce((sum, s) => sum + (s.offerAmount || 0), 0);
            const marketplaceEarned = listings
                .filter((l) => l.saleMode === 'marketplace' && l.status === 'sold')
                .reduce((sum, l) => sum + (l.sellerPayoutAmount || 0), 0);
            const totalEarnings = instantEarned + marketplaceEarned;

            const instantPending = submissions
                .filter((s) => s.saleMode === 'instant' && ['Listed', 'Approved'].includes(s.status))
                .reduce((sum, s) => sum + (s.offerAmount || 0), 0);
            const pendingPayout = instantPending;

            document.getElementById('totalSubmitted').textContent = totalSubmitted;
            document.getElementById('cardsSold').textContent = cardsSold;
            document.getElementById('totalEarnings').textContent = formatCurrency(totalEarnings);
            document.getElementById('pendingPayout').textContent = formatCurrency(pendingPayout);

            const recent = submissions.slice(0, 5);
            document.getElementById('sellerActivity').innerHTML =
                recent.length === 0
                    ? '<p style="color: var(--gray-500);">No activity yet</p>'
                    : recent
                          .map(
                              (s) => `
                        <div style="padding: 12px; border-bottom: 1px solid var(--gray-200); font-size: 14px;">
                            <strong>${s.brand}</strong> - ${s.status} - ${new Date(s.createdAt).toLocaleDateString('en-NZ')}
                        </div>
                    `
                          )
                          .join('');

            document.querySelectorAll('.seller-tab').forEach((t) => t.classList.add('hidden'));
            document.getElementById('sellerOverview').classList.remove('hidden');
            document.querySelectorAll('.sidebar-btn').forEach((b) => b.classList.remove('active'));
            document.querySelector('.sidebar-btn')?.classList.add('active');
        });
    } catch (error) {
        document.getElementById('sellerOverviewSkeleton').classList.add('hidden');
        showError(error, 'Unable to load seller dashboard.');
    }
}

function getSelectedSaleMode() {
    const checked = document.querySelector('input[name="saleMode"]:checked');
    return checked ? checked.value : 'instant';
}

function handleSaleModeChange() {
    const mode = getSelectedSaleMode();
    document.querySelectorAll('.sale-mode-option').forEach((opt) => {
        opt.classList.toggle('selected', opt.querySelector('input').value === mode);
    });
    document.getElementById('sellerPriceGroup').classList.toggle('hidden', mode !== 'marketplace');
    populateBrandDropdown();
    updateOffer();
}

function updateOffer() {
    const mode = getSelectedSaleMode();
    const offerLabel = document.getElementById('offerLabel');
    const offerNote = document.getElementById('offerNote');

    if (mode === 'marketplace') {
        const askingPrice = parseFloat(document.getElementById('subSellerPrice').value) || 0;
        const payout = askingPrice * (1 - MARKETPLACE_COMMISSION_RATE);
        offerLabel.innerHTML = `You'll receive: <strong id="offerAmount">${formatCurrency(payout)}</strong>`;
        offerNote.textContent = 'Paid out once a buyer purchases your card, after 10% commission';
        return;
    }

    const balance = parseFloat(document.getElementById('subBalance').value) || 0;
    const brand = document.getElementById('subBrand').value;
    const brandConfig = brand ? AppState.brandDiscounts[brand] : null;

    if (!brand) {
        offerLabel.innerHTML = `Estimated offer: <strong id="offerAmount">$0.00</strong>`;
        offerNote.textContent = 'Select a retailer to see your offer';
        return;
    }

    if (!brandConfig) {
        offerLabel.innerHTML = `Estimated offer: <strong id="offerAmount">$0.00</strong>`;
        offerNote.textContent = `${brand} has no discount configured yet -- contact support before submitting`;
        return;
    }

    // The ONLY calculation path: current balance x this brand's specific
    // percentage from the database. Never a flat rate, never a guess.
    const priced = GiftlioPricing.calculateSalePrice(balance, brandConfig.discountPercent);
    offerLabel.innerHTML = `Estimated offer: <strong id="offerAmount">${formatCurrency(priced.salePrice)}</strong>`;
    offerNote.textContent = `${brand}'s current rate: you receive ${100 - brandConfig.discountPercent}% of the balance, paid once approved`;
}

async function handleSubmission() {
    if (!AppState.currentUser) {
        router('login');
        return;
    }

    if (AppState.currentUser.suspended) {
        showToast('error', `Your account is suspended and can't submit new cards. Reason: ${AppState.currentUser.suspendedReason || 'contact support'}.`);
        return;
    }

    clearErrors();

    const brand = document.getElementById('subBrand').value;
    const valueRaw = document.getElementById('subValue').value;
    const balanceRaw = document.getElementById('subBalance').value;
    const value = Number(valueRaw);
    const balance = Number(balanceRaw);
    const expiry = document.getElementById('subExpiry').value;
    const cardNum = document.getElementById('subCardNum').value;
    const pin = document.getElementById('subPin').value;
    const terms = document.getElementById('subTerms').checked;
    const saleMode = getSelectedSaleMode();
    const sellerSetPriceRaw = saleMode === 'marketplace' ? document.getElementById('subSellerPrice').value : null;
    const sellerSetPrice = sellerSetPriceRaw !== null ? Number(sellerSetPriceRaw) : null;

    let hasError = false;
    if (!brand) {
        setFieldError('subBrand', 'subBrandError', 'Select which retailer this card is from');
        hasError = true;
    } else {
        await loadBrandDiscounts();
        const brandConfig = AppState.brandDiscounts[brand];
        const blockedForThisMode = brandConfig && (!brandConfig.retailerEnabled || (saleMode === 'instant' && !brandConfig.instantSellAvailable));
        if (blockedForThisMode) {
            setFieldError('subBrand', 'subBrandError', `${brand} is temporarily unavailable. Please choose another retailer.`);
            hasError = true;
        }
    }

    const faceValueCheck = GiftlioPricing.validateFaceValue(valueRaw);
    if (!faceValueCheck.valid) {
        setFieldError('subValue', 'subValueError', faceValueCheck.error);
        hasError = true;
    }

    // Only check the balance against face value if the face value itself
    // was valid -- otherwise "balance exceeds value" is a confusing error
    // to show on top of an already-broken value field.
    const balanceCheck = GiftlioPricing.validateBalance(balanceRaw, faceValueCheck.valid ? value : null);
    if (!balanceCheck.valid) {
        setFieldError('subBalance', 'subBalanceError', balanceCheck.error);
        hasError = true;
    }

    if (saleMode === 'marketplace') {
        const priceCheck = GiftlioPricing.validateFaceValue(sellerSetPriceRaw);
        if (!priceCheck.valid) {
            setFieldError('subSellerPrice', 'subSellerPriceError', 'Enter your asking price');
            hasError = true;
        } else if (balanceCheck.valid && sellerSetPrice > balance) {
            setFieldError('subSellerPrice', 'subSellerPriceError', "Asking price can't be more than the card's balance");
            hasError = true;
        }
    }
    if (!expiry) {
        setFieldError('subExpiry', 'subExpiryError', 'Enter the card\'s expiry date');
        hasError = true;
    }
    if (!cardNum) {
        setFieldError('subCardNum', 'subCardNumError', 'Enter the gift card number');
        hasError = true;
    }
    if (!terms) {
        document.getElementById('subTermsError').textContent = 'You must confirm this before submitting';
        hasError = true;
    }
    if (hasError) return;

    let offerAmount;
    if (saleMode === 'marketplace') {
        offerAmount = sellerSetPrice * (1 - MARKETPLACE_COMMISSION_RATE);
    } else {
        // The ONLY calculation path for Instant Sell: current balance x
        // this brand's specific percentage, freshly loaded from the
        // database. Never a flat rate, never a silent guess -- a brand
        // with no configured percentage blocks submission entirely rather
        // than storing a wrong offer.
        await loadBrandDiscounts();
        const brandConfig = AppState.brandDiscounts[brand];
        const priced = GiftlioPricing.calculateSalePrice(balance, brandConfig ? brandConfig.discountPercent : undefined);
        if (priced.error) {
            setFieldError('subBrand', 'subBrandError', `${brand} has no discount percentage configured yet. Please contact support@giftlio.co.nz.`);
            return;
        }
        offerAmount = priced.salePrice;
    }

    const submissionPublicId = generatePublicId('SUB');

    try {
        await withLoading(async () => {
            const { error } = await supabaseClient.from('submissions').insert({
                public_id: submissionPublicId,
                seller_id: AppState.currentUser.id,
                seller_name: AppState.currentUser.name,
                brand,
                face_value: value,
                current_balance: balance,
                expiry_date: expiry,
                card_number: cardNum,
                pin: pin || null,
                receipt_filename: document.getElementById('fileName').textContent || null,
                offer_amount: offerAmount,
                sale_mode: saleMode,
                seller_set_price: sellerSetPrice,
                status: 'pending_review'
            });

            if (error) throw error;
        });

        await notifyBoth({
            eventType: 'submission_received',
            relatedId: null,
            adminSubject: `New Submission for Review: ${brand} #${submissionPublicId}`,
            adminBody: `<p><strong>Retailer:</strong> ${escapeHtml(brand)}</p>
             <p><strong>Original Value:</strong> ${formatCurrency(value)}</p>
             <p><strong>Current Balance:</strong> ${formatCurrency(balance)}</p>
             <p><strong>Card Number:</strong> ${escapeHtml(cardNum)}</p>
             <p><strong>PIN:</strong> ${pin ? escapeHtml(pin) : 'Not provided'}</p>
             <p><strong>Expiry:</strong> ${escapeHtml(expiry)}</p>
             <p><strong>Sale Mode:</strong> ${saleMode}${saleMode === 'marketplace' ? ` (seller asking price: ${formatCurrency(sellerSetPrice)})` : ''}</p>
             <p><strong>Calculated Offer:</strong> ${formatCurrency(offerAmount)}</p>
             <p><strong>Seller:</strong> ${escapeHtml(AppState.currentUser.name)} (${escapeHtml(AppState.currentUser.email)})</p>
             <p><strong>Submitted:</strong> ${new Date().toLocaleString('en-NZ')}</p>
             <p><a href="${window.location.origin}/admin">Review this submission in the admin panel</a></p>`,
            sellerId: AppState.currentUser.id,
            sellerSubject: `We've received your ${brand} card submission`,
            sellerBody: `<p>Hi ${escapeHtml(AppState.currentUser.name)},</p>
             <p>We've received your ${escapeHtml(brand)} gift card submission (#${escapeHtml(submissionPublicId)}) and it's now being manually verified. We'll email you as soon as it's reviewed.</p>`
        });

        showToast('success', `Your gift card has been submitted for manual verification. Submission ID: ${submissionPublicId}`);
        document.getElementById('submissionForm').reset();
        document.getElementById('fileName').textContent = '';
        handleSaleModeChange();
        showSellerTab('submissions');
    } catch (error) {
        showError(error, 'Unable to submit your gift card.');
    }
}

async function renderSellerSubmissions() {
    if (!AppState.currentUser) return;

    document.getElementById('submissionsTable').innerHTML = renderSkeletonTableRows(3, 3);
    document.getElementById('submissionsEmpty').classList.add('hidden');

    try {
        await withLoading(async () => {
            const { data, error } = await supabaseClient
                .from('submissions')
                .select('*')
                .eq('seller_id', AppState.currentUser.id)
                .order('created_at', { ascending: false });

            if (error) throw error;

            const submissions = (data || []).map(submissionRowToView);
            const table = document.getElementById('submissionsTable');
            const empty = document.getElementById('submissionsEmpty');

            if (submissions.length === 0) {
                table.innerHTML = '';
                empty.classList.remove('hidden');
                return;
            }

            empty.classList.add('hidden');

            // Fetch listing status for approved submissions, so the timeline can
            // honestly show whether Giftlio has since listed/sold the card.
            const submissionIds = submissions.map((s) => s.dbId).filter(Boolean);
            let listingBySubmission = {};
            if (submissionIds.length) {
                const { data: listingRows } = await supabaseClient
                    .from('listings')
                    .select('submission_id, status')
                    .in('submission_id', submissionIds);
                (listingRows || []).forEach((l) => {
                    listingBySubmission[l.submission_id] = l.status;
                });
            }

            table.innerHTML = `
                <div class="submissions-list">
                    ${submissions
                        .map((s) => renderSubmissionCard(s, listingBySubmission[s.dbId]))
                        .join('')}
                </div>
            `;
        });
    } catch (error) {
        showError(error, 'Unable to load submissions.');
    }
}

function renderSubmissionCard(s, listingStatus) {
    const isRejected = s.status === 'Rejected';
    const isPending = s.status === 'Pending Review';
    const isApproved = s.status === 'Approved' || s.status === 'Listed' || s.status === 'Sold';
    const isListed = isApproved && Boolean(listingStatus);
    const isSold = listingStatus === 'sold';
    const isMarketplace = s.saleMode === 'marketplace';

    // The stage ORDER genuinely differs by mode, not just the labels:
    // Instant Sell pays at approval, before the card is even resold, so
    // Payout Sent comes third. Marketplace only pays once a buyer actually
    // purchases, so Payout Sent has to be last -- putting it third for
    // marketplace would misrepresent when the seller's money actually moves.
    const stages = isMarketplace
        ? [
              { key: 'submitted', label: 'Submitted', done: true },
              { key: 'verified', label: 'Being Verified', done: !isPending },
              { key: 'listed', label: 'Listed for Sale', done: isListed },
              { key: 'sold', label: 'Sold to Buyer', done: isSold },
              { key: 'payout', label: 'Payout Sent', done: isSold }
          ]
        : [
              { key: 'submitted', label: 'Submitted', done: true },
              { key: 'verified', label: 'Being Verified', done: !isPending },
              { key: 'payout', label: 'Payout Sent', done: isApproved },
              { key: 'listed', label: 'Listed for Resale', done: isListed },
              { key: 'sold', label: 'Sold to Buyer', done: isSold }
          ];
    const doneCount = stages.filter((st) => st.done).length;
    const currentIndex = stages.findIndex((st) => !st.done);
    const fillPercent = (Math.max(doneCount - 1, 0) / (stages.length - 1)) * 100;

    const badgeMap = { 'Pending Review': 'badge-yellow', Approved: 'badge-green', Rejected: 'badge-red', Listed: 'badge-blue', Sold: 'badge-green' };
    const modeLabel = isMarketplace
        ? `<span class="submission-mode-tag marketplace">Marketplace · 10% commission</span>`
        : `<span class="submission-mode-tag instant">Instant Sell</span>`;

    if (isRejected) {
        return `
            <div class="submission-card">
                <div class="submission-card-head">
                    <div>
                        <strong>${s.brand}</strong> — ${formatCurrency(s.faceValue)}
                        <span class="submission-id">#${s.id}</span>
                    </div>
                    <span class="badge ${badgeMap[s.status]}">${s.status}</span>
                </div>
                <p class="submission-rejected-note">This submission wasn't approved. Check your email for the reason, or contact support@giftlio.co.nz.</p>
            </div>
        `;
    }

    return `
        <div class="submission-card">
            <div class="submission-card-head">
                <div>
                    <strong>${s.brand}</strong> — ${formatCurrency(s.faceValue)}
                    <span class="submission-id">#${s.id}</span>
                    ${modeLabel}
                </div>
                <span class="badge ${badgeMap[s.status]}">${s.status}</span>
            </div>
            <div class="seller-timeline seller-timeline-5">
                <div class="st-fill" style="width:${fillPercent}%"></div>
                ${stages
                    .map(
                        (st, i) => `
                    <div class="st-step ${st.done ? 'done' : i === currentIndex ? 'current' : ''}">
                        <span class="st-dot">${st.done ? TOAST_ICONS.success : i + 1}</span>
                        <p>${st.label}</p>
                    </div>
                `
                    )
                    .join('')}
            </div>
            <p class="submission-offer">${isMarketplace ? 'Your payout' : 'Your offer'}: <strong>${formatCurrency(s.offerAmount)}</strong>${
        isMarketplace ? (isSold ? ' — paid out' : ' (paid once sold)') : isApproved ? ' — paid out' : ' (paid once verified)'
    }</p>
            ${
                listingStatus
                    ? `<p class="submission-resale-note">${
                          isMarketplace
                              ? listingStatus === 'sold'
                                  ? 'A buyer has purchased this listing.'
                                  : 'Your listing is live on the marketplace.'
                              : listingStatus === 'sold'
                              ? 'Giftlio has since resold this card.'
                              : 'This card is now listed for resale on Giftlio.'
                      }</p>`
                    : ''
            }
        </div>
    `;
}

/**
 * Seller-facing offers table -- every offer on any of this seller's
 * Marketplace listings, with accept/reject/counter actions on pending ones.
 */
async function renderSellerOffers() {
    if (!AppState.currentUser) return;
    const table = document.getElementById('sellerOffersTable');
    const empty = document.getElementById('sellerOffersEmpty');
    table.innerHTML = renderSkeletonTableRows(5, 3);
    empty.classList.add('hidden');

    try {
        const { data, error } = await supabaseClient
            .from('listing_offers')
            .select('*, listings(brand, sale_price)')
            .eq('seller_id', AppState.currentUser.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (!data || data.length === 0) {
            table.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }

        table.innerHTML = `
            <table>
                <thead><tr><th>Brand</th><th>Listed At</th><th>Offer</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
                <tbody>
                    ${data
                        .map((o) => {
                            const badgeMap = {
                                pending: 'badge-yellow',
                                accepted: 'badge-green',
                                buyer_accepted_counter: 'badge-green',
                                rejected: 'badge-red',
                                countered: 'badge-blue',
                                withdrawn: 'badge-gray',
                                expired: 'badge-gray'
                            };
                            return `
                        <tr>
                            <td data-label="Brand">${escapeHtml(o.listings?.brand || '')}</td>
                            <td data-label="Listed At">${formatCurrency(o.original_price)}</td>
                            <td data-label="Offer">${formatCurrency(o.offer_amount)}${o.counter_amount ? ` (your counter: ${formatCurrency(o.counter_amount)})` : ''}</td>
                            <td data-label="Status"><span class="badge ${badgeMap[o.status] || 'badge-gray'}">${o.status.replace(/_/g, ' ')}</span></td>
                            <td data-label="Date">${new Date(o.created_at).toLocaleDateString('en-NZ')}</td>
                            <td data-label="Actions">
                                ${
                                    o.status === 'pending'
                                        ? `<button class="btn btn-primary btn-sm" onclick="respondToOffer('${o.id}', 'accept')">Accept</button>
                                           <button class="btn btn-outline btn-sm btn-danger-outline" onclick="respondToOffer('${o.id}', 'reject')">Reject</button>
                                           <button class="btn btn-outline btn-sm" onclick="showCounterInput('${o.id}')">Counter</button>
                                           <div class="hidden" id="counterBox-${o.id}" style="margin-top:6px; display:flex; gap:6px;">
                                               <input type="number" id="counterInput-${o.id}" style="width:90px; padding:6px;" step="0.01">
                                               <button class="btn btn-primary btn-sm" onclick="sendCounter('${o.id}', ${o.original_price})">Send</button>
                                           </div>`
                                        : '<span style="color: var(--gray-400); font-size: 12px;">—</span>'
                                }
                            </td>
                        </tr>
                    `;
                        })
                        .join('')}
                </tbody>
            </table>
        `;
    } catch (error) {
        showError(error, 'Unable to load offers.');
    }
}

function showCounterInput(offerId) {
    document.getElementById(`counterBox-${offerId}`).classList.remove('hidden');
}

async function respondToOffer(offerId, action) {
    try {
        const { data: offer } = await supabaseClient.from('listing_offers').select('*').eq('id', offerId).single();

        await withLoading(async () => {
            const { error } = await supabaseClient
                .from('listing_offers')
                .update({ status: action === 'accept' ? 'accepted' : 'rejected', responded_at: new Date().toISOString() })
                .eq('id', offerId);
            if (error) throw error;
        });

        const { data: buyerProfile } = await supabaseClient.from('profiles').select('email, name').eq('id', offer.buyer_id).single();
        if (buyerProfile?.email) {
            await fetch('/api/notify-seller', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sellerId: offer.buyer_id,
                    subject: action === 'accept' ? `Your offer was accepted!` : `Your offer wasn't accepted`,
                    bodyHtml:
                        action === 'accept'
                            ? `<p>Great news — your offer of ${formatCurrency(offer.offer_amount)} was accepted. Head back to the listing to complete your purchase at this price.</p>`
                            : `<p>The seller declined your offer of ${formatCurrency(offer.offer_amount)}. You're welcome to browse other listings or make a new offer.</p>`,
                    eventType: `offer_${action}ed`
                })
            });
        }

        showToast('success', action === 'accept' ? 'Offer accepted.' : 'Offer rejected.');
        renderSellerOffers();
    } catch (error) {
        showError(error, 'Unable to respond to this offer.');
    }
}

async function sendCounter(offerId, originalPrice) {
    const input = document.getElementById(`counterInput-${offerId}`);
    const amount = Number(input.value);
    const min = originalPrice * (1 - OFFER_RANGE_PCT);
    const max = originalPrice * (1 + OFFER_RANGE_PCT);

    if (!input.value || Number.isNaN(amount) || amount < min || amount > max) {
        showToast('warning', `Counter must be between ${formatCurrency(min)} and ${formatCurrency(max)}.`);
        return;
    }

    try {
        const { data: offer } = await supabaseClient.from('listing_offers').select('buyer_id').eq('id', offerId).single();

        await withLoading(async () => {
            const { error } = await supabaseClient
                .from('listing_offers')
                .update({ status: 'countered', counter_amount: amount, responded_at: new Date().toISOString() })
                .eq('id', offerId);
            if (error) throw error;
        });

        await fetch('/api/notify-seller', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sellerId: offer.buyer_id,
                subject: `The seller countered your offer with ${formatCurrency(amount)}`,
                bodyHtml: `<p>The seller countered your offer with <strong>${formatCurrency(amount)}</strong>. Head back to the listing to accept or walk away.</p>`,
                eventType: 'offer_countered'
            })
        });

        showToast('success', 'Counter offer sent.');
        renderSellerOffers();
    } catch (error) {
        showError(error, 'Unable to send counter offer.');
    }
}

/**
 * Shows the notification preference form only to sellers who've actually
 * used Marketplace mode at least once -- Instant Sell-only sellers get a
 * plain note instead, since they only ever receive 3 fixed emails and
 * there's nothing for them to configure.
 */
async function renderSellerSettings() {
    if (!AppState.currentUser) return;

    try {
        const [{ data: marketplaceSubs }, { data: profile }] = await Promise.all([
            supabaseClient.from('submissions').select('id').eq('seller_id', AppState.currentUser.id).eq('sale_mode', 'marketplace').limit(1),
            supabaseClient.from('profiles').select('notification_preference').eq('id', AppState.currentUser.id).single()
        ]);

        const hasUsedMarketplace = (marketplaceSubs || []).length > 0;
        document.getElementById('notificationPrefGroup').classList.toggle('hidden', !hasUsedMarketplace);
        document.getElementById('instantOnlyNote').classList.toggle('hidden', hasUsedMarketplace);

        if (hasUsedMarketplace) {
            const current = profile?.notification_preference || 'every_event';
            document.querySelectorAll('input[name="notifPref"]').forEach((input) => {
                input.checked = input.value === current;
                input.closest('.sale-mode-option').classList.toggle('selected', input.value === current);
                input.addEventListener('change', () => {
                    document.querySelectorAll('input[name="notifPref"]').forEach((i) => i.closest('.sale-mode-option').classList.toggle('selected', i.checked));
                });
            });
        }
    } catch (error) {
        showError(error, 'Unable to load settings.');
    }
}

async function saveNotificationPreference() {
    const selected = document.querySelector('input[name="notifPref"]:checked');
    if (!selected) {
        showToast('warning', 'Choose a preference first.');
        return;
    }

    try {
        await withLoading(async () => {
            const { error } = await supabaseClient.from('profiles').update({ notification_preference: selected.value }).eq('id', AppState.currentUser.id);
            if (error) throw error;
        });
        showToast('success', 'Notification preference saved.');
    } catch (error) {
        showError(error, 'Unable to save your preference.');
    }
}

async function renderSellerEarnings() {
    if (!AppState.currentUser) return;

    try {
        await withLoading(async () => {
            const [{ data: subData, error: subError }, { data: listingData, error: listingError }] = await Promise.all([
                supabaseClient.from('submissions').select('*').eq('seller_id', AppState.currentUser.id).is('deleted_at', null),
                supabaseClient.from('listings').select('*').eq('seller_id', AppState.currentUser.id)
            ]);
            if (subError) throw subError;
            if (listingError) throw listingError;

            const submissions = (subData || []).map(submissionRowToView);
            const listings = listingData || [];

            // Instant Sell: earned as soon as approved (paid at that point).
            const instantEarned = submissions
                .filter((s) => s.saleMode === 'instant' && ['Listed', 'Sold', 'Approved'].includes(s.status))
                .reduce((sum, s) => sum + (s.offerAmount || 0), 0);

            // Marketplace: only actually earned once the linked listing sells --
            // being listed is not the same as being paid.
            const marketplaceEarned = listings
                .filter((l) => l.sale_mode === 'marketplace' && l.status === 'sold')
                .reduce((sum, l) => sum + Number(l.seller_payout_amount || 0), 0);

            const marketplacePending = listings
                .filter((l) => l.sale_mode === 'marketplace' && l.status === 'active')
                .reduce((sum, l) => sum + Number(l.seller_payout_amount || 0), 0);

            const total = instantEarned + marketplaceEarned;

            document.getElementById('earnTotal').textContent = formatCurrency(total);
            document.getElementById('earnAvailable').textContent = formatCurrency(total);
            document.getElementById('earnPaid').textContent = '$0.00';

            const pendingNote = document.getElementById('earnPendingNote');
            if (pendingNote) {
                if (marketplacePending > 0) {
                    pendingNote.textContent = `Plus ${formatCurrency(marketplacePending)} pending from marketplace listings not yet sold`;
                    pendingNote.classList.remove('hidden');
                } else {
                    pendingNote.classList.add('hidden');
                }
            }
        });
    } catch (error) {
        showError(error, 'Unable to load earnings.');
    }
}

async function renderAdmin() {
    if (!AppState.currentUser || AppState.currentUser.role !== 'admin') {
        router('home');
        return;
    }

    document.getElementById('adminWelcomeEmpty').classList.add('hidden');
    document.getElementById('adminStatsView').classList.add('hidden');
    const adminSkeletonEl = document.getElementById('adminSkeleton');
    adminSkeletonEl.innerHTML = renderSkeletonStatCards(4);
    adminSkeletonEl.classList.remove('hidden');
    document.getElementById('pendingTable').innerHTML = renderSkeletonTableRows(6);
    document.getElementById('pendingEmpty').classList.add('hidden');

    try {
        await withLoading(async () => {
            const [usersRes, listingsRes, submissionsRes, ordersRes] = await Promise.all([
                supabaseClient.from('profiles').select('id'),
                supabaseClient.from('listings').select('*'),
                supabaseClient.from('submissions').select('*').is('deleted_at', null),
                supabaseClient.from('orders').select('*')
            ]);

            if (usersRes.error) throw usersRes.error;
            if (listingsRes.error) throw listingsRes.error;
            if (submissionsRes.error) throw submissionsRes.error;
            if (ordersRes.error) throw ordersRes.error;

            const users = usersRes.data || [];
            const listings = (listingsRes.data || []).map(listingRowToView);
            const submissions = (submissionsRes.data || []).map(submissionRowToView);
            const orders = (ordersRes.data || []).map(orderRowToView);

            const welcomeEmpty = document.getElementById('adminWelcomeEmpty');
            const statsView = document.getElementById('adminStatsView');
            document.getElementById('adminSkeleton').classList.add('hidden');
            // Truly blank slate: only the admin's own account exists, and
            // nothing has ever been listed, submitted, or sold.
            const isBlankSlate = users.length <= 1 && listings.length === 0 && submissions.length === 0 && orders.length === 0;

            if (isBlankSlate) {
                welcomeEmpty.classList.remove('hidden');
                statsView.classList.add('hidden');
                return;
            }

            welcomeEmpty.classList.add('hidden');
            statsView.classList.remove('hidden');

            document.getElementById('adminTotalUsers').textContent = users.length;
            document.getElementById('adminActiveListings').textContent = listings.filter((l) => l.status === 'active').length;
            document.getElementById('adminPending').textContent = submissions.filter((s) => s.statusKey === 'pending_review').length;
            document.getElementById('adminSales').textContent = formatCurrency(orders.reduce((sum, o) => sum + Number(o.total || 0), 0));

            const pending = submissions.filter((s) => s.statusKey === 'pending_review');
            const instantPending = pending.filter((s) => s.saleMode !== 'marketplace');
            const marketplacePending = pending.filter((s) => s.saleMode === 'marketplace');

            renderInstantPendingTable(instantPending);
            renderMarketplacePendingTable(marketplacePending);

            const pendingDelivery = orders.filter((o) => o.statusKey === 'pending_verification');
            const pendingDeliveryTable = document.getElementById('pendingDeliveryTable');
            const pendingDeliveryEmpty = document.getElementById('pendingDeliveryEmpty');

            if (pendingDelivery.length === 0) {
                pendingDeliveryTable.innerHTML = '';
                pendingDeliveryEmpty.classList.remove('hidden');
            } else {
                pendingDeliveryEmpty.classList.add('hidden');
                pendingDeliveryTable.innerHTML = `
                    <table>
                        <thead>
                            <tr>
                                <th>Order ID</th>
                                <th>Buyer</th>
                                <th>Brand</th>
                                <th>Value</th>
                                <th>Price Paid</th>
                                <th>Date</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${pendingDelivery
                                .map(
                                    (o) => `
                                <tr id="order-row-${o.dbId}">
                                    <td data-label="Order ID">${o.id}</td>
                                    <td data-label="Buyer">${escapeHtml(o.buyerName)}<br><span style="color: var(--gray-500); font-size: 12px;">${escapeHtml(o.buyerEmail)}</span></td>
                                    <td data-label="Brand">${escapeHtml(o.brand)}</td>
                                    <td data-label="Value">${formatCurrency(o.faceValue)}</td>
                                    <td data-label="Price Paid">${formatCurrency(o.total)}</td>
                                    <td data-label="Date">${new Date(o.date).toLocaleDateString('en-NZ')}</td>
                                    <td data-label="Action">
                                        <button class="btn btn-primary btn-sm" onclick="deliverOrder('${o.dbId}')">Deliver</button>
                                    </td>
                                </tr>
                            `
                                )
                                .join('')}
                        </tbody>
                    </table>
                `;
            }

            AppState.allListings = listings;
            renderFilteredListingsTable(listings);

            const { data: fullUsers, error: fullUsersError } = await supabaseClient
                .from('profiles')
                .select('id, name, email, role, created_at, suspended')
                .order('created_at', { ascending: false });

            if (fullUsersError) throw fullUsersError;

            document.getElementById('usersTable').innerHTML = `
                <table>
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Email</th>
                            <th>Role</th>
                            <th>Status</th>
                            <th>Joined</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(fullUsers || [])
                            .map(
                                (u) => `
                            <tr>
                                <td data-label="Name">${escapeHtml(u.name)}</td>
                                <td data-label="Email">${escapeHtml(u.email)}</td>
                                <td data-label="Role"><span class="badge ${u.role === 'admin' ? 'badge-red' : u.role === 'seller' ? 'badge-blue' : 'badge-green'}">${u.role}</span></td>
                                <td data-label="Status">${u.suspended ? '<span class="badge badge-red">Suspended</span>' : '<span class="badge badge-green">Active</span>'}</td>
                                <td data-label="Joined">${new Date(u.created_at).toLocaleDateString('en-NZ')}</td>
                                <td data-label="Actions">${
                                    u.role === 'admin'
                                        ? '<span style="color: var(--gray-400); font-size: 12px;">—</span>'
                                        : `<button class="btn btn-sm ${u.suspended ? 'btn-primary' : 'btn-outline btn-danger-outline'}" onclick="toggleSellerSuspension('${u.id}', '${escapeJsString(u.name)}', ${u.suspended})">${u.suspended ? 'Reinstate' : 'Suspend'}</button>`
                                }</td>
                            </tr>
                        `
                            )
                            .join('')}
                    </tbody>
                </table>
            `;
        });

        await renderBrandDiscountsTable();
        await renderAuditLog();
    } catch (error) {
        document.getElementById('adminSkeleton').classList.add('hidden');
        showError(error, 'Unable to load admin dashboard.');
    }
}

/**
 * Renders the Active Listings table from an already-fetched array (client-
 * side filtering, since this admin table isn't expected to hold enough
 * rows to need server-side search at current volume). Called fresh, and
 * again whenever a filter changes.
 */
function switchPendingTab(tab) {
    document.getElementById('tabInstantBtn').classList.toggle('active', tab === 'instant');
    document.getElementById('tabMarketplaceBtn').classList.toggle('active', tab === 'marketplace');
    document.getElementById('instantPendingPanel').classList.toggle('hidden', tab !== 'instant');
    document.getElementById('marketplacePendingPanel').classList.toggle('hidden', tab !== 'marketplace');
}

/** Instant Sell queue: shows the calculated offer, needs only approve/reject. */
function renderInstantPendingTable(pending) {
    const pendingTable = document.getElementById('pendingTable');
    const pendingEmpty = document.getElementById('pendingEmpty');

    if (pending.length === 0) {
        pendingTable.innerHTML = '';
        pendingEmpty.classList.remove('hidden');
        return;
    }
    pendingEmpty.classList.add('hidden');
    pendingTable.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>ID</th><th>Seller</th><th>Brand</th><th>Value</th><th>Balance</th><th>Calculated Offer</th><th>Expiry</th><th>Date</th><th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${pending
                    .map(
                        (s) => `
                    <tr>
                        <td data-label="ID">${s.id}</td>
                        <td data-label="Seller">${escapeHtml(s.sellerName)}</td>
                        <td data-label="Brand">${escapeHtml(s.brand)}</td>
                        <td data-label="Value">${formatCurrency(s.faceValue)}</td>
                        <td data-label="Balance">${formatCurrency(s.currentBalance)}</td>
                        <td data-label="Calculated Offer"><strong>${formatCurrency(s.offerAmount)}</strong></td>
                        <td data-label="Expiry">${s.expiryDate}</td>
                        <td data-label="Date">${new Date(s.createdAt).toLocaleDateString('en-NZ')}</td>
                        <td data-label="Actions">
                            <button class="btn btn-primary btn-sm" onclick="approveSubmissionGuarded(this, '${s.dbId}')">Approve</button>
                            <button class="btn btn-outline btn-sm btn-danger-outline" onclick="rejectSubmission('${s.dbId}')">Reject</button>
                            <button class="btn btn-outline btn-sm" onclick="deleteSubmission('${s.dbId}')">Delete</button>
                        </td>
                    </tr>
                `
                    )
                    .join('')}
            </tbody>
        </table>
    `;
}

/** Marketplace queue: shows the seller's own chosen price, admin only needs
    to verify the balance is correct before letting the listing go live. */
function renderMarketplacePendingTable(pending) {
    const table = document.getElementById('marketplacePendingTable');
    const empty = document.getElementById('marketplacePendingEmpty');

    if (pending.length === 0) {
        table.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');
    table.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>ID</th><th>Seller</th><th>Brand</th><th>Balance</th><th>Seller's Price</th><th>Expiry</th><th>Date</th><th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${pending
                    .map(
                        (s) => `
                    <tr>
                        <td data-label="ID">${s.id}</td>
                        <td data-label="Seller">${escapeHtml(s.sellerName)}</td>
                        <td data-label="Brand">${escapeHtml(s.brand)}</td>
                        <td data-label="Balance">${formatCurrency(s.currentBalance)}</td>
                        <td data-label="Seller's Price"><strong>${s.sellerSetPrice != null ? formatCurrency(s.sellerSetPrice) : '—'}</strong></td>
                        <td data-label="Expiry">${s.expiryDate}</td>
                        <td data-label="Date">${new Date(s.createdAt).toLocaleDateString('en-NZ')}</td>
                        <td data-label="Actions">
                            <button class="btn btn-primary btn-sm" onclick="approveSubmissionGuarded(this, '${s.dbId}')">Verify &amp; List</button>
                            <button class="btn btn-outline btn-sm btn-danger-outline" onclick="rejectSubmission('${s.dbId}')">Reject</button>
                            <button class="btn btn-outline btn-sm" onclick="deleteSubmission('${s.dbId}')">Delete</button>
                        </td>
                    </tr>
                `
                    )
                    .join('')}
            </tbody>
        </table>
    `;
}

function renderFilteredListingsTable(listings) {
    const container = document.getElementById('allListingsTable');
    if (!container) return;

    if (listings.length === 0) {
        container.innerHTML = '<p class="section-subtitle" style="padding: 16px 0;">No listings match these filters.</p>';
        return;
    }

    container.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>ID</th>
                    <th>Brand</th>
                    <th>Value</th>
                    <th>Price</th>
                    <th>Type</th>
                    <th>Seller</th>
                    <th>Status</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${listings
                    .map((l) => {
                        const isZeroBalance = !(l.faceValue > 0) || !(l.salePrice > 0);
                        const displayStatus = l.suspended ? 'suspended' : l.status;
                        const statusBadge =
                            displayStatus === 'active' ? 'badge-green' : displayStatus === 'sold' ? 'badge-blue' : displayStatus === 'suspended' ? 'badge-yellow' : 'badge-gray';
                        return `
                    <tr class="${isZeroBalance ? 'row-warning' : ''}">
                        <td data-label="ID">${l.id.slice(0, 8)}</td>
                        <td data-label="Brand">${escapeHtml(l.brand)}</td>
                        <td data-label="Value">${formatCurrency(l.faceValue)}${
                            isZeroBalance
                                ? '<span class="zero-balance-flag" title="Zero or invalid balance -- should never be purchasable. Investigate this listing."><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>Zero balance</span>'
                                : ''
                        }</td>
                        <td data-label="Price">${formatCurrency(l.salePrice)}</td>
                        <td data-label="Type">${l.saleMode === 'marketplace' ? '<span class="submission-mode-tag marketplace">Marketplace</span>' : '<span class="submission-mode-tag instant">Instant</span>'}</td>
                        <td data-label="Seller"><button class="link-btn" onclick="viewSellerHistory('${l.sellerId}', '${escapeJsString(l.seller)}')">${escapeHtml(l.seller)}</button></td>
                        <td data-label="Status"><span class="badge ${statusBadge}">${displayStatus}</span></td>
                        <td data-label="Actions">
                            ${
                                l.status !== 'sold'
                                    ? `<button class="btn btn-sm ${l.suspended ? 'btn-primary' : 'btn-outline'}" onclick="toggleListingSuspension('${l.id}', '${escapeJsString(l.brand)}', ${l.suspended})">${l.suspended ? 'Unsuspend' : 'Suspend'}</button>
                               <button class="btn btn-outline btn-sm btn-danger-outline" onclick="removeListing('${l.id}', '${escapeJsString(l.brand)}')">Remove</button>`
                                    : '<span style="color: var(--gray-400); font-size: 12px;">Sold — locked</span>'
                            }
                        </td>
                    </tr>
                `;
                    })
                    .join('')}
            </tbody>
        </table>
    `;
}

function applyListingsFilters() {
    const search = document.getElementById('listingsSearchInput').value.toLowerCase().trim();
    const modeFilter = document.getElementById('listingsFilterMode').value;
    const statusFilter = document.getElementById('listingsFilterStatus').value;

    let filtered = AppState.allListings || [];

    if (search) {
        filtered = filtered.filter(
            (l) => l.brand.toLowerCase().includes(search) || l.seller.toLowerCase().includes(search) || String(l.salePrice).includes(search) || String(l.faceValue).includes(search)
        );
    }
    if (modeFilter) {
        filtered = filtered.filter((l) => l.saleMode === modeFilter);
    }
    if (statusFilter === 'suspended') {
        filtered = filtered.filter((l) => l.suspended);
    } else if (statusFilter) {
        filtered = filtered.filter((l) => l.status === statusFilter && !l.suspended);
    }

    renderFilteredListingsTable(filtered);
}

async function toggleListingSuspension(listingId, brand, currentlySuspended) {
    showConfirmModal({
        title: currentlySuspended ? 'Unsuspend Listing' : 'Suspend Listing',
        message: currentlySuspended
            ? `Unsuspend this ${brand} listing? It will reappear in the browse grid.`
            : `Suspend this ${brand} listing? It will be hidden from the browse grid but kept in the database.`,
        confirmLabel: currentlySuspended ? 'Unsuspend' : 'Suspend Listing',
        danger: !currentlySuspended,
        requireReason: !currentlySuspended,
        reasonLabel: 'Reason for suspension',
        onConfirm: async (reason) => {
            try {
                await withLoading(async () => {
                    const { error } = await supabaseClient
                        .from('listings')
                        .update({
                            suspended: !currentlySuspended,
                            suspended_reason: currentlySuspended ? null : reason,
                            suspended_at: currentlySuspended ? null : new Date().toISOString(),
                            suspended_by: currentlySuspended ? null : AppState.currentUser.id
                        })
                        .eq('id', listingId);
                    if (error) throw error;
                });
                await logAdminAction(currentlySuspended ? 'unsuspend_listing' : 'suspend_listing', 'listing', listingId, brand, { reason });
                showToast('success', currentlySuspended ? 'Listing unsuspended.' : 'Listing suspended.');
                renderAdmin();
            } catch (error) {
                showError(error, 'Unable to update listing.');
            }
        }
    });
}

async function removeListing(listingId, brand) {
    showConfirmModal({
        title: 'Remove Listing',
        message: `Permanently remove this ${brand} listing from the marketplace? This cannot be undone from the UI.`,
        confirmLabel: 'Remove Permanently',
        danger: true,
        requireReason: true,
        reasonLabel: 'Reason for removal',
        onConfirm: async (reason) => {
            try {
                await withLoading(async () => {
                    const { error } = await supabaseClient
                        .from('listings')
                        .update({ status: 'inactive', removed_at: new Date().toISOString(), removed_by: AppState.currentUser.id })
                        .eq('id', listingId);
                    if (error) throw error;
                });
                await logAdminAction('remove_listing', 'listing', listingId, brand, { reason });
                showToast('success', 'Listing removed.');
                renderAdmin();
            } catch (error) {
                showError(error, 'Unable to remove listing.');
            }
        }
    });
}

/**
 * Shows a seller's full history in a modal -- every submission and every
 * listing they've ever had, for context before taking action on them.
 */
async function viewSellerHistory(sellerId, sellerName) {
    const overlay = document.getElementById('sellerHistoryOverlay');
    const modal = document.getElementById('sellerHistoryModal');
    const content = document.getElementById('sellerHistoryContent');
    content.innerHTML = `<h2 style="color: var(--navy); margin-bottom: 16px;">${escapeHtml(sellerName)}'s History</h2>` + renderSkeletonLines(4);
    overlay.classList.remove('hidden');
    modal.classList.remove('hidden');

    try {
        const [{ data: subs, error: subsError }, { data: listings, error: listingsError }, { data: profile, error: profileError }] = await Promise.all([
            supabaseClient.from('submissions').select('*').eq('seller_id', sellerId).is('deleted_at', null).order('created_at', { ascending: false }),
            supabaseClient.from('listings').select('*').eq('seller_id', sellerId).order('created_at', { ascending: false }),
            supabaseClient.from('profiles').select('created_at, suspended, verification_status').eq('id', sellerId).single()
        ]);
        if (subsError) throw subsError;
        if (listingsError) throw listingsError;
        if (profileError) throw profileError;

        const rejectedCount = (subs || []).filter((s) => s.status === 'rejected').length;
        const soldCount = (listings || []).filter((l) => l.status === 'sold').length;

        content.innerHTML = `
            <h2 style="color: var(--navy); margin-bottom: 4px;">${escapeHtml(sellerName)}'s History</h2>
            <p class="section-subtitle" style="margin-bottom: 16px;">
                Account since ${new Date(profile.created_at).toLocaleDateString('en-NZ')} ·
                ${profile.suspended ? '<span class="badge badge-red">Suspended</span>' : '<span class="badge badge-green">Active</span>'} ·
                Verification: ${escapeHtml(profile.verification_status)}
            </p>
            <div class="summary-cards" style="margin-bottom: 20px;">
                <div class="summary-card"><div class="summary-label">Submissions</div><div class="summary-value">${(subs || []).length}</div></div>
                <div class="summary-card"><div class="summary-label">Rejected</div><div class="summary-value">${rejectedCount}</div></div>
                <div class="summary-card"><div class="summary-label">Cards Sold</div><div class="summary-value">${soldCount}</div></div>
            </div>
            <h3 style="margin-bottom: 8px;">Recent Submissions</h3>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>Brand</th><th>Value</th><th>Status</th><th>Date</th></tr></thead>
                    <tbody>
                        ${(subs || [])
                            .slice(0, 10)
                            .map(
                                (s) => `<tr><td data-label="Brand">${escapeHtml(s.brand)}</td><td data-label="Value">${formatCurrency(s.face_value)}</td><td data-label="Status">${escapeHtml(s.status)}</td><td data-label="Date">${new Date(s.created_at).toLocaleDateString('en-NZ')}</td></tr>`
                            )
                            .join('')}
                    </tbody>
                </table>
            </div>
        `;
    } catch (error) {
        content.innerHTML = '<p>Unable to load seller history.</p>';
        console.error(error);
    }
}

function closeSellerHistoryModal() {
    document.getElementById('sellerHistoryOverlay').classList.add('hidden');
    document.getElementById('sellerHistoryModal').classList.add('hidden');
}

/**
 * Renders the admin Audit Log table with the current filter selections.
 * Called on the admin page load, and again whenever a filter is applied.
 */
async function renderAuditLog() {
    const container = document.getElementById('auditLogTable');
    if (!container) return;
    container.innerHTML = renderSkeletonTableRows(5, 6);

    try {
        let query = supabaseClient.from('admin_audit_log').select('*').order('created_at', { ascending: false }).limit(200);

        const adminFilter = document.getElementById('auditFilterAdmin').value;
        const actionFilter = document.getElementById('auditFilterAction').value;
        const fromFilter = document.getElementById('auditFilterFrom').value;
        const toFilter = document.getElementById('auditFilterTo').value;

        if (adminFilter) query = query.eq('admin_id', adminFilter);
        if (actionFilter) query = query.eq('action_type', actionFilter);
        if (fromFilter) query = query.gte('created_at', `${fromFilter}T00:00:00`);
        if (toFilter) query = query.lte('created_at', `${toFilter}T23:59:59`);

        const { data, error } = await query;
        if (error) throw error;

        AppState.auditLogRows = data || [];

        const adminSelect = document.getElementById('auditFilterAdmin');
        const actionSelect = document.getElementById('auditFilterAction');
        if (adminSelect.options.length === 1) {
            const uniqueAdmins = [...new Map((data || []).map((r) => [r.admin_id, r.admin_name])).entries()];
            uniqueAdmins.forEach(([id, name]) => {
                if (!id) return;
                adminSelect.insertAdjacentHTML('beforeend', `<option value="${id}">${escapeHtml(name)}</option>`);
            });
        }
        if (actionSelect.options.length === 1) {
            const uniqueActions = [...new Set((data || []).map((r) => r.action_type))];
            uniqueActions.forEach((a) => {
                actionSelect.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(a)}">${escapeHtml(a.replace(/_/g, ' '))}</option>`);
            });
        }

        if (!data || data.length === 0) {
            container.innerHTML = '<p class="section-subtitle" style="padding: 16px 0;">No audit log entries match these filters.</p>';
            return;
        }

        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>When</th>
                        <th>Admin</th>
                        <th>Action</th>
                        <th>Target</th>
                        <th>Brand</th>
                        <th>Details</th>
                    </tr>
                </thead>
                <tbody>
                    ${data
                        .map(
                            (row) => `
                        <tr>
                            <td data-label="When">${new Date(row.created_at).toLocaleString('en-NZ')}</td>
                            <td data-label="Admin">${escapeHtml(row.admin_name)}</td>
                            <td data-label="Action"><span class="badge badge-blue">${escapeHtml(row.action_type.replace(/_/g, ' '))}</span></td>
                            <td data-label="Target">${escapeHtml(row.target_type)}${row.target_id ? ' #' + row.target_id.slice(0, 8) : ''}</td>
                            <td data-label="Brand">${row.brand ? escapeHtml(row.brand) : '—'}</td>
                            <td data-label="Details">${row.details ? escapeHtml(JSON.stringify(row.details)) : '—'}</td>
                        </tr>
                    `
                        )
                        .join('')}
                </tbody>
            </table>
        `;
    } catch (error) {
        showError(error, 'Unable to load audit log.');
    }
}

function applyAuditLogFilters() {
    renderAuditLog();
}

/**
 * Exports the currently-loaded (filtered) audit log rows as a CSV download.
 */
function exportAuditLogCsv() {
    const rows = AppState.auditLogRows || [];
    if (rows.length === 0) {
        showToast('warning', 'No rows to export -- adjust your filters first.');
        return;
    }

    const headers = ['When', 'Admin', 'Action', 'Target Type', 'Target ID', 'Brand', 'Details'];
    const csvRows = [headers.join(',')];

    rows.forEach((row) => {
        const line = [
            new Date(row.created_at).toISOString(),
            row.admin_name,
            row.action_type,
            row.target_type,
            row.target_id || '',
            row.brand || '',
            row.details ? JSON.stringify(row.details) : ''
        ].map((val) => `"${String(val).replace(/"/g, '""')}"`);
        csvRows.push(line.join(','));
    });

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `giftlio-audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('success', `Exported ${rows.length} audit log entries.`);
}

/**
 * Renders the admin Brand Discounts management table -- every brand,
 * its current discount percentage, an editable input, and a save button
 * per row. Brands with no row yet in brand_discounts show the 15% default
 * and get one created (upsert) the first time they're saved.
 */
async function renderBrandDiscountsTable() {
    const container = document.getElementById('brandDiscountsTable');
    if (!container) return;

    container.innerHTML = renderSkeletonTableRows(4, 5);

    try {
        const discounts = await loadBrandDiscounts();
        const allBrands = Object.keys(BRAND_COLORS).sort();

        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Brand</th>
                        <th>Current Discount</th>
                        <th>New Discount (0-25%)</th>
                        <th>Retailer Enabled</th>
                        <th>Instant Sell Only</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${allBrands
                        .map((brand) => {
                            const config = discounts[brand];
                            const current = config ? config.discountPercent : null;
                            const isAvailable = config ? config.instantSellAvailable : true;
                            const isEnabled = config ? config.retailerEnabled : true;
                            const inputId = `brandDiscountInput-${brand.replace(/[^a-zA-Z0-9]/g, '')}`;
                            const checkboxId = `brandAvailable-${brand.replace(/[^a-zA-Z0-9]/g, '')}`;
                            const enabledId = `brandEnabled-${brand.replace(/[^a-zA-Z0-9]/g, '')}`;
                            const errorId = `${inputId}Error`;
                            return `
                        <tr>
                            <td data-label="Brand"><strong>${escapeHtml(brand)}</strong></td>
                            <td data-label="Current Discount">${current === null ? 'Not set' : current + '%'}</td>
                            <td data-label="New Discount">
                                <input type="number" id="${inputId}" min="0" max="25" step="1" value="${current !== null ? current : ''}" placeholder="0-25" style="width: 90px;">
                                <span class="error-msg" id="${errorId}"></span>
                            </td>
                            <td data-label="Retailer Enabled">
                                <label class="checkbox-group" style="margin:0;" title="Whole-retailer kill switch -- blocks both buying and selling this retailer app-wide when off."><input type="checkbox" id="${enabledId}" ${isEnabled ? 'checked' : ''}> Enabled</label>
                            </td>
                            <td data-label="Instant Sell Only">
                                <label class="checkbox-group" style="margin:0;" title="More granular: hides this retailer from Instant Sell submissions specifically, while Marketplace stays open."><input type="checkbox" id="${checkboxId}" ${isAvailable ? 'checked' : ''}> Available</label>
                            </td>
                            <td data-label="Actions"><button class="btn btn-primary btn-sm" onclick="saveBrandDiscount('${escapeJsString(brand)}', '${inputId}', '${errorId}', '${checkboxId}', '${enabledId}')">Save</button></td>
                        </tr>
                    `;
                        })
                        .join('')}
                </tbody>
            </table>
        `;
    } catch (error) {
        showError(error, 'Unable to load brand discounts.');
    }
}

async function saveBrandDiscount(brand, inputId, errorId, checkboxId, enabledId) {
    const input = document.getElementById(inputId);
    const errorEl = document.getElementById(errorId);
    const checkbox = document.getElementById(checkboxId);
    const enabledCheckbox = document.getElementById(enabledId);
    errorEl.textContent = '';
    input.classList.remove('field-error');

    const raw = input.value;
    const num = Number(raw);

    if (raw === '' || Number.isNaN(num) || !Number.isFinite(num)) {
        input.classList.add('field-error');
        errorEl.textContent = 'Enter a number';
        return;
    }
    if (num < GiftlioPricing.MIN_DISCOUNT || num > GiftlioPricing.MAX_DISCOUNT) {
        input.classList.add('field-error');
        errorEl.textContent = `Must be ${GiftlioPricing.MIN_DISCOUNT}-${GiftlioPricing.MAX_DISCOUNT}`;
        return;
    }

    const instantSellAvailable = checkbox.checked;
    const retailerEnabled = enabledCheckbox.checked;

    try {
        const { error } = await supabaseClient
            .from('brand_discounts')
            .upsert(
                { brand, discount_percent: num, instant_sell_available: instantSellAvailable, retailer_enabled: retailerEnabled, updated_at: new Date().toISOString() },
                { onConflict: 'brand' }
            );

        if (error) throw error;

        AppState.brandDiscounts[brand] = { discountPercent: num, instantSellAvailable, retailerEnabled };
        await logAdminAction('update_brand_discount', 'brand', null, brand, { discountPercent: num, instantSellAvailable, retailerEnabled });
        showToast('success', `${brand} updated: ${num}% discount, ${instantSellAvailable ? 'available' : 'hidden'} for Instant Sell. Applies immediately.`);
        await renderBrandDiscountsTable();
    } catch (error) {
        showError(error, 'Unable to save this discount.');
    }
}

/**
 * Disables the Approve/Verify & List button THE INSTANT it's clicked --
 * before any async work even starts -- so a fast double-click (or an
 * impatient second click while the first request is still in flight)
 * physically can't fire this twice. This is the actual fix for the
 * "duplicate key value violates unique constraint" error: without this,
 * nothing stopped two concurrent approval attempts on the same submission.
 */
function approveSubmissionGuarded(button, submissionDbId) {
    if (button.disabled) return;
    button.disabled = true;
    button.style.opacity = '0.6';
    approveSubmission(submissionDbId).finally(() => {
        // Only re-enable on failure -- on success the row disappears from
        // the table on refresh anyway, so there's nothing to re-enable.
        if (document.body.contains(button)) {
            button.disabled = false;
            button.style.opacity = '';
        }
    });
}

async function approveSubmission(submissionDbId) {
    try {
        await withLoading(async () => {
            const { data: subData, error: subError } = await supabaseClient
                .from('submissions')
                .select('*')
                .eq('id', submissionDbId)
                .single();

            if (subError) throw subError;

            // Idempotency guard: if this submission isn't pending anymore,
            // someone (or a duplicate click from the same admin) already
            // processed it. Bail out with a clear message instead of
            // re-running the whole approval and hitting a raw database
            // constraint error further down.
            if (subData.status !== 'pending_review') {
                showToast('info', 'This submission was already processed -- refreshing the list.');
                renderAdmin();
                return;
            }

            const sub = submissionRowToView(subData);
            const listingFaceValue = sub.currentBalance;

            // Defense in depth: re-validate the balance here too, not just
            // on the submission form. A row could in principle be edited
            // directly in the database, bypassing the form entirely.
            const balanceCheck = GiftlioPricing.validateBalance(sub.currentBalance, sub.faceValue);
            if (!balanceCheck.valid) {
                throw new Error(`Cannot approve: ${balanceCheck.error}`);
            }

            // Instant Sell: Giftlio sets the resale price, from current
            // balance and this brand's configured discount percentage --
            // via the shared pricing helper, the ONLY place this
            // calculation happens. Never hardcode a percentage here.
            // Marketplace: the LISTING price is the seller's own asking
            // price, not calculated from a discount at all -- seller is
            // paid seller_payout_amount only once a buyer purchases it.
            const isMarketplace = sub.saleMode === 'marketplace';
            let salePrice;
            let discount;
            let commissionRate;
            let sellerPayoutAmount;

            await loadBrandDiscounts();
            const brandConfigForApproval = AppState.brandDiscounts[sub.brand];
            if (brandConfigForApproval && !brandConfigForApproval.retailerEnabled) {
                throw new Error(`Cannot approve: ${sub.brand} is currently disabled. Re-enable it in Brand Discounts first, or reject this submission.`);
            }

            if (isMarketplace) {
                salePrice = Number(sub.sellerSetPrice.toFixed(2));
                discount = Math.max(0, Math.min(100, Math.round((1 - salePrice / listingFaceValue) * 100)));
                commissionRate = MARKETPLACE_COMMISSION_RATE * 100;
                sellerPayoutAmount = Number((salePrice * (1 - MARKETPLACE_COMMISSION_RATE)).toFixed(2));
            } else {
                const brandConfig = AppState.brandDiscounts[sub.brand];
                const priced = GiftlioPricing.calculateSalePrice(listingFaceValue, brandConfig ? brandConfig.discountPercent : undefined);
                if (priced.error) {
                    throw new Error(`Cannot approve: ${sub.brand} has no discount percentage configured. Set one in Brand Discounts first.`);
                }
                if (!priced.purchasable) {
                    throw new Error('Cannot approve: this card has a zero or invalid balance and cannot be priced.');
                }
                salePrice = priced.salePrice;
                discount = priced.discountPercent;
                commissionRate = null;
                sellerPayoutAmount = null;
            }

            const { data: sellerProfile, error: sellerProfileError } = await supabaseClient
                .from('profiles')
                .select('created_at')
                .eq('id', sub.sellerId)
                .single();

            if (sellerProfileError) throw sellerProfileError;
            const sellerSince = new Date(sellerProfile.created_at).toISOString().slice(0, 7);

            const { data: vaultData, error: vaultError } = await supabaseClient
                .from('card_vault')
                .insert({
                    submission_id: submissionDbId,
                    seller_id: sub.sellerId,
                    brand: sub.brand,
                    card_number: sub.cardNumber,
                    pin: sub.pin,
                    current_balance: sub.currentBalance,
                    expiry_date: sub.expiryDate,
                    is_redeemed: false
                })
                .select('id')
                .single();

            if (vaultError) throw vaultError;

            const { error: listingError } = await supabaseClient.from('listings').insert({
                public_id: generatePublicId('L'),
                submission_id: submissionDbId,
                card_vault_id: vaultData.id,
                seller_id: sub.sellerId,
                seller_name: sub.sellerName,
                seller_since: sellerSince,
                cards_sold: 0,
                brand: sub.brand,
                face_value: listingFaceValue,
                sale_price: salePrice,
                discount,
                status: 'active',
                expiry_date: sub.expiryDate,
                sale_mode: sub.saleMode,
                commission_rate: commissionRate,
                seller_payout_amount: sellerPayoutAmount
            });

            if (listingError) throw listingError;

            const { error: updateError } = await supabaseClient
                .from('submissions')
                .update({ status: 'approved', approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                .eq('id', submissionDbId);

            if (updateError) throw updateError;
        });

        await logAdminAction('approve_submission', 'submission', submissionDbId, sub.brand, {
            seller: sub.sellerName,
            saleMode: sub.saleMode,
            offerAmount: sub.offerAmount
        });
        await notifyBoth({
            eventType: 'submission_approved',
            relatedId: submissionDbId,
            adminSubject: `Submission Approved: ${sub.brand} #${sub.id}`,
            adminBody: `<p><strong>Seller:</strong> ${escapeHtml(sub.sellerName)}</p><p><strong>Brand:</strong> ${escapeHtml(sub.brand)}</p><p><strong>Mode:</strong> ${sub.saleMode}</p><p><strong>Offer:</strong> ${formatCurrency(sub.offerAmount)}</p>`,
            sellerId: sub.sellerId,
            sellerSubject: `Your ${sub.brand} card submission was approved!`,
            sellerBody: `<p>Hi ${escapeHtml(sub.sellerName)},</p>
             <p>Good news — your ${escapeHtml(sub.brand)} gift card (#${escapeHtml(sub.id)}) has been verified and approved.</p>
             ${
                 sub.saleMode === 'marketplace'
                     ? `<p>It's now live on the Giftlio marketplace at your asking price. You'll be paid <strong>${formatCurrency(sub.offerAmount)}</strong> once a buyer purchases it -- we'll email you the moment that happens.</p>`
                     : `<p>Your payout of <strong>${formatCurrency(sub.offerAmount)}</strong> is on its way. This card is now Giftlio's, so there's nothing further for you to track -- you're all done here.</p>`
             }`
        });

        showToast('success', 'Submission approved and listed on marketplace!');
        renderAdmin();
    } catch (error) {
        showError(error, 'Unable to approve submission.');
    }
}

/**
 * Logs an admin action to admin_audit_log. Called by every admin action in
 * this file -- approve, reject, edit, delete, suspend, mark paid, listing
 * suspend/remove, dispute actions. Never blocks the action itself if
 * logging fails (a failed log write shouldn't stop an admin from doing
 * their job), but does surface a toast so it's not silently lost.
 */
async function logAdminAction(actionType, targetType, targetId, brand, details) {
    try {
        const { error } = await supabaseClient.from('admin_audit_log').insert({
            admin_id: AppState.currentUser.id,
            admin_name: AppState.currentUser.name,
            action_type: actionType,
            target_type: targetType,
            target_id: targetId || null,
            brand: brand || null,
            details: details || null
        });
        if (error) throw error;
    } catch (error) {
        console.error('Failed to write audit log entry:', error);
        showToast('warning', 'Action completed, but the audit log entry failed to save.');
    }
}

/**
 * Sends an admin notification email via the reusable /api/send-notification
 * endpoint. Every event type calls this same function -- adding a new
 * alert (low inventory, suspicious activity, dispute raised) anywhere else
 * in the app is one call to notifyAdmin(...), not a new endpoint.
 */
/**
 * Sends a transactional email to a specific seller (via /api/notify-seller)
 * -- for outcomes like approval/rejection, where the SELLER needs to know
 * what happened, not the admin who just took the action.
 */
async function notifySeller(sellerId, subject, bodyHtml, eventType, relatedId) {
    try {
        const response = await fetch('/api/notify-seller', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sellerId, subject, bodyHtml, eventType, relatedId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Notification failed');
        if (data.queued) {
            showToast('warning', 'Seller notification email is queued for retry (send failed once).');
        }
    } catch (error) {
        console.error('notifySeller failed:', error);
        showToast('warning', 'Could not email the seller about this outcome.');
    }
}

/**
 * Sends BOTH the admin notification (always, every event, both models --
 * admin needs full visibility) AND the seller notification (content and
 * whether it fires at all depends on their sale mode). This is the
 * standard entry point for submission-lifecycle events now; call
 * notifyAdmin/notifySeller directly only for one-sided events.
 */
async function notifyBoth({ eventType, relatedId, adminSubject, adminBody, sellerId, sellerSubject, sellerBody }) {
    await notifyAdmin(eventType, adminSubject, adminBody, relatedId);
    if (sellerId && sellerSubject && sellerBody) {
        await notifySeller(sellerId, sellerSubject, sellerBody, eventType, relatedId);
    }
}

async function notifyAdmin(eventType, subject, bodyHtml, relatedId) {
    try {
        const response = await fetch('/api/send-notification', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ eventType, subject, bodyHtml, relatedId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Notification failed');
        if (data.queued) {
            showToast('warning', 'Notification email is queued for retry (send failed once).');
        }
    } catch (error) {
        console.error('notifyAdmin failed:', error);
        showToast('warning', 'Could not send the admin notification email.');
    }
}

/**
 * Generic confirmation modal, replacing native confirm()/prompt() dialogs
 * across the admin panel. onConfirm receives the reason text if
 * requireReason is true, otherwise undefined.
 */
function showConfirmModal({ title, message, confirmLabel = 'Confirm', danger = false, requireReason = false, reasonLabel = 'Reason', onConfirm }) {
    const overlay = document.getElementById('confirmModalOverlay');
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmModalTitle').textContent = title;
    document.getElementById('confirmModalMessage').textContent = message;
    const reasonGroup = document.getElementById('confirmModalReasonGroup');
    const reasonInput = document.getElementById('confirmModalReasonInput');
    const reasonErr = document.getElementById('confirmModalReasonError');
    reasonInput.value = '';
    reasonErr.textContent = '';
    document.getElementById('confirmModalReasonLabel').textContent = reasonLabel;
    reasonGroup.classList.toggle('hidden', !requireReason);

    const confirmBtn = document.getElementById('confirmModalConfirmBtn');
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';

    const handler = () => {
        if (requireReason && !reasonInput.value.trim()) {
            reasonErr.textContent = 'This field is required.';
            reasonInput.classList.add('field-error');
            return;
        }
        overlay.classList.add('hidden');
        modal.classList.add('hidden');
        confirmBtn.removeEventListener('click', handler);
        onConfirm(requireReason ? reasonInput.value.trim() : undefined);
    };
    confirmBtn.addEventListener('click', handler);

    overlay.classList.remove('hidden');
    modal.classList.remove('hidden');
}

function closeConfirmModal() {
    document.getElementById('confirmModalOverlay').classList.add('hidden');
    document.getElementById('confirmModal').classList.add('hidden');
}

/**
 * Soft-deletes a submission (sets deleted_at, never actually removes the
 * row) -- financial records stay in the database for audit/dispute
 * purposes even when an admin "deletes" them from their working view.
 */
async function deleteSubmission(submissionDbId) {
    const { data: sub } = await supabaseClient.from('submissions').select('brand, public_id, seller_name').eq('id', submissionDbId).single();

    showConfirmModal({
        title: 'Delete Submission',
        message: `Delete ${sub?.brand || ''} card #${sub?.public_id || ''} from ${sub?.seller_name || 'this seller'}? This removes it from your working view, but the record is kept for audit purposes.`,
        confirmLabel: 'Delete Submission',
        danger: true,
        onConfirm: async () => {
            try {
                await withLoading(async () => {
                    const { error } = await supabaseClient
                        .from('submissions')
                        .update({ deleted_at: new Date().toISOString(), deleted_by: AppState.currentUser.id })
                        .eq('id', submissionDbId);
                    if (error) throw error;
                });
                await logAdminAction('delete_submission', 'submission', submissionDbId, sub?.brand, { seller: sub?.seller_name });
                showToast('info', 'Submission deleted from your working view.');
                renderAdmin();
            } catch (error) {
                showError(error, 'Unable to delete submission.');
            }
        }
    });
}

/**
 * Suspends or unsuspends a seller account. A suspended seller can't submit
 * new cards or have pending submissions approved (checked in
 * handleSubmission and approveSubmission via profiles.suspended).
 */
async function toggleSellerSuspension(sellerId, sellerName, currentlySuspended) {
    showConfirmModal({
        title: currentlySuspended ? 'Reinstate Seller' : 'Suspend Seller',
        message: currentlySuspended
            ? `Reinstate ${sellerName}? They'll be able to submit and sell cards again.`
            : `Suspend ${sellerName}? They won't be able to submit new cards while suspended.`,
        confirmLabel: currentlySuspended ? 'Reinstate' : 'Suspend Seller',
        danger: !currentlySuspended,
        requireReason: !currentlySuspended,
        reasonLabel: 'Reason for suspension',
        onConfirm: async (reason) => {
            try {
                await withLoading(async () => {
                    const { error } = await supabaseClient
                        .from('profiles')
                        .update({
                            suspended: !currentlySuspended,
                            suspended_reason: currentlySuspended ? null : reason,
                            suspended_at: currentlySuspended ? null : new Date().toISOString()
                        })
                        .eq('id', sellerId);
                    if (error) throw error;
                });
                await logAdminAction(currentlySuspended ? 'reinstate_seller' : 'suspend_seller', 'seller', sellerId, null, { sellerName, reason });
                showToast('success', currentlySuspended ? `${sellerName} reinstated.` : `${sellerName} suspended.`);
                renderAdmin();
            } catch (error) {
                showError(error, 'Unable to update seller status.');
            }
        }
    });
}

/**
 * Marks a submission as paid -- for Marketplace-mode sellers, whose payout
 * only becomes real once admin confirms the bank transfer (the Friday
 * payout batch). Instant Sell submissions are already treated as paid at
 * approval, so this action is really for Marketplace mode.
 */
async function markSubmissionPaid(submissionDbId) {
    const { data: sub } = await supabaseClient.from('submissions').select('brand, public_id, seller_name, seller_id, offer_amount').eq('id', submissionDbId).single();

    showConfirmModal({
        title: 'Mark as Paid',
        message: `Confirm ${sub ? formatCurrency(sub.offer_amount) : ''} has been paid to ${sub?.seller_name || 'this seller'} for ${sub?.brand || ''} #${sub?.public_id || ''}?`,
        confirmLabel: 'Confirm Paid',
        onConfirm: async () => {
            try {
                await withLoading(async () => {
                    const { error } = await supabaseClient.from('submissions').update({ paid_at: new Date().toISOString() }).eq('id', submissionDbId);
                    if (error) throw error;
                });
                await logAdminAction('mark_paid', 'submission', submissionDbId, sub?.brand, { seller: sub?.seller_name, amount: sub?.offer_amount });
                await notifyBoth({
                    eventType: 'payout_marked_paid',
                    relatedId: submissionDbId,
                    adminSubject: `Payout Marked Paid: ${sub?.brand} #${sub?.public_id}`,
                    adminBody: `<p><strong>Seller:</strong> ${escapeHtml(sub?.seller_name || '')}</p><p><strong>Amount:</strong> ${formatCurrency(sub?.offer_amount || 0)}</p>`,
                    sellerId: sub?.seller_id,
                    sellerSubject: `Your payout for ${sub?.brand} has been sent`,
                    sellerBody: `<p>Hi ${escapeHtml(sub?.seller_name || '')},</p>
                     <p>Your payout of <strong>${formatCurrency(sub?.offer_amount || 0)}</strong> for your ${escapeHtml(sub?.brand || '')} card (#${escapeHtml(sub?.public_id || '')}) has been sent.</p>
                     <p>Thanks for selling with Giftlio!</p>`
                });
                showToast('success', 'Marked as paid.');
                renderAdmin();
            } catch (error) {
                showError(error, 'Unable to mark as paid.');
            }
        }
    });
}

async function rejectSubmission(submissionDbId) {
    const { data: sub, error: fetchError } = await supabaseClient.from('submissions').select('*').eq('id', submissionDbId).single();
    if (fetchError) {
        showError(fetchError, 'Unable to load this submission.');
        return;
    }

    showConfirmModal({
        title: 'Reject Submission',
        message: `Reject ${sub.brand} card #${sub.public_id} from ${sub.seller_name}? A reason is required and will be shown to the seller.`,
        confirmLabel: 'Reject Submission',
        danger: true,
        requireReason: true,
        reasonLabel: 'Rejection reason',
        onConfirm: async (reason) => {
            try {
                await withLoading(async () => {
                    const { error } = await supabaseClient
                        .from('submissions')
                        .update({ status: 'rejected', rejection_reason: reason, admin_notes: reason, updated_at: new Date().toISOString() })
                        .eq('id', submissionDbId);
                    if (error) throw error;
                });

                await logAdminAction('reject_submission', 'submission', submissionDbId, sub.brand, { reason, seller: sub.seller_name });
                await notifyBoth({
                    eventType: 'submission_rejected',
                    relatedId: submissionDbId,
                    adminSubject: `Submission Rejected: ${sub.brand} #${sub.public_id}`,
                    adminBody: `<p><strong>Seller:</strong> ${escapeHtml(sub.seller_name)}</p><p><strong>Brand:</strong> ${escapeHtml(sub.brand)}</p><p><strong>Reason:</strong> ${escapeHtml(reason)}</p>`,
                    sellerId: sub.seller_id,
                    sellerSubject: `Your ${sub.brand} card submission wasn't approved`,
                    sellerBody: `<p>Hi ${escapeHtml(sub.seller_name)},</p>
                     <p>Your submission for a ${escapeHtml(sub.brand)} gift card (#${escapeHtml(sub.public_id)}) wasn't approved.</p>
                     <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
                     <p>If you have questions, reply to this email or contact support@giftlio.co.nz.</p>`
                });

                showToast('info', `Submission rejected: ${reason}`);
                renderAdmin();
            } catch (error) {
                showError(error, 'Unable to reject submission.');
            }
        }
    });
}

async function deliverOrder(orderDbId) {
    if (!confirm('Send the gift card details to the buyer by email now?')) return;

    try {
        await withLoading(async () => {
            const {
                data: { session },
                error: sessionError
            } = await supabaseClient.auth.getSession();

            if (sessionError) throw sessionError;
            if (!session) throw new Error('Your session has expired. Please log in again.');

            const response = await fetch('/api/deliver-order', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session.access_token}`
                },
                body: JSON.stringify({ orderId: orderDbId })
            });

            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to deliver this order.');
        });

        showToast('success', 'Gift card details have been emailed to the buyer.');
        renderAdmin();
    } catch (error) {
        showError(error, 'Unable to deliver this order.');
    }
}

function closeModal() {
    document.getElementById('modalOverlay').classList.add('hidden');
    document.getElementById('detailModal').classList.add('hidden');
}

function toggleMobileMenu() {
    document.getElementById('mobileMenu').classList.toggle('hidden');
}

function toggleDropdown() {
    document.getElementById('dropdownContent').classList.toggle('show');
}

function checkAuthThen(page) {
    if (!AppState.currentUser) {
        router('login');
        return;
    }
    router(page);
}

async function restoreRoute(routeState = {}, historyMode = 'none') {
    const page = Object.hasOwn(PAGE_SECTION_MAP, routeState.page) ? routeState.page : getPageFromPath();

    if (page === 'listing') {
        const listingId = routeState.listingId || AppState.currentListing?.id;
        if (!listingId) {
            router('browse', { historyMode });
            return;
        }
        await viewListing(listingId, { historyMode });
        return;
    }

    if (page === 'checkout') {
        if (!AppState.currentUser) {
            router('login', { historyMode: 'replace' });
            return;
        }

        if (routeState.currentOrder) {
            AppState.currentOrder = {
                ...routeState.currentOrder,
                buyerPhone: routeState.currentOrder.buyerPhone || ''
            };
            AppState.currentListing = routeState.currentOrder.listing ?? AppState.currentListing;
        } else if (routeState.listingId) {
            const { data, error } = await supabaseClient.from('listings').select('*').eq('id', routeState.listingId).single();
            if (error || !data) {
                showError(error || new Error('Listing not found.'), 'Unable to restore checkout listing.');
                router('browse', { historyMode: 'replace' });
                return;
            }

            const listing = listingRowToView(data);
            AppState.currentListing = listing;
            AppState.currentOrder = {
                listing,
                buyerName: AppState.currentUser.name,
                buyerEmail: AppState.currentUser.email,
                buyerPhone: '',
                ...GiftlioPricing.calculateCheckoutTotal(listing.salePrice)
            };
        }

        if (!AppState.currentOrder || !AppState.currentOrder.listing) {
            router('browse', { historyMode: 'replace' });
            return;
        }

        AppState.checkoutStep = normalizeCheckoutStep(routeState.checkoutStep ?? AppState.checkoutStep ?? DEFAULT_CHECKOUT_STEP);
        router('checkout', { historyMode, routeState: buildRouteState('checkout', routeState) });
        updateCheckoutSteps();
        renderCheckoutSummary();
        hydrateCheckoutBuyerFields();
        return;
    }

    await router(page, { historyMode, routeState });
}

async function initializeRouting() {
    if (window.history.state?.page) {
        await restoreRoute(window.history.state, 'replace');
        return;
    }

    await restoreRoute({ page: getPageFromPath() }, 'replace');
}

async function router(page, options = {}) {
    const { historyMode = 'push', routeState = null } = options;

    // Admin route guard -- runs before ANY section is made visible, so an
    // unauthenticated or non-admin visitor never sees even a flash of admin
    // UI. Unauthenticated -> login. Authenticated but not an admin -> home.
    if (page === 'admin') {
        if (!AppState.currentUser) {
            return router('login', { historyMode: 'replace' });
        }
        if (AppState.currentUser.role !== 'admin') {
            return router('home', { historyMode: 'replace' });
        }
    }

    document.querySelectorAll('.page-section').forEach((s) => {
        s.classList.remove('active');
        s.classList.add('hidden');
    });

    document.getElementById('mobileMenu').classList.add('hidden');
    document.getElementById('dropdownContent').classList.remove('show');

    const sectionId = PAGE_SECTION_MAP[page];
    if (sectionId) {
        const section = document.getElementById(sectionId);
        section.classList.remove('hidden');
        section.classList.add('active');
    }

    syncHistory(page, historyMode, routeState ? buildRouteState(page, routeState) : null);

    if (page === 'home') await renderHome();
    if (page === 'browse') await renderBrowse();
    if (page === 'sell') await renderSellPage();
    if (page === 'orders') await renderOrders();
    if (page === 'seller-dashboard') await renderSellerDashboard();
    if (page === 'admin') await renderAdmin();

    updateBottomNavActive(page);
    window.scrollTo(0, 0);
}

function updateBottomNavActive(page) {
    const navMap = { home: 'home', browse: 'browse', sell: 'sell', orders: 'orders' };
    const activeKey = navMap[page] || (page === 'seller-dashboard' || page === 'login' || page === 'signup' ? 'profile' : null);
    document.querySelectorAll('.bottom-nav-item').forEach((item) => {
        item.classList.toggle('active', item.dataset.page === activeKey);
    });
}

function handleBottomNavProfile() {
    if (AppState.currentUser) {
        router('seller-dashboard');
    } else {
        router('login');
    }
}

function setupEventListeners() {
    document.getElementById('searchInput')?.addEventListener('input', () => {
        applyFilters();
    });
    document.getElementById('discountFilter')?.addEventListener('change', () => {
        applyFilters();
    });
    document.getElementById('sortSelect')?.addEventListener('change', () => {
        applyFilters();
    });

    document.getElementById('subReceipt')?.addEventListener('change', function () {
        const file = this.files[0];
        if (file) {
            document.getElementById('fileName').textContent = file.name;
        }
    });

    document.addEventListener('click', (e) => {
        if (!(e.target instanceof Element)) return;

        const anchor = e.target.tagName === 'A' ? e.target : e.target.closest('a');
        if (anchor?.getAttribute('href') === '#') {
            e.preventDefault();
        }

        if (!e.target.closest('.dropdown')) {
            document.getElementById('dropdownContent').classList.remove('show');
        }
    });

    window.addEventListener('popstate', async (e) => {
        await restoreRoute(e.state || { page: getPageFromPath() }, 'none');
    });

    supabaseClient.auth.onAuthStateChange((event, session) => {
        handleAuthStateChange(event, session);
    });
}

/* ===== PWA: service worker, install prompt, offline detection =====
 * All additive -- none of this touches existing auth/listing/order/
 * dashboard logic above. */

let deferredInstallPrompt = null;
const INSTALL_DISMISS_KEY = 'giftlio_install_dismissed_at';
const INSTALL_DISMISS_DAYS = 14;

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').catch((error) => {
            console.error('Service worker registration failed:', error);
        });
    });
}

function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIos() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent) && !window.MSStream;
}

function wasInstallBannerRecentlyDismissed() {
    const dismissedAt = localStorage.getItem(INSTALL_DISMISS_KEY);
    if (!dismissedAt) return false;
    const daysSince = (Date.now() - Number(dismissedAt)) / (1000 * 60 * 60 * 24);
    return daysSince < INSTALL_DISMISS_DAYS;
}

function showInstallBanner() {
    if (isStandalone() || wasInstallBannerRecentlyDismissed()) return;
    document.getElementById('installBanner')?.classList.remove('hidden');
}

function dismissInstallBanner() {
    localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
    document.getElementById('installBanner')?.classList.add('hidden');
}

function setupPWAInstall() {
    const banner = document.getElementById('installBanner');
    if (!banner) return;
    if (isStandalone() || wasInstallBannerRecentlyDismissed()) return;

    if (isIos()) {
        // iOS Safari never fires beforeinstallprompt -- Apple restriction,
        // no code workaround exists. It's always eligible for manual
        // "Add to Home Screen" though, so we can show the banner right away.
        const sub = document.getElementById('installBannerSub');
        if (sub) sub.textContent = 'Tap Install for quick setup instructions';
        showInstallBanner();
        return;
    }

    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredInstallPrompt = event;
        showInstallBanner();
    });

    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        dismissInstallBanner();
    });

    // Not every Android browser fires beforeinstallprompt. Samsung Internet
    // (version 27+) deliberately dropped support for it in favour of its
    // own install flow, and Firefox for Android never supported it at all
    // -- without this fallback, those users would see no banner at all,
    // ever, with zero indication an install is even possible. If the
    // native event hasn't fired within a few seconds, show the banner
    // anyway with manual instructions instead of silently giving up.
    setTimeout(() => {
        if (deferredInstallPrompt || isStandalone() || wasInstallBannerRecentlyDismissed()) return;
        const sub = document.getElementById('installBannerSub');
        if (sub) sub.textContent = 'Tap Install for quick setup instructions';
        showInstallBanner();
    }, 2500);
}

async function promptInstall() {
    if (isIos()) {
        document.getElementById('iosInstallOverlay')?.classList.remove('hidden');
        document.getElementById('iosInstallModal')?.classList.remove('hidden');
        return;
    }

    if (!deferredInstallPrompt) {
        // No native prompt was ever captured -- this browser doesn't
        // support beforeinstallprompt (Samsung Internet 27+, Firefox for
        // Android, etc.). Show manual instructions instead of doing
        // nothing.
        document.getElementById('androidInstallOverlay')?.classList.remove('hidden');
        document.getElementById('androidInstallModal')?.classList.remove('hidden');
        return;
    }

    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById('installBanner')?.classList.add('hidden');
}

function closeAndroidInstallModal() {
    document.getElementById('androidInstallOverlay')?.classList.add('hidden');
    document.getElementById('androidInstallModal')?.classList.add('hidden');
}

function closeIosInstallModal() {
    document.getElementById('iosInstallOverlay')?.classList.add('hidden');
    document.getElementById('iosInstallModal')?.classList.add('hidden');
}

function setupOfflineDetection() {
    const banner = document.getElementById('offlineBanner');
    if (!banner) return;

    const updateOnlineStatus = () => {
        banner.classList.toggle('hidden', navigator.onLine);
    };

    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus();
}

async function initializeApp() {
    registerServiceWorker();
    setupPWAInstall();
    setupOfflineDetection();

    if (!window.supabaseClient) {
        const message = 'Supabase client is not configured. Please set SUPABASE_URL and SUPABASE_ANON_KEY.';
        alert(message);
        document.body.innerHTML = `<div style=\"padding:24px;font-family:Inter,Arial,sans-serif;color:#0f172a;\">${escapeHtml(message)}</div>`;
        return;
    }

    setupEventListeners();
    await checkAuth();
    subscribeToBrandDiscountChanges();

    // Password reset links land here with #access_token=...&type=recovery
    // in the URL. Routing now uses real paths (pushState), not the hash, so
    // this token is never touched by normal navigation -- but it's still
    // checked before initializeRouting() runs, first thing, for safety.
    if (window.location.hash.includes('type=recovery')) {
        router('reset-password', { historyMode: 'replace' });
        return;
    }

    // Landing back here from Stripe Checkout (success or cancelled).
    if (new URLSearchParams(window.location.search).get('checkout')) {
        handleStripeRedirectReturn();
        return;
    }

    await initializeRouting();
}

document.addEventListener('DOMContentLoaded', () => {
    initializeApp().catch((error) => {
        showError(error, 'Failed to initialize the application.');
    });
});
