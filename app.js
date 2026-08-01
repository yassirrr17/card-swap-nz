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
    brandDiscounts: {}
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
            // dropdown and live offer estimate immediately.
            const sellSection = document.getElementById('sell-section');
            if (sellSection && !sellSection.classList.contains('hidden')) {
                populateBrandDropdown();
                updateOffer();
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
    const { data, error } = await supabaseClient.from('brand_discounts').select('brand, discount_percent, instant_sell_available');
    if (error) {
        console.error('Failed to load brand discounts:', error);
        return AppState.brandDiscounts;
    }
    const map = {};
    (data || []).forEach((row) => {
        map[row.brand] = {
            discountPercent: Number(row.discount_percent),
            instantSellAvailable: row.instant_sell_available !== false
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
        sellerPayoutAmount: row.seller_payout_amount !== null && row.seller_payout_amount !== undefined ? Number(row.seller_payout_amount) : null
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
        .select('id, name, email, role, created_at')
        .eq('id', userId)
        .single();

    if (error) throw error;

    return {
        id: data.id,
        name: data.name,
        email: data.email,
        role: data.role,
        created: data.created_at?.split('T')[0]
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

    return `
        <div class="listing-card" onclick="viewListing('${listing.id}')">
            <div class="listing-card-header">
                ${retailerBadgeHTML(listing.brand)}
                ${verifyBadge}
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
                <button class="btn btn-primary" aria-label="View ${escapeHtml(listing.brand)} gift card, ${formatCurrency(listing.salePrice)}, save ${listing.discount} percent" onclick="event.stopPropagation(); viewListing('${listing.id}')">Buy Now</button>
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
            const allListings = await getActiveListings();
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

async function viewListing(id, options = {}) {
    const { historyMode = 'push' } = options;

    try {
        await withLoading(async () => {
            const { data, error } = await supabaseClient.from('listings').select('*').eq('id', id).single();
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

            document.getElementById('detailLayout').innerHTML = `
                <div class="detail-left">
                    <h1 class="visually-hidden">${escapeHtml(listing.brand)} gift card, ${formatCurrency(listing.faceValue)} value</h1>
                    <div class="detail-brand-badge">${retailerBadgeHTML(listing.brand)}</div>
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
                        <button class="btn btn-gold" onclick="startCheckout()">
                            Buy Now - ${formatCurrency(listing.salePrice)} NZD
                        </button>
                        <p style="font-size: 12px; color: var(--gray-500); margin-top: 8px; text-align: center;">Includes service fee</p>
                    </div>
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

            router('listing', { historyMode });
        });
    } catch (error) {
        showError(error, 'Unable to load listing details.');
    }
}

function startCheckout() {
    if (!AppState.currentUser) {
        router('login');
        return;
    }
    if (!AppState.currentListing) return;

    AppState.checkoutStep = DEFAULT_CHECKOUT_STEP;
    AppState.currentOrder = {
        listing: AppState.currentListing,
        buyerName: AppState.currentUser.name,
        buyerEmail: AppState.currentUser.email,
        buyerPhone: '',
        ...GiftlioPricing.calculateCheckoutTotal(AppState.currentListing.salePrice)
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
function populateBrandDropdown() {
    const select = document.getElementById('subBrand');
    if (!select) return;

    const mode = getSelectedSaleMode();
    const previousValue = select.value;
    const allBrands = Object.keys(BRAND_COLORS).sort();

    const visibleBrands = allBrands.filter((brand) => {
        if (mode !== 'instant') return true;
        const config = AppState.brandDiscounts[brand];
        // A brand with no config row at all defaults to visible (it just
        // won't be approvable until an admin sets a percentage) rather
        // than silently disappearing from the form.
        return config ? config.instantSellAvailable : true;
    });

    select.innerHTML =
        '<option value="">Select a brand</option>' +
        visibleBrands.map((b) => `<option ${b === previousValue ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('') +
        '<option value="Other"' + (previousValue === 'Other' ? ' selected' : '') + '>Other</option>';

    // If the brand the seller had selected is no longer valid for this
    // mode (e.g. they switch to Instant Sell and their brand is disabled
    // there), clear the selection rather than silently keeping a hidden
    // value selected.
    if (previousValue && !visibleBrands.includes(previousValue) && previousValue !== 'Other') {
        select.value = '';
        updateOffer();
    }
}

function showSellerTab(tab, event) {
    document.querySelectorAll('.seller-tab').forEach((t) => t.classList.add('hidden'));
    document.querySelectorAll('.sidebar-btn').forEach((b) => b.classList.remove('active'));

    const tabMap = {
        overview: 'sellerOverview',
        submit: 'sellerSubmit',
        submissions: 'sellerSubmissions',
        earnings: 'sellerEarnings'
    };

    const targetTabId = tabMap[tab];
    if (!targetTabId) return;

    document.getElementById(targetTabId).classList.remove('hidden');
    if (event?.target) {
        event.target.classList.add('active');
    }

    if (tab === 'submissions') renderSellerSubmissions();
    if (tab === 'earnings') renderSellerEarnings();
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

async function renderSellerEarnings() {
    if (!AppState.currentUser) return;

    try {
        await withLoading(async () => {
            const [{ data: subData, error: subError }, { data: listingData, error: listingError }] = await Promise.all([
                supabaseClient.from('submissions').select('*').eq('seller_id', AppState.currentUser.id),
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
                supabaseClient.from('submissions').select('*'),
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
            const pendingTable = document.getElementById('pendingTable');
            const pendingEmpty = document.getElementById('pendingEmpty');

            if (pending.length === 0) {
                pendingTable.innerHTML = '';
                pendingEmpty.classList.remove('hidden');
            } else {
                pendingEmpty.classList.add('hidden');
                pendingTable.innerHTML = `
                    <table>
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Seller</th>
                                <th>Brand</th>
                                <th>Mode</th>
                                <th>Value</th>
                                <th>Balance</th>
                                <th>Expiry</th>
                                <th>Date</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${pending
                                .map(
                                    (s) => `
                                <tr>
                                    <td data-label="ID">${s.id}</td>
                                    <td data-label="Seller">${s.sellerName}</td>
                                    <td data-label="Brand">${s.brand}</td>
                                    <td data-label="Mode">${
                                        s.saleMode === 'marketplace'
                                            ? `<span class="submission-mode-tag marketplace">Marketplace ($${s.sellerSetPrice != null ? s.sellerSetPrice.toFixed(2) : '?'})</span>`
                                            : `<span class="submission-mode-tag instant">Instant</span>`
                                    }</td>
                                    <td data-label="Value">${formatCurrency(s.faceValue)}</td>
                                    <td data-label="Balance">${formatCurrency(s.currentBalance)}</td>
                                    <td data-label="Expiry">${s.expiryDate}</td>
                                    <td data-label="Date">${new Date(s.createdAt).toLocaleDateString('en-NZ')}</td>
                                    <td data-label="Actions">
                                        <button class="btn btn-primary btn-sm" onclick="approveSubmission('${s.dbId}')">Approve</button>
                                        <button class="btn btn-outline btn-sm btn-danger-outline" onclick="rejectSubmission('${s.dbId}')">Reject</button>
                                    </td>
                                </tr>
                            `
                                )
                                .join('')}
                        </tbody>
                    </table>
                `;
            }

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

            document.getElementById('allListingsTable').innerHTML = `
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Brand</th>
                            <th>Value</th>
                            <th>Price</th>
                            <th>Discount</th>
                            <th>Seller</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${listings
                            .map(
                                (l) => {
                                    const isZeroBalance = !(l.faceValue > 0) || !(l.salePrice > 0);
                                    return `
                            <tr class="${isZeroBalance ? 'row-warning' : ''}">
                                <td data-label="ID">${l.id.slice(0, 8)}</td>
                                <td data-label="Brand">${l.brand}</td>
                                <td data-label="Value">${formatCurrency(l.faceValue)}${
                                        isZeroBalance
                                            ? '<span class="zero-balance-flag" title="Zero or invalid balance -- should never be purchasable. Investigate this listing."><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>Zero balance</span>'
                                            : ''
                                    }</td>
                                <td data-label="Price">${formatCurrency(l.salePrice)}</td>
                                <td data-label="Discount">${l.discount}%</td>
                                <td data-label="Seller">${l.seller}</td>
                                <td data-label="Status"><span class="badge ${l.status === 'active' ? 'badge-green' : l.status === 'sold' ? 'badge-blue' : 'badge-gray'}">${l.status}</span></td>
                            </tr>
                        `;
                                }
                            )
                            .join('')}
                    </tbody>
                </table>
            `;

            const { data: fullUsers, error: fullUsersError } = await supabaseClient
                .from('profiles')
                .select('name, email, role, created_at')
                .order('created_at', { ascending: false });

            if (fullUsersError) throw fullUsersError;

            document.getElementById('usersTable').innerHTML = `
                <table>
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Email</th>
                            <th>Role</th>
                            <th>Joined</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(fullUsers || [])
                            .map(
                                (u) => `
                            <tr>
                                <td data-label="Name">${u.name}</td>
                                <td data-label="Email">${u.email}</td>
                                <td data-label="Role"><span class="badge ${u.role === 'admin' ? 'badge-red' : u.role === 'seller' ? 'badge-blue' : 'badge-green'}">${u.role}</span></td>
                                <td data-label="Joined">${new Date(u.created_at).toLocaleDateString('en-NZ')}</td>
                            </tr>
                        `
                            )
                            .join('')}
                    </tbody>
                </table>
            `;
        });

        await renderBrandDiscountsTable();
    } catch (error) {
        document.getElementById('adminSkeleton').classList.add('hidden');
        showError(error, 'Unable to load admin dashboard.');
    }
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
                        <th>Available for Instant Sell</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${allBrands
                        .map((brand) => {
                            const config = discounts[brand];
                            const current = config ? config.discountPercent : null;
                            const isAvailable = config ? config.instantSellAvailable : true;
                            const inputId = `brandDiscountInput-${brand.replace(/[^a-zA-Z0-9]/g, '')}`;
                            const checkboxId = `brandAvailable-${brand.replace(/[^a-zA-Z0-9]/g, '')}`;
                            const errorId = `${inputId}Error`;
                            return `
                        <tr>
                            <td data-label="Brand"><strong>${escapeHtml(brand)}</strong></td>
                            <td data-label="Current Discount">${current === null ? 'Not set' : current + '%'}</td>
                            <td data-label="New Discount">
                                <input type="number" id="${inputId}" min="0" max="25" step="1" value="${current !== null ? current : ''}" placeholder="0-25" style="width: 90px;">
                                <span class="error-msg" id="${errorId}"></span>
                            </td>
                            <td data-label="Available for Instant Sell">
                                <label class="checkbox-group" style="margin:0;"><input type="checkbox" id="${checkboxId}" ${isAvailable ? 'checked' : ''}> Available</label>
                            </td>
                            <td data-label="Actions"><button class="btn btn-primary btn-sm" onclick="saveBrandDiscount('${escapeJsString(brand)}', '${inputId}', '${errorId}', '${checkboxId}')">Save</button></td>
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

async function saveBrandDiscount(brand, inputId, errorId, checkboxId) {
    const input = document.getElementById(inputId);
    const errorEl = document.getElementById(errorId);
    const checkbox = document.getElementById(checkboxId);
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

    try {
        const { error } = await supabaseClient
            .from('brand_discounts')
            .upsert(
                { brand, discount_percent: num, instant_sell_available: instantSellAvailable, updated_at: new Date().toISOString() },
                { onConflict: 'brand' }
            );

        if (error) throw error;

        AppState.brandDiscounts[brand] = { discountPercent: num, instantSellAvailable };
        showToast('success', `${brand} updated: ${num}% discount, ${instantSellAvailable ? 'available' : 'hidden'} for Instant Sell. Applies immediately.`);
        await renderBrandDiscountsTable();
    } catch (error) {
        showError(error, 'Unable to save this discount.');
    }
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

            if (isMarketplace) {
                salePrice = Number(sub.sellerSetPrice.toFixed(2));
                discount = Math.max(0, Math.min(100, Math.round((1 - salePrice / listingFaceValue) * 100)));
                commissionRate = MARKETPLACE_COMMISSION_RATE * 100;
                sellerPayoutAmount = Number((salePrice * (1 - MARKETPLACE_COMMISSION_RATE)).toFixed(2));
            } else {
                await loadBrandDiscounts();
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

        showToast('success', 'Submission approved and listed on marketplace!');
        renderAdmin();
    } catch (error) {
        showError(error, 'Unable to approve submission.');
    }
}

async function rejectSubmission(submissionDbId) {
    const reason = prompt('Enter rejection reason:');
    if (!reason) return;

    try {
        await withLoading(async () => {
            const { error } = await supabaseClient
                .from('submissions')
                .update({ status: 'rejected', admin_notes: reason, updated_at: new Date().toISOString() })
                .eq('id', submissionDbId);

            if (error) throw error;
        });

        showToast('info', `Submission rejected. Reason: ${reason}`);
        renderAdmin();
    } catch (error) {
        showError(error, 'Unable to reject submission.');
    }
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
}

async function promptInstall() {
    if (isIos()) {
        document.getElementById('iosInstallOverlay')?.classList.remove('hidden');
        document.getElementById('iosInstallModal')?.classList.remove('hidden');
        return;
    }

    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById('installBanner')?.classList.add('hidden');
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
