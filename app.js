const DEFAULT_CHECKOUT_STEP = 1;
const MAX_CHECKOUT_STEP = 4;
const SELLER_VERIFICATION_VALUE_THRESHOLD = 200;

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
    allListings: [],
    listingsCache: null
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

/**
 * Loads the live platform economics config (marketplace commission rate,
 * minimum card balance, minimum listing price) from pricing_config --
 * always fetched fresh, same convention as loadBrandDiscounts(), so an
 * admin's just-saved change takes effect on the very next read. Every
 * place that needs one of these three numbers reads AppState.pricingConfig
 * after calling this -- never a hardcoded fallback. A failed load leaves
 * AppState.pricingConfig null, which every caller treats as "blocked,
 * missing config" rather than silently proceeding with a guess.
 */
async function loadPricingConfig() {
    const { data, error } = await supabaseClient.from('pricing_config').select('marketplace_commission_rate, min_card_balance, min_listing_price').eq('id', 1).maybeSingle();
    if (error || !data) {
        console.error('Failed to load pricing config:', error);
        AppState.pricingConfig = null;
        return null;
    }
    AppState.pricingConfig = {
        commissionRate: Number(data.marketplace_commission_rate),
        minCardBalance: Number(data.min_card_balance),
        minListingPrice: Number(data.min_listing_price)
    };
    return AppState.pricingConfig;
}

async function loadBrandDiscounts() {
    const { data, error } = await supabaseClient
        .from('brand_discounts')
        .select('brand, discount_percent, resale_markup_percent, instant_sell_available, retailer_enabled, card_number_length, card_number_length_alt, card_number_format, pin_length, pin_required, confidence_level, validation_source, validation_notes, brand_color, brand_color_secondary, brand_text_color');
    if (error) {
        console.error('Failed to load brand discounts:', error);
        return AppState.brandDiscounts;
    }
    const map = {};
    (data || []).forEach((row) => {
        map[row.brand] = {
            discountPercent: Number(row.discount_percent),
            resaleMarkupPercent: Number(row.resale_markup_percent || 0),
            instantSellAvailable: row.instant_sell_available !== false,
            // The authoritative whole-retailer toggle. Every page that
            // needs to know "can this retailer be bought or sold right
            // now" reads THIS field, from THIS single loader -- never a
            // locally cached copy, never a hardcoded assumption.
            retailerEnabled: row.retailer_enabled !== false,
            // Retailer-specific card/PIN format rules, researched per
            // brand. NULL length/format fields mean validation for that
            // specific field is deliberately disabled -- the research
            // couldn't confirm it from an official source, so it's never
            // enforced with a guessed value.
            cardNumberLength: row.card_number_length,
            cardNumberLengthAlt: row.card_number_length_alt,
            cardNumberFormat: row.card_number_format,
            pinLength: row.pin_length,
            pinRequired: row.pin_required === true,
            confidenceLevel: row.confidence_level || 'low',
            validationSource: row.validation_source || '',
            validationNotes: row.validation_notes || '',
            brandColor: row.brand_color || null,
            brandColorSecondary: row.brand_color_secondary || null,
            brandTextColor: row.brand_text_color || null
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
    AppState.browsePage = 1;
    router('browse');
}

async function filterByBrand(brand) {
    const browseSearchInput = document.getElementById('searchInput');
    if (browseSearchInput) browseSearchInput.value = brand;
    AppState.browsePage = 1;
    await router('browse');
}

/**
 * Post-auth redirect flag for the /sell landing page's CTA. Stored in
 * localStorage (not sessionStorage) because Supabase's confirmation email
 * opens in a new tab -- sessionStorage is per-tab and would lose the flag
 * the moment that link is clicked, while localStorage is shared across
 * tabs of the same browser. Timestamped so a flag left over from an
 * abandoned signup attempt doesn't fire days later on an unrelated login.
 */
const SELLER_SUBMISSION_REDIRECT_KEY = 'giftlioPostAuthRedirect';
const SELLER_SUBMISSION_REDIRECT_TTL_MS = 24 * 60 * 60 * 1000;

function setSellerSubmissionRedirect() {
    localStorage.setItem(SELLER_SUBMISSION_REDIRECT_KEY, JSON.stringify({ target: 'seller-submit', ts: Date.now() }));
}

/**
 * Reads and clears the flag in one step -- consumed or expired, it's gone
 * either way, so a stale/corrupt entry can never linger past this check.
 * Returns true only if a still-valid seller-submit redirect was pending.
 */
function consumeSellerSubmissionRedirect() {
    const raw = localStorage.getItem(SELLER_SUBMISSION_REDIRECT_KEY);
    if (!raw) return false;
    localStorage.removeItem(SELLER_SUBMISSION_REDIRECT_KEY);
    try {
        const { target, ts } = JSON.parse(raw);
        return target === 'seller-submit' && typeof ts === 'number' && Date.now() - ts <= SELLER_SUBMISSION_REDIRECT_TTL_MS;
    } catch {
        return false;
    }
}

/**
 * The /sell landing page's single CTA. Logged-in sellers go straight to
 * the Submit a Card tab -- not the dashboard overview, since a visitor who
 * just clicked a "sell your card" button doesn't want to land on empty
 * stats. Logged-out visitors go to signup with the redirect flag set, so
 * they land on the same submission form once they've signed up and (if
 * required) confirmed their email and logged in.
 */
function startSellerSubmission() {
    if (AppState.currentUser) {
        router('seller-dashboard').then(() => showSellerTab('submit'));
        return;
    }
    setSellerSubmissionRedirect();
    router('signup');
}

/**
 * The /partners landing page's CTA. Reuses the existing contact form and
 * endpoint as-is -- just pre-selects the "Partnership Enquiry" subject so
 * these messages are distinguishable from support enquiries in the inbox,
 * with no new field and no new endpoint.
 */
function goToPartnerContact() {
    router('contact').then(() => {
        const subjectSelect = document.getElementById('contactSubject');
        if (subjectSelect) subjectSelect.value = 'Partnership Enquiry';
    });
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
    buy: 'buy-section',
    partners: 'partners-section',
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
    buy: '/buy',
    partners: '/partners',
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
    buy: 'Buy Discounted Gift Cards — Giftlio',
    partners: 'Partner With Giftlio',
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

// The full list of retailers Giftlio supports. Deliberately separate from
// colors now -- colors are admin-configured, live in brand_discounts, and
// load into AppState.brandDiscounts via loadBrandDiscounts(); this is just
// "which brands exist," which doesn't change based on admin color settings.
const SUPPORTED_BRANDS = ['The Warehouse', 'Woolworths', "Pak'nSave", 'New World', 'Farmers', 'Noel Leeming', 'Briscoes', 'Rebel Sport', 'PB Tech'];

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
    const config = AppState.brandDiscounts[brand];
    const color = config?.brandColor || '#10142E';
    const secondaryColor = config?.brandColorSecondary || null;
    const textColor = config?.brandTextColor || '#ffffff';

    if (secondaryColor) {
        // Split-color badge (e.g. New World's red/white). The outer pill
        // shows a genuine diagonal split of both brand colors; the text
        // itself sits in its own small dark backing chip so it stays
        // legible regardless of which color it crosses -- a literal
        // split background directly behind text risks becoming unreadable
        // wherever the two colors meet.
        return `<span class="retailer-badge retailer-badge-split" style="background:linear-gradient(135deg, ${color} 50%, ${secondaryColor} 50%)"><span class="retailer-badge-split-label">${safeBrand}</span></span>`;
    }

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
        pending_verification: 'Pending Review',
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

const BALANCE_CHECK_STALE_DAYS = 7;
const CHECK_TYPE_LABELS = { submission: 'Submission review', pre_delivery: 'Pre-delivery', post_delivery: 'Post-delivery' };

function daysSince(dateStr) {
    return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

function formatDaysAgo(days) {
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days} days ago`;
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
        receiptStoragePath: row.receipt_storage_path || null,
        cardPhotoFilename: row.card_photo_filename || '',
        cardPhotoStoragePath: row.card_photo_storage_path || null,
        offerAmount: Number(row.offer_amount),
        saleMode: row.sale_mode || 'instant',
        sellerSetPrice: row.seller_set_price !== null && row.seller_set_price !== undefined ? Number(row.seller_set_price) : null,
        status: STATUS_MAP.submission[row.status] || row.status,
        statusKey: row.status,
        adminNotes: row.admin_notes || '',
        paidAt: row.paid_at || null,
        approvedAt: row.approved_at || null,
        issueDate: row.issue_date || null,
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
        date: row.created_at,
        sellerPaid: Boolean(row.seller_paid),
        deliveredAt: row.delivered_at || null,
        payoutReleasedAt: row.payout_released_at || null,
        grossCommission: row.gross_commission !== null && row.gross_commission !== undefined ? Number(row.gross_commission) : null,
        stripeFee: row.stripe_fee !== null && row.stripe_fee !== undefined ? Number(row.stripe_fee) : null,
        stripeFeeIsEstimated: row.stripe_fee_is_estimated === true,
        netContribution: row.net_contribution !== null && row.net_contribution !== undefined ? Number(row.net_contribution) : null
    };
}

async function fetchProfile(userId) {
    const { data, error } = await supabaseClient
        .from('profiles')
        .select('id, name, email, role, created_at, suspended, suspended_reason, verification_status')
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
        suspendedReason: data.suspended_reason || null,
        verificationStatus: data.verification_status || 'unverified'
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
                if (consumeSellerSubmissionRedirect()) {
                    await router('seller-dashboard');
                    showSellerTab('submit');
                } else {
                    router('home');
                }
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
            if (consumeSellerSubmissionRedirect()) {
                await router('seller-dashboard');
                showSellerTab('submit');
            } else {
                router('home');
            }
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

const LISTINGS_CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Fetches active listings, with a short-lived cache. Before this, every
 * keystroke in Browse's search box triggered a fresh database round trip
 * -- search/sort/filter/pagination are all client-side operations over
 * the same underlying data, so there's no reason any of them should hit
 * the network at all. Real fetches now only happen when the cache is
 * empty, stale (>30s old), or explicitly invalidated (after an admin
 * action or a purchase that changes what's active).
 */
async function getActiveListings(forceRefresh = false) {
    const cache = AppState.listingsCache;
    const isFresh = cache && Date.now() - cache.fetchedAt < LISTINGS_CACHE_TTL_MS;

    if (!forceRefresh && isFresh) {
        return cache.data;
    }

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
    const listings = (data || [])
        .map(listingRowToView)
        .filter((l) => l.salePrice > 0 && l.faceValue > 0);

    AppState.listingsCache = { data: listings, fetchedAt: Date.now() };
    return listings;
}

function invalidateListingsCache() {
    AppState.listingsCache = null;
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
    const safeSeller = escapeHtml(listing.seller || 'Giftlio Seller');
    const verifyBadge = `<span class="card-verify"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>Reviewed by Giftlio</span>`;

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
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px; margin-right:3px;"><circle cx="12" cy="9" r="6"/><path d="M9 9l2 2 4-4"/></svg>Listed by ${safeSeller}${listing.cardsSold > 0 ? ` · ${listing.cardsSold} card${listing.cardsSold === 1 ? '' : 's'} sold` : ''}
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
            return `
        <div class="category-card" tabindex="0" role="button" aria-label="Browse ${escapeHtml(cat.label)} category: ${cat.brands.map(escapeHtml).join(', ')}" onclick="filterByCategory('${key}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault(); filterByCategory('${key}');}">
            <h3>${escapeHtml(cat.label)}</h3>
            <p class="cat-brands">${cat.brands.map(escapeHtml).join(' · ')}</p>
        </div>
    `;
        })
        .join('');

    const brands = SUPPORTED_BRANDS;
    await loadBrandDiscounts();

    // Marketplace-only now, so discount_percent (an Instant-Sell-era admin
    // setting) no longer reflects what buyers can actually get -- sellers
    // set their own prices. The honest number is the best discount among
    // real, currently-active listings, computed from the SAME cached data
    // Browse itself uses, so the homepage badge and what a buyer actually
    // finds after clicking can never disagree with each other.
    const activeListings = await getActiveListings();
    const bestDiscountByBrand = {};
    const countByBrand = {};
    let overallBestDiscount = null;
    activeListings.forEach((listing) => {
        const current = bestDiscountByBrand[listing.brand];
        if (current === undefined || listing.discount > current) {
            bestDiscountByBrand[listing.brand] = listing.discount;
        }
        countByBrand[listing.brand] = (countByBrand[listing.brand] || 0) + 1;
        if (overallBestDiscount === null || listing.discount > overallBestDiscount) {
            overallBestDiscount = listing.discount;
        }
    });

    // Only claim a specific percentage in the hero once there's real,
    // currently-live inventory to back it up -- the static fallback text
    // (set in the HTML) is deliberately generic and true regardless, so
    // there's never a moment where this headline overstates reality.
    const heroSubtitle = document.getElementById('heroSubtitle');
    if (heroSubtitle && typeof overallBestDiscount === 'number') {
        heroSubtitle.textContent = `NZ owned and operated — save up to ${overallBestDiscount}% on your favourite NZ brands`;
    }

    const brandsGrid = document.getElementById('brandsGrid');
    brandsGrid.innerHTML = brands
        .map((b) => {
            const bestDiscount = bestDiscountByBrand[b];
            const count = countByBrand[b] || 0;
            const hasListings = typeof bestDiscount === 'number';
            const discountLabel = hasListings ? `Up to ${bestDiscount}% off · ${count} card${count === 1 ? '' : 's'} available` : 'No cards listed yet';
            return `
        <div class="brand-card" tabindex="0" role="button" aria-label="Browse ${escapeHtml(b)} gift cards" onclick="filterByBrand('${escapeJsString(b)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault(); filterByBrand('${escapeJsString(b)}');}">
            ${retailerBadgeHTML(b)}
            <p class="${hasListings ? '' : 'brand-card-empty'}">${escapeHtml(discountLabel)}</p>
        </div>
    `;
        })
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
                document.getElementById('browsePagination').innerHTML = '';
                empty.classList.remove('hidden');
                renderBrowseEmptyState(allListings.length === 0);
            } else {
                empty.classList.add('hidden');
                const { items: pageListings, page, totalPages } = paginate(listings, AppState.browsePage || 1, 24);
                AppState.browsePage = page;
                AppState.browseFilteredFull = listings;
                grid.innerHTML = pageListings.map((l) => renderListingCard(l)).join('');
                renderPaginationControls('browsePagination', totalPages, page, 'goToBrowsePage');
            }
        });
    } catch (error) {
        showError(error, 'Unable to load listings.');
    }
}

function goToBrowsePage(page) {
    AppState.browsePage = page;
    // Re-slice from the already-filtered set rather than re-running
    // filters -- the page number is the only thing that changed.
    const { items: pageListings, page: safePage, totalPages } = paginate(AppState.browseFilteredFull || [], page, 24);
    AppState.browsePage = safePage;
    document.getElementById('browseGrid').innerHTML = pageListings.map((l) => renderListingCard(l)).join('');
    renderPaginationControls('browsePagination', totalPages, safePage, 'goToBrowsePage');
    document.getElementById('browseGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    AppState.browsePage = 1;
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
            <p class="empty-sub">Be the first to sell one! It only takes a couple of minutes, and every submission is reviewed by a Giftlio admin before it goes live.</p>
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
    AppState.browsePage = 1;
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
                        <p>This ${safeBrand} gift card was reviewed and approved by a Giftlio admin before being listed. Card details will be delivered via email within 24 hours of purchase.</p>
                    </div>
                    <div class="detail-section trust-icon-row">
                        <div class="trust-icon-item">
                            <span><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="6"/><path d="M9 9l2 2 4-4"/></svg></span>
                            <p>Reviewed<br>by Giftlio</p>
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
                                    Balance: ${formatCurrency(listing.faceValue)}
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
        // No buyer-side fee -- the buyer pays exactly the sale price.
        // Commission comes entirely out of the seller's payout.
        total: effectivePrice
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
        <p style="text-align: right; margin-bottom: 8px; color: var(--gray-500); font-size: 12px;">No buyer fees -- you pay exactly the listed price.</p>
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
        invalidateListingsCache();
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
                'Pending Review': 'badge-yellow',
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
                    <p><strong>Price Paid:</strong> ${formatCurrency(order.total)} (GST included)</p>
                    <p><strong>Purchase Date:</strong> ${new Date(order.date).toLocaleString('en-NZ')}</p>
                    <p><strong>Status:</strong> <span class="badge ${order.status === 'Pending Review' ? 'badge-yellow' : order.status === 'Delivered' ? 'badge-green' : 'badge-red'}">${order.status}</span></p>
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
                        <p>Your card is being reviewed. You will receive an email within 24 hours with the gift card details.</p>
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
    await Promise.all([loadBrandDiscounts(), loadPricingConfig()]);
    populateBrandDropdown();
    renderPricingMinimumsNotice();
    updateOffer();
}

/**
 * Shows the live minimum listing price and commission rate up front on
 * the Sell form, before a seller has typed anything -- pulled from
 * AppState.pricingConfig, never hardcoded text. If config failed to load,
 * says so plainly instead of showing a stale or guessed number.
 */
function renderPricingMinimumsNotice() {
    const noticeEl = document.getElementById('marketplaceCommissionNotice');
    const hintEl = document.getElementById('sellerPriceHint');
    if (!noticeEl || !hintEl) return;

    const config = AppState.pricingConfig;
    if (!config) {
        noticeEl.textContent = 'Pricing information is temporarily unavailable. Please try again shortly.';
        hintEl.textContent = '';
        return;
    }

    const commissionPct = Math.round(config.commissionRate * 1000) / 10;
    noticeEl.textContent = `You set your own asking price (minimum $${config.minListingPrice.toFixed(2)}). Giftlio takes a ${commissionPct}% commission, paid out once a buyer purchases your card.`;
    hintEl.textContent = `You'll receive ${(100 - commissionPct).toFixed(commissionPct % 1 === 0 ? 0 : 1)}% of this price once it sells (${commissionPct}% Giftlio commission). Minimum listing price is $${config.minListingPrice.toFixed(2)}.`;
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
    const allBrands = SUPPORTED_BRANDS.slice().sort();

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
    showBrandValidationHints();
    validateCardNumberField();
    validatePinField();
}

/**
 * Shows the brand-specific format hint under Card Number/PIN the instant a
 * retailer is selected -- e.g. "Woolworths card numbers are 19 digits."
 * For brands with unconfirmed rules, shows nothing rather than a guess.
 */
function showBrandValidationHints() {
    const brand = document.getElementById('subBrand').value;
    const rules = AppState.brandDiscounts[brand];
    const cardHint = document.getElementById('subCardNumHint');
    const pinHint = document.getElementById('subPinHint');

    if (!rules) {
        cardHint.classList.add('hidden');
        pinHint.classList.add('hidden');
        return;
    }

    const cardParts = [];
    if (rules.cardNumberLength) {
        cardParts.push(rules.cardNumberLengthAlt ? `${rules.cardNumberLength} or ${rules.cardNumberLengthAlt} digits` : `${rules.cardNumberLength} digits`);
    }
    if (rules.cardNumberFormat === 'alphanumeric') {
        cardParts.push('letters and numbers allowed');
    } else if (rules.cardNumberFormat === 'digits') {
        cardParts.push('digits only');
    }
    if (cardParts.length > 0) {
        cardHint.textContent = `${brand} card numbers: ${cardParts.join(', ')}`;
        cardHint.classList.remove('hidden');
    } else {
        cardHint.classList.add('hidden');
    }

    if (rules.pinRequired) {
        pinHint.textContent = rules.pinLength ? `${brand} requires a ${rules.pinLength}-digit PIN` : `${brand} requires a PIN`;
        pinHint.classList.remove('hidden');
    } else {
        pinHint.textContent = `${brand} does not require a PIN`;
        pinHint.classList.remove('hidden');
    }
}

/**
 * Real-time card number validation against the selected brand's rules --
 * mirrors the server-side trigger's logic exactly, so the client-side
 * error a seller sees while typing matches what the server would enforce.
 * Never trust this alone -- see validate_card_format() in the database
 * for the actual enforcement.
 */
function validateCardNumberField() {
    const brand = document.getElementById('subBrand').value;
    const value = document.getElementById('subCardNum').value;
    const errorEl = document.getElementById('subCardNumError');
    const rules = AppState.brandDiscounts[brand];
    errorEl.textContent = '';
    document.getElementById('subCardNum').classList.remove('field-error');

    if (!rules || !value) return true;

    if (rules.cardNumberLength) {
        const validLengths = [rules.cardNumberLength, rules.cardNumberLengthAlt].filter(Boolean);
        if (!validLengths.includes(value.length)) {
            const expected = validLengths.length > 1 ? `${validLengths.join(' or ')} digits` : `${validLengths[0]} digits`;
            errorEl.textContent = `${brand} card numbers are ${expected} long. You have entered ${value.length}.`;
            document.getElementById('subCardNum').classList.add('field-error');
            return false;
        }
    }

    if (rules.cardNumberFormat === 'digits' && !/^[0-9]+$/.test(value)) {
        errorEl.textContent = `${brand} card numbers contain digits only -- no letters or symbols.`;
        document.getElementById('subCardNum').classList.add('field-error');
        return false;
    }

    return true;
}

function validatePinField() {
    const brand = document.getElementById('subBrand').value;
    const value = document.getElementById('subPin').value;
    const errorEl = document.getElementById('subPinError');
    const rules = AppState.brandDiscounts[brand];
    errorEl.textContent = '';
    document.getElementById('subPin').classList.remove('field-error');

    if (!rules) return true;

    if (rules.pinRequired && !value) {
        // Only shown as a hard error at submit time (handleSubmission) --
        // while typing, an empty PIN just isn't flagged yet, since the
        // seller may not have reached that field.
        return true;
    }

    if (value && rules.pinLength && value.length !== rules.pinLength) {
        errorEl.textContent = `${brand} PINs are ${rules.pinLength} digits long. You have entered ${value.length}.`;
        document.getElementById('subPin').classList.add('field-error');
        return false;
    }

    return true;
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
    } else {
        // Called without a click event (e.g. startSellerSubmission()
        // landing a visitor directly on a tab) -- find the matching
        // sidebar button by its existing onclick attribute instead.
        document.querySelector(`.sidebar-btn[onclick*="'${tab}'"]`)?.classList.add('active');
    }

    if (tab === 'submissions') renderSellerSubmissions();
    if (tab === 'earnings') renderSellerEarnings();
    if (tab === 'settings') renderSellerSettings();
    if (tab === 'offers') renderSellerOffers();
    // The submit form's brand tile picker and live pricing preview were
    // only ever populated via the standalone /sell route's renderSellPage()
    // -- a page that doesn't even contain this form. Reaching this tab any
    // other way (the dashboard sidebar, "Submit New Gift Card", the /sell
    // landing page's CTA) left the tiles empty and the pricing notice
    // stuck on its placeholder text. Initializing here, at the one place
    // every path into this tab actually passes through, fixes it for all
    // of them at once.
    if (tab === 'submit') {
        Promise.all([loadBrandDiscounts(), loadPricingConfig()]).then(() => {
            populateBrandDropdown();
            renderPricingMinimumsNotice();
            updateOffer();
        });
    }
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
                    .order('created_at', { ascending: false }),
                loadPricingConfig()
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
    return checked ? checked.value : 'marketplace';
}

/**
 * Genuinely disables the Submit for Review button (not just a
 * post-click error) until at least a receipt or a card photo is
 * selected. Called on every file input change, in every code path.
 */
function updateSubmitButtonState() {
    const btn = document.getElementById('submitForReviewBtn');
    if (!btn) return;
    const hasReceipt = document.getElementById('subReceipt')?.files.length > 0;
    const hasCardPhoto = document.getElementById('subCardPhoto')?.files.length > 0;
    btn.disabled = !(hasReceipt || hasCardPhoto);
}

function handleSaleModeChange() {
    // Marketplace-only for now (Instant Sell paused until there's capital
    // to fund it) -- getSelectedSaleMode() always returns 'marketplace'
    // via the hidden input on the Sell form, so this function no longer
    // needs to toggle between two visual options. The issue date field
    // (Instant Sell only) stays hidden entirely rather than just relabeled,
    // since it can never be relevant while Instant Sell is off.
    populateBrandDropdown();
    updateOffer();
}

function updateOffer() {
    const mode = getSelectedSaleMode();
    const offerLabel = document.getElementById('offerLabel');
    const offerNote = document.getElementById('offerNote');

    if (mode === 'marketplace') {
        const askingPrice = parseFloat(document.getElementById('subSellerPrice').value) || 0;
        const config = AppState.pricingConfig;
        if (!config) {
            offerLabel.innerHTML = `You'll receive: <strong id="offerAmount">$0.00</strong>`;
            offerNote.textContent = 'Pricing information is temporarily unavailable -- please try again shortly';
            return;
        }
        const sellerPayout = askingPrice > 0 ? GiftlioPricing.calculateMarketplacePayout(askingPrice, config.commissionRate).sellerPayout : 0;
        const commissionPct = Math.round(config.commissionRate * 1000) / 10;
        offerLabel.innerHTML = `You'll receive: <strong id="offerAmount">${formatCurrency(sellerPayout)}</strong>`;
        offerNote.textContent = `Paid out once a buyer purchases your card, after ${commissionPct}% commission`;
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

    // Seller history, needed for several of the rules below: new vs
    // established sellers get different value caps, different daily
    // submission limits, and different evidence requirements. "Established"
    // is defined consistently as 5+ approved submissions -- the same bar
    // used for both the daily-limit tier and the evidence-requirement tier,
    // rather than two different implicit thresholds.
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [{ count: approvedCount }, { count: recentCount }, { count: disputeCount }, { count: completedSalesCount }] = await Promise.all([
        supabaseClient.from('submissions').select('id', { count: 'exact', head: true }).eq('seller_id', AppState.currentUser.id).eq('status', 'approved'),
        supabaseClient.from('submissions').select('id', { count: 'exact', head: true }).eq('seller_id', AppState.currentUser.id).gte('created_at', twentyFourHoursAgo).is('deleted_at', null),
        supabaseClient.from('disputes').select('id', { count: 'exact', head: true }).eq('seller_id', AppState.currentUser.id),
        // Distinct from approvedCount above -- this counts actual completed
        // Marketplace SALES (listings that sold to a real buyer), not just
        // approved submissions. A seller could have several Instant Sell
        // approvals and zero completed Marketplace sales, or vice versa --
        // the $100 new-Marketplace-seller cap below is specifically about
        // Marketplace sales history, not submission history in general.
        supabaseClient.from('listings').select('id', { count: 'exact', head: true }).eq('seller_id', AppState.currentUser.id).eq('sale_mode', 'marketplace').eq('status', 'sold'),
        loadPricingConfig()
    ]);
    const isEstablishedSeller = (approvedCount || 0) >= 5;
    const isNewSeller = (approvedCount || 0) < 3;
    const isNewMarketplaceSeller = (completedSalesCount || 0) < 3;

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
        } else if (brandConfig) {
            // Retailer-specific card/PIN format rules -- mirrors the
            // server-side trigger exactly, so a seller never gets past
            // this screen only to have the submission silently rejected
            // by the database with no explanation.
            if (!validateCardNumberField()) hasError = true;
            if (!cardNum) {
                setFieldError('subCardNum', 'subCardNumError', 'Enter the gift card number');
                hasError = true;
            }
            if (brandConfig.pinRequired && !pin) {
                setFieldError('subPin', 'subPinError', `A PIN is required for ${brand} gift cards.`);
                hasError = true;
            } else if (!validatePinField()) {
                hasError = true;
            }
        }
    }

    // For brands where we can't programmatically validate the card
    // Mandatory for every submission now, both modes -- deliberately
    // superseding the earlier conditional version (which only required
    // this for unconfirmed brands or new/flagged sellers). No text-only
    // submissions, full stop.
    const hasReceipt = document.getElementById('subReceipt').files.length > 0;
    const hasCardPhoto = document.getElementById('subCardPhoto').files.length > 0;
    if (!hasReceipt && !hasCardPhoto) {
        const message = 'Please upload a receipt or a photo of your gift card.';
        setFieldError('subReceipt', 'subReceiptError', message);
        setFieldError('subCardPhoto', 'subCardPhotoError', message);
        hasError = true;
    }

    const faceValueCheck = GiftlioPricing.validateFaceValue(valueRaw);
    if (!faceValueCheck.valid) {
        setFieldError('subValue', 'subValueError', faceValueCheck.error);
        hasError = true;
    } else if (value < 10) {
        setFieldError('subValue', 'subValueError', 'Minimum card value is $10.');
        hasError = true;
    } else if (value > 500 && isNewSeller) {
        setFieldError('subValue', 'subValueError', 'Maximum card value for new sellers is $500.');
        hasError = true;
    }

    // Only check the balance against face value if the face value itself
    // was valid -- otherwise "balance exceeds value" is a confusing error
    // to show on top of an already-broken value field.
    const balanceCheck = GiftlioPricing.validateBalance(balanceRaw, faceValueCheck.valid ? value : null);
    if (!balanceCheck.valid) {
        setFieldError('subBalance', 'subBalanceError', balanceCheck.error);
        hasError = true;
    } else if (faceValueCheck.valid) {
        // Both floors must pass: 20% of this card's own face value, AND
        // the configured absolute-dollar minimum -- whichever is stricter
        // for this face value is the one that actually blocks. Mirrors
        // the DB trigger exactly, via the same shared helper.
        const floorCheck = GiftlioPricing.validateCardBalanceFloor(balanceRaw, value, AppState.pricingConfig?.minCardBalance);
        if (!floorCheck.valid) {
            setFieldError('subBalance', 'subBalanceError', floorCheck.error);
            hasError = true;
        }
    }

    if (saleMode === 'marketplace') {
        const priceCheck = GiftlioPricing.validateFaceValue(sellerSetPriceRaw);
        if (!priceCheck.valid) {
            setFieldError('subSellerPrice', 'subSellerPriceError', 'Enter your asking price');
            hasError = true;
        } else if (balanceCheck.valid && sellerSetPrice > balance) {
            setFieldError('subSellerPrice', 'subSellerPriceError', "Asking price can't be more than the card's balance");
            hasError = true;
        } else {
            const listingPriceCheck = GiftlioPricing.validateMinListingPrice(sellerSetPriceRaw, AppState.pricingConfig?.minListingPrice);
            if (!listingPriceCheck.valid) {
                setFieldError('subSellerPrice', 'subSellerPriceError', listingPriceCheck.error);
                hasError = true;
            } else if (sellerSetPrice > 100 && isNewMarketplaceSeller) {
                setFieldError('subSellerPrice', 'subSellerPriceError', 'New sellers are limited to $100 maximum. Complete 3 sales to unlock higher values.');
                hasError = true;
            }
        }
    } else if (brand && balanceCheck.valid) {
        // Instant Sell: the actual sale price is only finalised at
        // approval (brand discount rates can change between now and
        // then), so this is an early estimate using the CURRENT rate --
        // approveSubmission() re-checks this for real at approval time,
        // this is just to catch an obviously-too-low card before the
        // seller even submits it.
        const estimateBrandConfig = AppState.brandDiscounts[brand];
        if (estimateBrandConfig) {
            const estimate = GiftlioPricing.calculateSalePrice(balance, estimateBrandConfig.discountPercent);
            if (estimate.purchasable && estimate.salePrice < 10) {
                setFieldError('subBalance', 'subBalanceError', 'Minimum card value is $10.');
                hasError = true;
            }
        }
    }
    if (!expiry) {
        setFieldError('subExpiry', 'subExpiryError', 'Enter the card\'s expiry date');
        hasError = true;
    } else {
        const expiryDate = new Date(expiry);
        const sixtyDaysFromNow = new Date();
        sixtyDaysFromNow.setDate(sixtyDaysFromNow.getDate() + 60);
        if (expiryDate < sixtyDaysFromNow) {
            setFieldError('subExpiry', 'subExpiryError', 'Cards must be valid for at least 60 days.');
            hasError = true;
        }
    }
    const issueDate = document.getElementById('subIssueDate').value;
    if (saleMode === 'instant' && !issueDate) {
        setFieldError('subIssueDate', 'subIssueDateError', 'Issue date is required for Instant Sell submissions.');
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

    // Daily submission limits, tiered by trust: newer sellers (fewer than
    // 5 approved submissions) are capped at 3 per day; established sellers
    // get more room, up to 10 per day. A form-level rule, not tied to any
    // one field, so it shows as a toast rather than an inline error.
    const dailyCap = isEstablishedSeller ? 10 : 3;
    if ((recentCount || 0) >= dailyCap) {
        showToast('error', 'Daily submission limit reached. Try again tomorrow.');
        hasError = true;
    }

    if (hasError) return;

    let offerAmount;
    if (saleMode === 'marketplace') {
        const payout = GiftlioPricing.calculateMarketplacePayout(sellerSetPrice, AppState.pricingConfig?.commissionRate);
        if (payout.error) {
            showToast('error', 'Pricing information is temporarily unavailable. Please try again shortly.');
            return;
        }
        offerAmount = payout.sellerPayout;
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

    // Actually upload the receipt to Storage, if one was selected. This
    // replaces the old behavior of just storing the typed/selected
    // filename as text with nothing behind it -- the file itself now goes
    // to the private receipts bucket under the seller's own folder, and we
    // keep the returned storage path so it can be viewed later (via a
    // signed URL, since the bucket isn't public).
    let receiptStoragePath = null;
    const receiptFile = document.getElementById('subReceipt').files[0];
    if (receiptFile) {
        try {
            const safeName = receiptFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const path = `${AppState.currentUser.id}/${Date.now()}-${safeName}`;
            const { error: uploadError } = await supabaseClient.storage.from('receipts').upload(path, receiptFile, {
                contentType: receiptFile.type,
                upsert: false
            });

            if (uploadError) throw uploadError;
            receiptStoragePath = path;
        } catch (uploadError) {
            console.error('Receipt upload failed:', uploadError);
            showToast('warning', 'Your receipt could not be uploaded, but the rest of your submission will still go through. You can email it to support@giftlio.co.nz if needed.');
        }
    }

    let cardPhotoStoragePath = null;
    const cardPhotoFile = document.getElementById('subCardPhoto').files[0];
    if (cardPhotoFile) {
        try {
            const safeName = cardPhotoFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const path = `${AppState.currentUser.id}/${Date.now()}-photo-${safeName}`;
            const { error: uploadError } = await supabaseClient.storage.from('receipts').upload(path, cardPhotoFile, {
                contentType: cardPhotoFile.type,
                upsert: false
            });

            if (uploadError) throw uploadError;
            cardPhotoStoragePath = path;
        } catch (uploadError) {
            console.error('Card photo upload failed:', uploadError);
            showToast('warning', 'Your card photo could not be uploaded, but the rest of your submission will still go through. You can email it to support@giftlio.co.nz if needed.');
        }
    }

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
                issue_date: issueDate || null,
                card_number: cardNum,
                pin: pin || null,
                receipt_filename: document.getElementById('fileName').textContent || null,
                receipt_storage_path: receiptStoragePath,
                card_photo_filename: document.getElementById('cardPhotoFileName').textContent || null,
                card_photo_storage_path: cardPhotoStoragePath,
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
             <p>We've received your ${escapeHtml(brand)} gift card submission (#${escapeHtml(submissionPublicId)}) and it's now being reviewed. We'll email you as soon as it's been looked at.</p>`
        });

        // Seller verification queue: a new/unverified seller submitting a
        // high-value card gets flagged for admin review before it's business
        // as usual -- doesn't block THIS submission from going through, just
        // marks the account for a human to look at.
        let justFlagged = false;
        if (value > SELLER_VERIFICATION_VALUE_THRESHOLD && AppState.currentUser.verificationStatus === 'unverified') {
            const { error: flagError } = await supabaseClient.from('profiles').update({ verification_status: 'flagged' }).eq('id', AppState.currentUser.id);
            if (!flagError) {
                AppState.currentUser.verificationStatus = 'flagged';
                justFlagged = true;
                await notifyAdmin(
                    'seller_flagged_for_verification',
                    `Seller flagged for verification: ${escapeHtml(AppState.currentUser.name)}`,
                    `<p>${escapeHtml(AppState.currentUser.name)} (${escapeHtml(AppState.currentUser.email)}) submitted a ${escapeHtml(brand)} card worth ${formatCurrency(value)} -- above the ${formatCurrency(SELLER_VERIFICATION_VALUE_THRESHOLD)} auto-review threshold, and this account was still unverified.</p>
                     <p><a href="${window.location.origin}/admin">Review in the Seller Verification queue</a></p>`,
                    AppState.currentUser.id
                );
            }
        }

        showToast('success', `Your gift card has been submitted for review. Submission ID: ${submissionPublicId}`);
        if (justFlagged) {
            showToast('info', 'Since this is a higher-value submission on a new account, our team will take an extra look before approving.');
        }
        document.getElementById('submissionForm').reset();
        document.getElementById('fileName').textContent = '';
        document.getElementById('cardPhotoFileName').textContent = '';
        updateSubmitButtonState();
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
            // honestly show whether Giftlio has since listed/sold the card --
            // and, critically, whether the payout has actually been released
            // (not just whether the card sold/was approved).
            const submissionIds = submissions.map((s) => s.dbId).filter(Boolean);
            let listingBySubmission = {};
            if (submissionIds.length) {
                const { data: listingRows } = await supabaseClient
                    .from('listings')
                    .select('id, submission_id, status, sale_mode')
                    .in('submission_id', submissionIds);

                const soldMarketplaceListingIds = (listingRows || []).filter((l) => l.sale_mode === 'marketplace' && l.status === 'sold').map((l) => l.id);
                let sellerPaidByListingId = new Map();
                if (soldMarketplaceListingIds.length) {
                    const { data: orderRows } = await supabaseClient.from('orders').select('listing_id, seller_paid').in('listing_id', soldMarketplaceListingIds);
                    sellerPaidByListingId = new Map((orderRows || []).map((o) => [o.listing_id, o.seller_paid]));
                }

                (listingRows || []).forEach((l) => {
                    listingBySubmission[l.submission_id] = {
                        status: l.status,
                        payoutReleased: l.sale_mode === 'marketplace' ? sellerPaidByListingId.get(l.id) === true : undefined
                    };
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

function renderSubmissionCard(s, listingInfo) {
    const listingStatus = listingInfo?.status;
    const isRejected = s.status === 'Rejected';
    const isPending = s.status === 'Pending Review';
    const isApproved = s.status === 'Approved' || s.status === 'Listed' || s.status === 'Sold';
    const isListed = isApproved && Boolean(listingStatus);
    const isSold = listingStatus === 'sold';
    const isMarketplace = s.saleMode === 'marketplace';

    // "Payout Sent" is only genuinely done once the payout was actually
    // released -- not just because the card was approved (Instant Sell)
    // or sold (Marketplace). Showing this as complete before the money
    // actually moved is exactly the misleading-earnings bug this whole
    // holding-period system exists to fix.
    const isPayoutReleased = isMarketplace ? listingInfo?.payoutReleased === true : Boolean(s.paidAt);

    // The stage ORDER genuinely differs by mode, not just the labels:
    // Instant Sell pays at approval, before the card is even resold, so
    // Payout Sent comes third. Marketplace only pays once a buyer actually
    // purchases, so Payout Sent has to be last -- putting it third for
    // marketplace would misrepresent when the seller's money actually moves.
    const stages = isMarketplace
        ? [
              { key: 'submitted', label: 'Submitted', done: true },
              { key: 'verified', label: 'Under Review', done: !isPending },
              { key: 'listed', label: 'Listed for Sale', done: isListed },
              { key: 'sold', label: 'Sold to Buyer', done: isSold },
              { key: 'payout', label: 'Payout Released', done: isPayoutReleased }
          ]
        : [
              { key: 'submitted', label: 'Submitted', done: true },
              { key: 'verified', label: 'Reviewed by Giftlio', done: !isPending },
              { key: 'payout', label: 'Payout Sent', done: isPayoutReleased },
              { key: 'listed', label: 'Listed for Resale', done: isListed },
              { key: 'sold', label: 'Sold to Buyer', done: isSold }
          ];
    const doneCount = stages.filter((st) => st.done).length;
    const currentIndex = stages.findIndex((st) => !st.done);
    const fillPercent = (Math.max(doneCount - 1, 0) / (stages.length - 1)) * 100;

    const badgeMap = { 'Pending Review': 'badge-yellow', Approved: 'badge-green', Rejected: 'badge-red', Listed: 'badge-blue', Sold: 'badge-green' };
    const commissionPct = AppState.pricingConfig ? Math.round(AppState.pricingConfig.commissionRate * 1000) / 10 : null;
    const modeLabel = isMarketplace
        ? `<span class="submission-mode-tag marketplace">Marketplace${commissionPct !== null ? ` · ${commissionPct}% commission` : ''}</span>`
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
        isMarketplace ? (isSold ? ' — paid out' : ' (paid once sold)') : isApproved ? ' — paid out' : ' (paid once approved)'
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

    // A counter-offer is a price a buyer could actually end up paying, so
    // it's held to the same floor a listing price is -- UX-only client
    // side check (the DB doesn't separately enforce this for offers), but
    // still sourced from the live config, never a hardcoded number.
    await loadPricingConfig();
    const listingPriceCheck = GiftlioPricing.validateMinListingPrice(amount, AppState.pricingConfig?.minListingPrice);
    if (!listingPriceCheck.valid) {
        showToast('warning', listingPriceCheck.error);
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

            // Need the listing IDs before orders can be fetched -- can't
            // parallelize this with the query above.
            const marketplaceListingIds = listings.filter((l) => l.sale_mode === 'marketplace' && l.status === 'sold').map((l) => l.id);
            let ordersByListingId = new Map();
            if (marketplaceListingIds.length > 0) {
                const { data: orderData, error: orderError } = await supabaseClient
                    .from('orders')
                    .select('listing_id, seller_paid, delivered_at, payout_released_at')
                    .in('listing_id', marketplaceListingIds);
                if (orderError) throw orderError;
                ordersByListingId = new Map((orderData || []).map((o) => [o.listing_id, o]));
            }

            const now = Date.now();

            // Instant Sell: only actually earned once paid_at is set --
            // being approved is not the same as being paid. "Pending" is
            // approved-but-unpaid regardless of holding period; "available"
            // is the subset that's already past the 24-hour hold.
            let instantEarned = 0;
            let instantPending = 0;
            let instantAvailable = 0;
            const payoutHistory = [];
            submissions
                .filter((s) => s.saleMode === 'instant' && s.statusKey === 'approved')
                .forEach((s) => {
                    if (s.paidAt) {
                        instantEarned += s.offerAmount || 0;
                        payoutHistory.push({ date: s.paidAt, brand: s.brand, amount: s.offerAmount || 0, type: 'Instant Sell' });
                        return;
                    }
                    instantPending += s.offerAmount || 0;
                    if (s.approvedAt) {
                        const unlocksAt = new Date(s.approvedAt).getTime() + INSTANT_SELL_PAYOUT_HOLD_HOURS * 60 * 60 * 1000;
                        if (now >= unlocksAt) instantAvailable += s.offerAmount || 0;
                    }
                });

            // Marketplace: only actually earned once the linked order's
            // seller_paid is true -- a sold listing alone isn't a payout.
            let marketplaceEarned = 0;
            let marketplacePending = 0;
            let marketplaceAvailable = 0;
            let marketplaceUnsold = 0;
            listings
                .filter((l) => l.sale_mode === 'marketplace')
                .forEach((l) => {
                    const payout = Number(l.seller_payout_amount || 0);
                    if (l.status === 'active') {
                        marketplaceUnsold += payout;
                        return;
                    }
                    if (l.status !== 'sold') return;

                    const order = ordersByListingId.get(l.id);
                    if (order?.seller_paid) {
                        marketplaceEarned += payout;
                        payoutHistory.push({ date: order.payout_released_at || l.updated_at, brand: l.brand, amount: payout, type: 'Marketplace' });
                        return;
                    }
                    marketplacePending += payout;
                    if (order?.delivered_at) {
                        const unlocksAt = new Date(order.delivered_at).getTime() + MARKETPLACE_PAYOUT_HOLD_HOURS * 60 * 60 * 1000;
                        if (now >= unlocksAt) marketplaceAvailable += payout;
                    }
                });

            const total = instantEarned + marketplaceEarned;
            const pending = instantPending + marketplacePending;
            const available = instantAvailable + marketplaceAvailable;

            document.getElementById('earnTotal').textContent = formatCurrency(total);
            document.getElementById('earnPaid').textContent = formatCurrency(pending);
            document.getElementById('earnAvailable').textContent = formatCurrency(available);

            const pendingNote = document.getElementById('earnPendingNote');
            if (pendingNote) {
                if (marketplaceUnsold > 0) {
                    pendingNote.textContent = `Plus ${formatCurrency(marketplaceUnsold)} pending from marketplace listings not yet sold`;
                    pendingNote.classList.remove('hidden');
                } else {
                    pendingNote.classList.add('hidden');
                }
            }

            const historyTable = document.getElementById('payoutHistoryTable');
            const historyEmpty = document.getElementById('payoutEmpty');
            if (historyTable && historyEmpty) {
                payoutHistory.sort((a, b) => new Date(b.date) - new Date(a.date));
                if (payoutHistory.length === 0) {
                    historyTable.innerHTML = '';
                    historyEmpty.classList.remove('hidden');
                } else {
                    historyEmpty.classList.add('hidden');
                    historyTable.innerHTML = `
                        <table>
                            <thead><tr><th>Date</th><th>Brand</th><th>Type</th><th>Amount</th><th>Status</th></tr></thead>
                            <tbody>
                                ${payoutHistory
                                    .map(
                                        (p) => `
                                    <tr>
                                        <td data-label="Date">${new Date(p.date).toLocaleDateString('en-NZ')}</td>
                                        <td data-label="Brand">${escapeHtml(p.brand)}</td>
                                        <td data-label="Type">${escapeHtml(p.type)}</td>
                                        <td data-label="Amount">${formatCurrency(p.amount)}</td>
                                        <td data-label="Status"><span class="badge badge-green">Paid</span></td>
                                    </tr>
                                `
                                    )
                                    .join('')}
                            </tbody>
                        </table>
                    `;
                }
            }
        });
    } catch (error) {
        showError(error, 'Unable to load earnings.');
    }
}

let adminAutoRefreshTimer = null;

function startAdminAutoRefresh() {
    stopAdminAutoRefresh();
    adminAutoRefreshTimer = setInterval(async () => {
        // Only worth refetching if the admin section is actually the one
        // on screen -- no point polling in the background when the admin
        // has navigated to a completely different part of the site.
        const adminSection = document.getElementById('admin-section');
        if (!adminSection || adminSection.classList.contains('hidden')) return;
        if (!AppState.adminData) return;

        try {
            const [listingsRes, submissionsRes, ordersRes] = await Promise.all([
                supabaseClient.from('listings').select('*'),
                supabaseClient.from('submissions').select('*').is('deleted_at', null),
                supabaseClient.from('orders').select('*')
            ]);
            if (listingsRes.error || submissionsRes.error || ordersRes.error) return;

            AppState.adminData.listings = (listingsRes.data || []).map(listingRowToView);
            AppState.adminData.submissions = (submissionsRes.data || []).map(submissionRowToView);
            AppState.adminData.orders = (ordersRes.data || []).map(orderRowToView);

            updateAdminNavBadges();
            if (AppState.currentAdminPage === 'dashboard') {
                renderDashboardCards();
                renderRevenueChart();
                renderStatusChart();
            }
        } catch (error) {
            console.error('Admin auto-refresh failed:', error);
        }
    }, 30000);
}

function stopAdminAutoRefresh() {
    if (adminAutoRefreshTimer) {
        clearInterval(adminAutoRefreshTimer);
        adminAutoRefreshTimer = null;
    }
}

async function renderAdmin() {
    if (!AppState.currentUser || AppState.currentUser.role !== 'admin') {
        router('home');
        return;
    }

    // Every action (approve, suspend, etc.) calls renderAdmin() again to
    // refresh data -- clearing these flags forces whichever page is
    // currently open to re-render with the fresh data. Pages the admin
    // hasn't visited yet this session stay lazy (see switchAdminPage).
    Object.keys(adminPageRenderedOnce).forEach((k) => delete adminPageRenderedOnce[k]);

    document.getElementById('adminWelcomeEmpty').classList.add('hidden');
    document.getElementById('adminPagesWrap').classList.remove('hidden');
    const adminCardsGrid = document.getElementById('adminCardsGrid');
    adminCardsGrid.innerHTML = renderSkeletonStatCards(6);

    try {
        await withLoading(async () => {
            const [usersRes, listingsRes, submissionsRes, ordersRes, , emailQueueRes, balanceChecksRes] = await Promise.all([
                supabaseClient.from('profiles').select('id, name, email, role, created_at, suspended, verification_status'),
                supabaseClient.from('listings').select('*'),
                supabaseClient.from('submissions').select('*').is('deleted_at', null),
                supabaseClient.from('orders').select('*'),
                loadBrandDiscounts(),
                supabaseClient.from('email_queue').select('id, status'),
                supabaseClient
                    .from('balance_checks')
                    .select('submission_id, listing_id, claimed_balance, checked_balance, status, created_at')
                    .order('created_at', { ascending: false })
            ]);
            if (!emailQueueRes.error) AppState.emailQueueRows = emailQueueRes.data || [];

            if (usersRes.error) throw usersRes.error;
            if (listingsRes.error) throw listingsRes.error;
            if (submissionsRes.error) throw submissionsRes.error;
            if (ordersRes.error) throw ordersRes.error;

            const users = usersRes.data || [];
            const listings = (listingsRes.data || []).map(listingRowToView);
            const submissions = (submissionsRes.data || []).map(submissionRowToView);
            const orders = (ordersRes.data || []).map(orderRowToView);

            // Latest-only maps, keyed both ways -- a listing's freshest check
            // might be the one taken at submission review (keyed by
            // submission_id, before the listing even existed) or a later
            // pre/post-delivery one (keyed by listing_id). Rows already come
            // back newest-first, so the first hit per key IS the latest.
            const latestBalanceCheckBySubmission = new Map();
            const latestBalanceCheckByListing = new Map();
            if (!balanceChecksRes.error) {
                (balanceChecksRes.data || []).forEach((c) => {
                    if (c.submission_id && !latestBalanceCheckBySubmission.has(c.submission_id)) latestBalanceCheckBySubmission.set(c.submission_id, c);
                    if (c.listing_id && !latestBalanceCheckByListing.has(c.listing_id)) latestBalanceCheckByListing.set(c.listing_id, c);
                });
            }
            AppState.latestBalanceCheckBySubmission = latestBalanceCheckBySubmission;
            AppState.latestBalanceCheckByListing = latestBalanceCheckByListing;

            // Cached once per admin visit rather than re-fetched on every
            // sidebar click -- switching pages should feel instant, not
            // trigger a fresh round trip every time.
            AppState.adminData = { users, listings, submissions, orders };
            AppState.allListings = listings;

            const welcomeEmpty = document.getElementById('adminWelcomeEmpty');
            const pagesWrap = document.getElementById('adminPagesWrap');
            // Truly blank slate: only the admin's own account exists, and
            // nothing has ever been listed, submitted, or sold.
            const isBlankSlate = users.length <= 1 && listings.length === 0 && submissions.length === 0 && orders.length === 0;

            if (isBlankSlate) {
                welcomeEmpty.classList.remove('hidden');
                pagesWrap.classList.add('hidden');
                return;
            }

            welcomeEmpty.classList.add('hidden');
            pagesWrap.classList.remove('hidden');

            updateAdminNavBadges();
            switchAdminPage(AppState.currentAdminPage || 'dashboard');
            startAdminAutoRefresh();
        });
    } catch (error) {
        showError(error, 'Unable to load admin dashboard.');
    }
}

/**
 * The admin sub-router. Every sidebar link calls this instead of the
 * top-level app router() -- this only swaps which .admin-page is visible
 * within the already-loaded admin shell, using the data already cached in
 * AppState.adminData from renderAdmin(). Heavy widgets (charts, the brand
 * table, the audit log, disputes) only render the FIRST time their page is
 * opened in this session -- true lazy loading, not just hidden divs with
 * everything pre-rendered underneath.
 */
const adminPageRenderedOnce = {};

function switchAdminPage(page) {
    AppState.currentAdminPage = page;
    document.querySelectorAll('.admin-page').forEach((el) => el.classList.add('hidden'));
    document.querySelectorAll('.admin-nav-item').forEach((el) => el.classList.toggle('active', el.dataset.adminPage === page));

    const pageMap = {
        dashboard: 'adminPageDashboard',
        submissions: 'adminPageSubmissions',
        listings: 'adminPageListings',
        users: 'adminPageUsers',
        brands: 'adminPageBrands',
        notifications: 'adminPageNotifications',
        audit: 'adminPageAudit',
        verification: 'adminPageVerification',
        disputes: 'adminPageDisputes'
    };
    const target = document.getElementById(pageMap[page]);
    if (!target) return;
    target.classList.remove('hidden');

    if (window.innerWidth <= 900) closeAdminMobileSidebar();

    if (!AppState.adminData) return;
    const { listings, submissions, users, orders } = AppState.adminData;

    if (page === 'dashboard') {
        renderDashboardCards();
        renderRevenueChart();
        renderStatusChart();
        renderEconomicsCard();
    } else if (page === 'submissions' && !adminPageRenderedOnce.submissions) {
        const pending = submissions.filter((s) => s.statusKey === 'pending_review');
        renderInstantPendingTable(pending.filter((s) => s.saleMode !== 'marketplace'));
        renderMarketplacePendingTable(pending.filter((s) => s.saleMode === 'marketplace'));
        renderPendingDeliveryTable(orders.filter((o) => o.statusKey === 'pending_verification'));
        renderPayoutsAwaitingTable();
        renderInstantPayoutsAwaitingTable();
        adminPageRenderedOnce.submissions = true;
    } else if (page === 'listings' && !adminPageRenderedOnce.listings) {
        applyListingsFilters();
        adminPageRenderedOnce.listings = true;
    } else if (page === 'users' && !adminPageRenderedOnce.users) {
        renderUsersTable();
        adminPageRenderedOnce.users = true;
    } else if (page === 'brands' && !adminPageRenderedOnce.brands) {
        renderPricingConfigSettings();
        renderBrandDiscountsTable();
        adminPageRenderedOnce.brands = true;
    } else if (page === 'notifications' && !adminPageRenderedOnce.notifications) {
        renderEmailQueueTable();
        adminPageRenderedOnce.notifications = true;
    } else if (page === 'audit' && !adminPageRenderedOnce.audit) {
        renderAuditLog();
        adminPageRenderedOnce.audit = true;
    } else if (page === 'disputes' && !adminPageRenderedOnce.disputes) {
        renderDisputesTable();
        adminPageRenderedOnce.disputes = true;
    } else if (page === 'verification' && !adminPageRenderedOnce.verification) {
        renderVerificationQueue();
        adminPageRenderedOnce.verification = true;
    }
}

function toggleAdminSidebar() {
    document.getElementById('adminSidebar').classList.toggle('mobile-open');
    document.getElementById('adminSidebarOverlay').classList.toggle('hidden');
}

function closeAdminMobileSidebar() {
    document.getElementById('adminSidebar').classList.remove('mobile-open');
    document.getElementById('adminSidebarOverlay').classList.add('hidden');
}

function toggleAdminSidebarCollapse() {
    document.getElementById('adminSidebar').classList.toggle('collapsed');
}

async function updateAdminNavBadges() {
    if (!AppState.adminData) return;
    const pendingCount = AppState.adminData.submissions.filter((s) => s.statusKey === 'pending_review').length;
    const subBadge = document.getElementById('navBadgeSubmissions');
    subBadge.textContent = pendingCount;
    subBadge.classList.toggle('hidden', pendingCount === 0);

    // Verification and Disputes badges need their own lightweight counts --
    // that data isn't part of the main admin fetch, so without this they'd
    // only become accurate after the admin happened to click into those
    // pages once. Fetched here so the sidebar is honest from the moment
    // the dashboard loads.
    try {
        const [{ count: flaggedCount }, { count: openDisputeCount }] = await Promise.all([
            supabaseClient.from('profiles').select('id', { count: 'exact', head: true }).eq('verification_status', 'flagged'),
            supabaseClient.from('disputes').select('id', { count: 'exact', head: true }).in('status', ['open', 'investigating'])
        ]);

        const verBadge = document.getElementById('navBadgeVerification');
        verBadge.textContent = flaggedCount || 0;
        verBadge.classList.toggle('hidden', !flaggedCount);

        const disputeBadge = document.getElementById('navBadgeDisputes');
        disputeBadge.textContent = openDisputeCount || 0;
        disputeBadge.classList.toggle('hidden', !openDisputeCount);
    } catch (error) {
        console.error('Unable to fetch verification/dispute badge counts:', error);
    }
}

/**
 * Generic pagination: given a full array, the requested page, and a page
 * size, returns just the slice for that page plus the total page count.
 * Every admin table uses this same helper -- client-side pagination, since
 * the current data volume doesn't yet justify server-side paging, but
 * every table is built so switching to a server-paginated query later only
 * touches the fetch, not the rendering or controls.
 */
function paginate(array, page, pageSize = 25) {
    const totalPages = Math.max(1, Math.ceil(array.length / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * pageSize;
    return { items: array.slice(start, start + pageSize), page: safePage, totalPages, totalItems: array.length };
}

function renderPaginationControls(containerId, totalPages, currentPage, onPageChangeFnName) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (totalPages <= 1) {
        el.innerHTML = '';
        return;
    }
    const pages = [];
    for (let i = 1; i <= totalPages; i++) pages.push(i);

    el.innerHTML = `
        <button class="page-btn" ${currentPage <= 1 ? 'disabled' : ''} onclick="${onPageChangeFnName}(${currentPage - 1})">Prev</button>
        ${pages
            .map(
                (p) =>
                    `<button class="page-btn ${p === currentPage ? 'active' : ''}" onclick="${onPageChangeFnName}(${p})">${p}</button>`
            )
            .join('')}
        <button class="page-btn" ${currentPage >= totalPages ? 'disabled' : ''} onclick="${onPageChangeFnName}(${currentPage + 1})">Next</button>
    `;
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
function renderPendingDeliveryTable(pendingDelivery) {
    const pendingDeliveryTable = document.getElementById('pendingDeliveryTable');
    const pendingDeliveryEmpty = document.getElementById('pendingDeliveryEmpty');

    if (pendingDelivery.length === 0) {
        pendingDeliveryTable.innerHTML = '';
        pendingDeliveryEmpty.classList.remove('hidden');
        return;
    }
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

const MARKETPLACE_PAYOUT_HOLD_HOURS = 48;

/**
 * Marketplace payouts awaiting release -- delivered orders where the
 * seller hasn't been paid yet. The Release Payout button is genuinely
 * disabled (not just hidden) until 48 hours have passed since delivered_at,
 * with a live countdown so admin knows exactly when it'll unlock.
 */
async function renderPayoutsAwaitingTable() {
    const table = document.getElementById('payoutsAwaitingTable');
    const empty = document.getElementById('payoutsAwaitingEmpty');
    table.innerHTML = renderSkeletonTableRows(4, 6);

    try {
        const { data: orders, error } = await supabaseClient
            .from('orders')
            .select('*, listings(sale_mode, seller_id, seller_name, seller_payout_amount)')
            .eq('status', 'delivered')
            .eq('seller_paid', false)
            .not('delivered_at', 'is', null);
        if (error) throw error;

        const marketplaceOrders = (orders || []).filter((o) => o.listings?.sale_mode === 'marketplace');

        if (marketplaceOrders.length === 0) {
            table.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');

        table.innerHTML = `
            <table>
                <thead><tr><th>Order ID</th><th>Seller</th><th>Brand</th><th>Payout Amount</th><th>Delivered</th><th>Action</th></tr></thead>
                <tbody>
                    ${marketplaceOrders
                        .map((o) => {
                            const deliveredAt = new Date(o.delivered_at);
                            const unlocksAt = new Date(deliveredAt.getTime() + MARKETPLACE_PAYOUT_HOLD_HOURS * 60 * 60 * 1000);
                            const isUnlocked = Date.now() >= unlocksAt.getTime();
                            const hoursLeft = Math.max(0, Math.ceil((unlocksAt.getTime() - Date.now()) / (60 * 60 * 1000)));
                            return `
                        <tr>
                            <td data-label="Order ID">${escapeHtml(o.public_id)}</td>
                            <td data-label="Seller">${escapeHtml(o.listings?.seller_name || 'Unknown')}</td>
                            <td data-label="Brand">${escapeHtml(o.brand)}</td>
                            <td data-label="Payout Amount">${formatCurrency(o.listings?.seller_payout_amount || 0)}</td>
                            <td data-label="Delivered">${deliveredAt.toLocaleDateString('en-NZ')}</td>
                            <td data-label="Action">
                                ${
                                    isUnlocked
                                        ? `<button class="btn btn-primary btn-sm" onclick="releaseMarketplacePayout('${o.id}')">Release Payout</button>`
                                        : `<button class="btn btn-outline btn-sm" disabled title="Unlocks ${MARKETPLACE_PAYOUT_HOLD_HOURS} hours after delivery">Unlocks in ${hoursLeft}h</button>`
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
        showError(error, 'Unable to load payouts awaiting release.');
    }
}

const INSTANT_SELL_PAYOUT_HOLD_HOURS = 24;

/**
 * Instant Sell payouts awaiting release -- approved submissions where
 * paid_at is still null. Same 24-hour genuine time-gate pattern as the
 * marketplace table above, using approved_at (approval IS the
 * verification step in this flow, there's no separate "verified" state).
 */
async function renderInstantPayoutsAwaitingTable() {
    const table = document.getElementById('instantPayoutsAwaitingTable');
    const empty = document.getElementById('instantPayoutsAwaitingEmpty');
    table.innerHTML = renderSkeletonTableRows(4, 5);

    try {
        const { data: subs, error } = await supabaseClient
            .from('submissions')
            .select('*')
            .eq('status', 'approved')
            .eq('sale_mode', 'instant')
            .is('paid_at', null)
            .not('approved_at', 'is', null);
        if (error) throw error;

        if (!subs || subs.length === 0) {
            table.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');

        table.innerHTML = `
            <table>
                <thead><tr><th>Submission ID</th><th>Seller</th><th>Brand</th><th>Payout Amount</th><th>Approved</th><th>Action</th></tr></thead>
                <tbody>
                    ${subs
                        .map((s) => {
                            const approvedAt = new Date(s.approved_at);
                            const unlocksAt = new Date(approvedAt.getTime() + INSTANT_SELL_PAYOUT_HOLD_HOURS * 60 * 60 * 1000);
                            const isUnlocked = Date.now() >= unlocksAt.getTime();
                            const hoursLeft = Math.max(0, Math.ceil((unlocksAt.getTime() - Date.now()) / (60 * 60 * 1000)));
                            return `
                        <tr>
                            <td data-label="Submission ID">${escapeHtml(s.public_id)}</td>
                            <td data-label="Seller">${escapeHtml(s.seller_name)}</td>
                            <td data-label="Brand">${escapeHtml(s.brand)}</td>
                            <td data-label="Payout Amount">${formatCurrency(s.offer_amount)}</td>
                            <td data-label="Approved">${approvedAt.toLocaleDateString('en-NZ')}</td>
                            <td data-label="Action">
                                ${
                                    isUnlocked
                                        ? `<button class="btn btn-primary btn-sm" onclick="markSubmissionPaid('${s.id}')">Mark as Paid</button>`
                                        : `<button class="btn btn-outline btn-sm" disabled title="Unlocks ${INSTANT_SELL_PAYOUT_HOLD_HOURS} hours after approval">Unlocks in ${hoursLeft}h</button>`
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
        showError(error, 'Unable to load payouts awaiting release.');
    }
}

async function releaseMarketplacePayout(orderDbId) {
    try {
        const { data: order } = await supabaseClient
            .from('orders')
            .select('*, listings(seller_id, seller_name, seller_payout_amount, brand)')
            .eq('id', orderDbId)
            .single();

        if (!order) throw new Error('Order not found.');

        const deliveredAt = new Date(order.delivered_at);
        const unlocksAt = new Date(deliveredAt.getTime() + MARKETPLACE_PAYOUT_HOLD_HOURS * 60 * 60 * 1000);
        if (Date.now() < unlocksAt.getTime()) {
            showToast('warning', 'This payout is still within its 48-hour holding period.');
            return;
        }

        showConfirmModal({
            title: 'Release Payout',
            message: `Confirm ${formatCurrency(order.listings?.seller_payout_amount || 0)} has been paid to ${order.listings?.seller_name || 'this seller'}?`,
            confirmLabel: 'Confirm Released',
            onConfirm: async () => {
                try {
                    await withLoading(async () => {
                        const { error } = await supabaseClient
                            .from('orders')
                            .update({ seller_paid: true, payout_released_at: new Date().toISOString() })
                            .eq('id', orderDbId)
                            .eq('seller_paid', false); // idempotency guard, same pattern as elsewhere
                        if (error) throw error;
                    });

                    await logAdminAction('release_marketplace_payout', 'order', orderDbId, order.listings?.brand, {
                        seller: order.listings?.seller_name,
                        amount: order.listings?.seller_payout_amount
                    });

                    if (order.listings?.seller_id) {
                        await notifySeller(
                            order.listings.seller_id,
                            `Your payout for ${order.listings.brand} has been sent`,
                            `<p>Hi ${escapeHtml(order.listings.seller_name || '')},</p>
                             <p>Your payout of <strong>${formatCurrency(order.listings.seller_payout_amount || 0)}</strong> for your ${escapeHtml(order.listings.brand)} card has been sent.</p>
                             <p>Thanks for selling with Giftlio!</p>`,
                            'marketplace_payout_released',
                            orderDbId
                        );
                    }

                    showToast('success', 'Payout released.');
                    renderAdmin();
                } catch (error) {
                    showError(error, 'Unable to release this payout.');
                }
            }
        });
    } catch (error) {
        showError(error, 'Unable to load this order.');
    }
}

/**
 * Dashboard summary cards -- six metrics, each clickable and navigating to
 * the relevant detailed page. Called on dashboard load and again on a
 * 30-second interval (see startAdminAutoRefresh) while the dashboard page
 * is the one visible.
 */
function renderDashboardCards() {
    if (!AppState.adminData) return;
    const { users, listings, submissions, orders } = AppState.adminData;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const revenueToday = orders.filter((o) => new Date(o.date) >= today).reduce((sum, o) => sum + Number(o.total || 0), 0);

    const pendingCount = submissions.filter((s) => s.statusKey === 'pending_review').length;
    const activeListingsCount = listings.filter((l) => l.status === 'active' && !l.suspended).length;

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const newUsersThisWeek = users.filter((u) => new Date(u.created_at) >= weekAgo).length;

    const brandPercents = Object.values(AppState.brandDiscounts || {}).map((c) => c.discountPercent);
    const avgDiscount = brandPercents.length ? brandPercents.reduce((a, b) => a + b, 0) / brandPercents.length : 0;

    const emailStatuses = AppState.emailQueueRows || [];
    const failedEmails = emailStatuses.filter((e) => e.status === 'failed').length;

    const cards = [
        { label: 'Revenue Today', value: formatCurrency(revenueToday), page: 'listings' },
        { label: 'Pending Submissions', value: pendingCount, page: 'submissions', highlight: pendingCount > 0 },
        { label: 'Active Listings', value: activeListingsCount, page: 'listings' },
        { label: 'New Users This Week', value: newUsersThisWeek, page: 'users' },
        { label: 'Avg. Discount Across Brands', value: `${avgDiscount.toFixed(1)}%`, page: 'brands' },
        { label: 'Email Queue', value: failedEmails > 0 ? `${failedEmails} failed` : 'All sent', page: 'notifications', highlight: failedEmails > 0 }
    ];

    document.getElementById('adminCardsGrid').innerHTML = cards
        .map(
            (c) => `
        <button class="dashboard-card ${c.highlight ? 'dashboard-card-highlight' : ''}" onclick="switchAdminPage('${c.page}')">
            <span class="dashboard-card-label">${c.label}</span>
            <span class="dashboard-card-value">${c.value}</span>
        </button>
    `
        )
        .join('');
}

const PRICE_BANDS = [
    { label: 'Under $25', min: 0, max: 25 },
    { label: '$25-$50', min: 25, max: 50 },
    { label: '$50-$100', min: 50, max: 100 },
    { label: '$100+', min: 100, max: Infinity }
];

/**
 * Real transaction economics -- average sale price, average net per
 * transaction, total net this month, dispute count/cost this month, and
 * net contribution by price band. Orders already carry gross_commission/
 * stripe_fee/net_contribution (computed once, at the Stripe webhook, when
 * the sale completed -- see api/webhook.js) so this is aggregation only,
 * no recomputation. Dispute costs are subtracted here, at the reporting
 * layer, rather than baked into each order's own net_contribution -- a
 * dispute can land well after the sale it's against.
 */
async function renderEconomicsCard() {
    const cardsEl = document.getElementById('economicsSummaryCards');
    const bandTableEl = document.getElementById('economicsPriceBandTable');
    if (!cardsEl || !bandTableEl) return;

    cardsEl.innerHTML = renderSkeletonStatCards(4);
    bandTableEl.innerHTML = '';

    try {
        const orders = AppState.adminData?.orders || [];
        const { data: disputeRows, error: disputeError } = await supabaseClient.from('disputes').select('estimated_cost, created_at');
        if (disputeError) throw disputeError;
        const disputes = disputeRows || [];

        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const isThisMonth = (dateStr) => new Date(dateStr) >= monthStart;

        const ordersThisMonth = orders.filter((o) => isThisMonth(o.date));
        const disputesThisMonth = disputes.filter((d) => isThisMonth(d.created_at));

        const avgSalePrice = orders.length ? orders.reduce((sum, o) => sum + o.salePrice, 0) / orders.length : 0;

        const ordersWithNet = orders.filter((o) => o.netContribution !== null);
        const avgNetPerTransaction = ordersWithNet.length ? ordersWithNet.reduce((sum, o) => sum + o.netContribution, 0) / ordersWithNet.length : 0;

        const grossNetThisMonth = ordersThisMonth.filter((o) => o.netContribution !== null).reduce((sum, o) => sum + o.netContribution, 0);
        const disputeCostThisMonth = disputesThisMonth.reduce((sum, d) => sum + Number(d.estimated_cost || 0), 0);
        const totalNetThisMonth = grossNetThisMonth - disputeCostThisMonth;

        const cards = [
            { label: 'Avg. Sale Price', value: formatCurrency(avgSalePrice) },
            { label: 'Avg. Net per Transaction', value: formatCurrency(avgNetPerTransaction) },
            { label: 'Total Net This Month', value: formatCurrency(totalNetThisMonth) },
            { label: 'Disputes This Month', value: `${disputesThisMonth.length} (${formatCurrency(disputeCostThisMonth)})` }
        ];
        cardsEl.innerHTML = cards
            .map((c) => `<div class="summary-card"><div class="summary-label">${c.label}</div><div class="summary-value">${c.value}</div></div>`)
            .join('');

        const bandRows = PRICE_BANDS.map((band) => {
            const bandOrders = orders.filter((o) => o.salePrice >= band.min && o.salePrice < band.max);
            const bandOrdersWithNet = bandOrders.filter((o) => o.netContribution !== null);
            const totalNet = bandOrdersWithNet.reduce((sum, o) => sum + o.netContribution, 0);
            const avgNet = bandOrdersWithNet.length ? totalNet / bandOrdersWithNet.length : 0;
            return { ...band, count: bandOrders.length, totalNet, avgNet };
        });

        bandTableEl.innerHTML = `
            <table>
                <thead><tr><th>Price Band</th><th>Orders</th><th>Total Net</th><th>Avg. Net</th></tr></thead>
                <tbody>
                    ${bandRows
                        .map(
                            (b) => `
                        <tr>
                            <td data-label="Price Band">${b.label}</td>
                            <td data-label="Orders">${b.count}</td>
                            <td data-label="Total Net">${formatCurrency(b.totalNet)}</td>
                            <td data-label="Avg. Net">${formatCurrency(b.avgNet)}</td>
                        </tr>
                    `
                        )
                        .join('')}
                </tbody>
            </table>
        `;
    } catch (error) {
        console.error('Failed to load economics data:', error);
        cardsEl.innerHTML = '<p>Unable to load economics data.</p>';
    }
}

/**
 * Revenue-over-time chart, built as plain inline HTML/CSS bars -- no chart
 * library, no bundle bloat. Buckets real orders by day across the
 * selected range.
 */
function renderRevenueChart() {
    if (!AppState.adminData) return;
    const range = AppState.revenueRange || 30;
    const { orders } = AppState.adminData;

    const days = [];
    for (let i = range - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        d.setHours(0, 0, 0, 0);
        days.push(d);
    }

    const totals = days.map((day) => {
        const nextDay = new Date(day);
        nextDay.setDate(nextDay.getDate() + 1);
        return orders.filter((o) => new Date(o.date) >= day && new Date(o.date) < nextDay).reduce((sum, o) => sum + Number(o.total || 0), 0);
    });

    const container = document.getElementById('revenueChart');
    const max = Math.max(...totals, 1);

    if (totals.every((t) => t === 0)) {
        container.innerHTML = '<p class="chart-empty">No revenue yet in this range.</p>';
        return;
    }

    const width = 100 / totals.length;
    const bars = totals
        .map((t, i) => {
            const heightPct = (t / max) * 100;
            return `<div class="chart-bar-wrap" style="width:${width}%" title="${days[i].toLocaleDateString('en-NZ')}: ${formatCurrency(t)}"><div class="chart-bar" style="height:${Math.max(heightPct, t > 0 ? 3 : 0)}%"></div></div>`;
        })
        .join('');

    container.innerHTML = `<div class="chart-bars">${bars}</div><div class="chart-axis-labels"><span>${days[0].toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}</span><span>${days[days.length - 1].toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}</span></div>`;
}

function setRevenueRange(range) {
    AppState.revenueRange = range;
    document.querySelectorAll('.chart-range-btn').forEach((btn) => btn.classList.toggle('active', Number(btn.dataset.range) === range));
    renderRevenueChart();
}

/**
 * Submissions-by-status chart -- simple horizontal bars, matching the
 * Giftlio palette exactly (navy/gold/red/gray, no new colors introduced).
 */
function renderStatusChart() {
    if (!AppState.adminData) return;
    const { submissions } = AppState.adminData;

    const counts = {
        Pending: submissions.filter((s) => s.statusKey === 'pending_review').length,
        Approved: submissions.filter((s) => s.statusKey === 'approved').length,
        Rejected: submissions.filter((s) => s.statusKey === 'rejected').length,
        Paid: submissions.filter((s) => s.paidAt).length
    };
    const colorMap = { Pending: 'var(--gold)', Approved: 'var(--navy)', Rejected: 'var(--red)', Paid: 'var(--gray-500)' };
    const max = Math.max(...Object.values(counts), 1);

    document.getElementById('statusChart').innerHTML = Object.entries(counts)
        .map(
            ([label, count]) => `
        <div class="status-bar-row">
            <span class="status-bar-label">${label}</span>
            <div class="status-bar-track"><div class="status-bar-fill" style="width:${(count / max) * 100}%; background:${colorMap[label]};"></div></div>
            <span class="status-bar-count">${count}</span>
        </div>
    `
        )
        .join('');
}

/**
 * Opens a submission's uploaded receipt in a new tab. The bucket is
 * private (not public), so this generates a short-lived signed URL rather
 * than a permanent public link -- the URL expires, the file doesn't
 * become permanently publicly accessible.
 */
async function viewReceipt(storagePath) {
    try {
        const { data, error } = await supabaseClient.storage.from('receipts').createSignedUrl(storagePath, 300);
        if (error) throw error;
        window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
        showError(error, 'Unable to load this receipt.');
    }
}

/**
 * Compact icon row for the admin pending tables, showing at a glance which
 * evidence files a submission actually has -- a filled icon is clickable
 * and opens that file (signed URL); a faded icon means that file is
 * missing. Same underlying viewReceipt() works for both, since receipts
 * and card photos both live in the same private bucket.
 */
function renderEvidenceIcons(s) {
    const receiptIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;
    const photoIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>`;

    const receiptEl = s.receiptStoragePath
        ? `<button class="evidence-icon present" title="View receipt" aria-label="View receipt" onclick="viewReceipt('${escapeJsString(s.receiptStoragePath)}')">${receiptIcon}</button>`
        : `<span class="evidence-icon absent" title="No receipt uploaded">${receiptIcon}</span>`;

    const photoEl = s.cardPhotoStoragePath
        ? `<button class="evidence-icon present" title="View card photo" aria-label="View card photo" onclick="viewReceipt('${escapeJsString(s.cardPhotoStoragePath)}')">${photoIcon}</button>`
        : `<span class="evidence-icon absent" title="No card photo uploaded">${photoIcon}</span>`;

    return `<span class="evidence-icons">${receiptEl}${photoEl}</span>`;
}

/**
 * Shows the most recent balance check recorded for a pending submission,
 * if any -- green when the admin's reading matched what the seller
 * claimed, red when it didn't. No staleness concept here: a submission is
 * being reviewed right now, so any check on file is by definition current.
 * Staleness only matters once a card has been sitting live as a listing
 * (see renderBalanceCheckBadge).
 */
function renderSubmissionBalanceCheckBadge(submissionDbId) {
    const latest = AppState.latestBalanceCheckBySubmission?.get(submissionDbId);
    if (!latest || latest.checked_balance === null) return '';
    const mismatch = Number(latest.checked_balance) !== Number(latest.claimed_balance);
    return mismatch
        ? `<br><span class="badge badge-red" title="Checked ${formatDaysAgo(daysSince(latest.created_at))}">Mismatch: ${formatCurrency(latest.checked_balance)} vs claimed ${formatCurrency(latest.claimed_balance)}</span>`
        : `<br><span class="badge badge-green" title="Checked ${formatDaysAgo(daysSince(latest.created_at))}">Checked: ${formatCurrency(latest.checked_balance)}</span>`;
}

/**
 * Fraud signal: sellers who've submitted 3+ cards in the last 24 hours,
 * computed from the admin's already-loaded submissions data (no extra
 * fetch). Used to show a red "High Volume" badge next to their name in
 * both pending queues, so admin sees it at a glance without needing to
 * cross-reference anything.
 */
/**
 * Rule 5's admin-facing flag: Instant Sell cards issued more than 3 years
 * ago don't get auto-rejected server-side (every submission already goes
 * through manual review regardless -- there's no auto-approval path to
 * bypass), they just get a visible "Old Card" badge so admin knows to
 * look closer.
 */
function isOldCard(issueDate) {
    if (!issueDate) return false;
    const threeYearsAgo = new Date();
    threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
    return new Date(issueDate) < threeYearsAgo;
}

function getHighVolumeSellerIds() {
    const all = AppState.adminData?.submissions || [];
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    const countBySeller = new Map();
    all.forEach((s) => {
        if (new Date(s.createdAt).getTime() < twentyFourHoursAgo) return;
        countBySeller.set(s.sellerId, (countBySeller.get(s.sellerId) || 0) + 1);
    });
    return new Set([...countBySeller.entries()].filter(([, count]) => count >= 3).map(([sellerId]) => sellerId));
}

function renderInstantPendingTable(freshData) {
    if (freshData) AppState.instantPendingRaw = freshData;
    const all = AppState.instantPendingRaw || [];
    const highVolumeSellerIds = getHighVolumeSellerIds();

    const search = (document.getElementById('instantSearchInput')?.value || '').toLowerCase().trim();
    const sort = document.getElementById('instantSortSelect')?.value || 'date_desc';

    let filtered = search
        ? all.filter((s) => s.brand.toLowerCase().includes(search) || s.sellerName.toLowerCase().includes(search) || String(s.faceValue).includes(search) || String(s.currentBalance).includes(search))
        : all.slice();

    const sorters = {
        date_desc: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
        date_asc: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
        amount_desc: (a, b) => b.offerAmount - a.offerAmount,
        amount_asc: (a, b) => a.offerAmount - b.offerAmount
    };
    filtered.sort(sorters[sort]);

    const pendingTable = document.getElementById('pendingTable');
    const pendingEmpty = document.getElementById('pendingEmpty');

    if (filtered.length === 0) {
        pendingTable.innerHTML = '';
        document.getElementById('pendingPagination').innerHTML = '';
        pendingEmpty.classList.remove('hidden');
        return;
    }
    pendingEmpty.classList.add('hidden');

    const { items: pending, page, totalPages } = paginate(filtered, AppState.instantPendingPage || 1);
    AppState.instantPendingPage = page;

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
                        <td data-label="Seller">${escapeHtml(s.sellerName)}${highVolumeSellerIds.has(s.sellerId) ? ' <span class="badge badge-red" title="3 or more submissions in the last 24 hours">High Volume</span>' : ''}${isOldCard(s.issueDate) ? ' <span class="badge badge-yellow" title="Card issued more than 3 years ago -- review carefully">Old Card</span>' : ''}</td>
                        <td data-label="Brand">${escapeHtml(s.brand)}</td>
                        <td data-label="Value">${formatCurrency(s.faceValue)}</td>
                        <td data-label="Balance">${formatCurrency(s.currentBalance)}${renderSubmissionBalanceCheckBadge(s.dbId)}</td>
                        <td data-label="Calculated Offer"><strong>${formatCurrency(s.offerAmount)}</strong></td>
                        <td data-label="Expiry">${s.expiryDate}</td>
                        <td data-label="Date">${new Date(s.createdAt).toLocaleDateString('en-NZ')}</td>
                        <td data-label="Actions">
                            <button class="btn btn-primary btn-sm" onclick="approveSubmissionGuarded(this, '${s.dbId}')">Approve</button>
                            <button class="btn btn-outline btn-sm btn-danger-outline" onclick="rejectSubmission('${s.dbId}')">Reject</button>
                            <button class="btn btn-outline btn-sm" onclick="deleteSubmission('${s.dbId}')">Delete</button>
                            <button class="btn btn-outline btn-sm" onclick="openRecordBalanceCheckModal('${s.dbId}', ${s.currentBalance}, '${escapeJsString(s.brand)}')">Record Balance Check</button>
                            ${renderEvidenceIcons(s)}
                        </td>
                    </tr>
                `
                    )
                    .join('')}
            </tbody>
        </table>
    `;
    renderPaginationControls('pendingPagination', totalPages, page, 'goToInstantPendingPage');
}

function goToInstantPendingPage(page) {
    AppState.instantPendingPage = page;
    renderInstantPendingTable();
}

/** Marketplace queue: shows the seller's own chosen price, admin only needs
    to verify the balance is correct before letting the listing go live. */
function renderMarketplacePendingTable(freshData) {
    if (freshData) AppState.marketplacePendingRaw = freshData;
    const all = AppState.marketplacePendingRaw || [];
    const highVolumeSellerIds = getHighVolumeSellerIds();

    const search = (document.getElementById('marketplaceSearchInput')?.value || '').toLowerCase().trim();
    const sort = document.getElementById('marketplaceSortSelect')?.value || 'date_desc';

    let filtered = search
        ? all.filter((s) => s.brand.toLowerCase().includes(search) || s.sellerName.toLowerCase().includes(search) || String(s.currentBalance).includes(search) || String(s.sellerSetPrice).includes(search))
        : all.slice();

    const sorters = {
        date_desc: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
        date_asc: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
        amount_desc: (a, b) => (b.sellerSetPrice || 0) - (a.sellerSetPrice || 0),
        amount_asc: (a, b) => (a.sellerSetPrice || 0) - (b.sellerSetPrice || 0)
    };
    filtered.sort(sorters[sort]);

    const table = document.getElementById('marketplacePendingTable');
    const empty = document.getElementById('marketplacePendingEmpty');

    if (filtered.length === 0) {
        table.innerHTML = '';
        document.getElementById('marketplacePagination').innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    const { items: pending, page, totalPages } = paginate(filtered, AppState.marketplacePendingPage || 1);
    AppState.marketplacePendingPage = page;

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
                        <td data-label="Seller">${escapeHtml(s.sellerName)}${highVolumeSellerIds.has(s.sellerId) ? ' <span class="badge badge-red" title="3 or more submissions in the last 24 hours">High Volume</span>' : ''}</td>
                        <td data-label="Brand">${escapeHtml(s.brand)}</td>
                        <td data-label="Balance">${formatCurrency(s.currentBalance)}${renderSubmissionBalanceCheckBadge(s.dbId)}</td>
                        <td data-label="Seller's Price"><strong>${s.sellerSetPrice != null ? formatCurrency(s.sellerSetPrice) : '—'}</strong></td>
                        <td data-label="Expiry">${s.expiryDate}</td>
                        <td data-label="Date">${new Date(s.createdAt).toLocaleDateString('en-NZ')}</td>
                        <td data-label="Actions">
                            <button class="btn btn-primary btn-sm" onclick="approveSubmissionGuarded(this, '${s.dbId}')">Verify &amp; List</button>
                            <button class="btn btn-outline btn-sm btn-danger-outline" onclick="rejectSubmission('${s.dbId}')">Reject</button>
                            <button class="btn btn-outline btn-sm" onclick="deleteSubmission('${s.dbId}')">Delete</button>
                            <button class="btn btn-outline btn-sm" onclick="openRecordBalanceCheckModal('${s.dbId}', ${s.currentBalance}, '${escapeJsString(s.brand)}')">Record Balance Check</button>
                            ${renderEvidenceIcons(s)}
                        </td>
                    </tr>
                `
                    )
                    .join('')}
            </tbody>
        </table>
    `;
    renderPaginationControls('marketplacePagination', totalPages, page, 'goToMarketplacePendingPage');
}

function goToMarketplacePendingPage(page) {
    AppState.marketplacePendingPage = page;
    renderMarketplacePendingTable();
}

/**
 * Disputes page -- the schema for this (disputes + dispute_messages) was
 * built earlier but never had a UI. This is that UI: every dispute, its
 * status, and basic resolve/refund actions. Also updates the sidebar
 * badge for open disputes.
 */
/**
 * Seller Verification queue. Shows every account currently flagged for
 * review (auto-flagged at submission time when an unverified seller
 * submits above $200, or manually flagged by an admin from the Users
 * page) with full context: account age, total submissions, and any
 * previous rejections -- everything needed to make a verify/suspend call
 * without switching pages.
 */
async function renderVerificationQueue() {
    const table = document.getElementById('verificationTable');
    const empty = document.getElementById('verificationEmpty');
    table.innerHTML = renderSkeletonTableRows(6, 3);
    empty.classList.add('hidden');

    try {
        const { data: flaggedSellers, error: sellersError } = await supabaseClient
            .from('profiles')
            .select('id, name, email, created_at, verification_status')
            .eq('verification_status', 'flagged')
            .order('created_at', { ascending: false });

        if (sellersError) throw sellersError;

        const badge = document.getElementById('navBadgeVerification');
        badge.textContent = (flaggedSellers || []).length;
        badge.classList.toggle('hidden', (flaggedSellers || []).length === 0);

        if (!flaggedSellers || flaggedSellers.length === 0) {
            table.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }

        const sellerIds = flaggedSellers.map((s) => s.id);
        const { data: allSubs, error: subsError } = await supabaseClient
            .from('submissions')
            .select('seller_id, status, face_value')
            .in('seller_id', sellerIds)
            .is('deleted_at', null);
        if (subsError) throw subsError;

        table.innerHTML = `
            <table>
                <thead><tr><th>Seller</th><th>Account Age</th><th>Total Submissions</th><th>Previous Rejections</th><th>Actions</th></tr></thead>
                <tbody>
                    ${flaggedSellers
                        .map((s) => {
                            const theirSubs = (allSubs || []).filter((sub) => sub.seller_id === s.id);
                            const rejections = theirSubs.filter((sub) => sub.status === 'rejected').length;
                            const ageInDays = Math.floor((Date.now() - new Date(s.created_at).getTime()) / (1000 * 60 * 60 * 24));
                            return `
                        <tr>
                            <td data-label="Seller">${escapeHtml(s.name)}<br><span style="color: var(--gray-500); font-size: 12px;">${escapeHtml(s.email)}</span></td>
                            <td data-label="Account Age">${ageInDays === 0 ? 'Today' : `${ageInDays} day${ageInDays === 1 ? '' : 's'}`}</td>
                            <td data-label="Total Submissions">${theirSubs.length}</td>
                            <td data-label="Previous Rejections">${rejections > 0 ? `<span class="badge badge-red">${rejections}</span>` : '0'}</td>
                            <td data-label="Actions">
                                <button class="btn btn-primary btn-sm" onclick="setSellerVerificationStatus('${s.id}', 'verified', '${escapeJsString(s.name)}')">Verify</button>
                                <button class="btn btn-outline btn-sm" onclick="viewSellerHistory('${s.id}', '${escapeJsString(s.name)}')">Full History</button>
                                <button class="btn btn-outline btn-sm btn-danger-outline" onclick="toggleSellerSuspension('${s.id}', '${escapeJsString(s.name)}', false)">Suspend</button>
                            </td>
                        </tr>
                    `;
                        })
                        .join('')}
                </tbody>
            </table>
        `;
    } catch (error) {
        showError(error, 'Unable to load the seller verification queue.');
    }
}

async function setSellerVerificationStatus(sellerId, newStatus, sellerName) {
    try {
        await withLoading(async () => {
            const { error } = await supabaseClient.from('profiles').update({ verification_status: newStatus }).eq('id', sellerId);
            if (error) throw error;
        });
        await logAdminAction(`seller_${newStatus}`, 'seller', sellerId, null, { sellerName });
        showToast('success', `${sellerName} marked as ${newStatus}.`);
        if (AppState.currentUser && AppState.currentUser.id === sellerId) {
            AppState.currentUser.verificationStatus = newStatus;
        }
        renderVerificationQueue();
        if (adminPageRenderedOnce.users) renderUsersTable();
    } catch (error) {
        showError(error, 'Unable to update verification status.');
    }
}

async function renderDisputesTable() {
    const table = document.getElementById('disputesTable');
    const empty = document.getElementById('disputesEmpty');
    table.innerHTML = renderSkeletonTableRows(5, 3);
    empty.classList.add('hidden');

    try {
        const { data, error } = await supabaseClient.from('disputes').select('*').order('created_at', { ascending: false });
        if (error) throw error;

        const disputes = data || [];
        const openCount = disputes.filter((d) => ['open', 'investigating'].includes(d.status)).length;
        const badge = document.getElementById('navBadgeDisputes');
        badge.textContent = openCount;
        badge.classList.toggle('hidden', openCount === 0);

        if (disputes.length === 0) {
            table.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }

        const badgeMap = { open: 'badge-yellow', investigating: 'badge-blue', resolved: 'badge-green', refunded: 'badge-green', closed: 'badge-gray' };

        table.innerHTML = `
            <table>
                <thead><tr><th>ID</th><th>Message</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
                <tbody>
                    ${disputes
                        .map(
                            (d) => `
                        <tr>
                            <td data-label="ID">${escapeHtml(d.public_id)}</td>
                            <td data-label="Message">${escapeHtml((d.buyer_message || '').slice(0, 80))}${(d.buyer_message || '').length > 80 ? '…' : ''}</td>
                            <td data-label="Status"><span class="badge ${badgeMap[d.status] || 'badge-gray'}">${d.status}</span></td>
                            <td data-label="Date">${new Date(d.created_at).toLocaleDateString('en-NZ')}</td>
                            <td data-label="Actions">
                                ${
                                    ['open', 'investigating'].includes(d.status)
                                        ? `<button class="btn btn-primary btn-sm" onclick="resolveDispute('${d.id}', 'resolved')">Resolve</button>
                                           <button class="btn btn-outline btn-sm" onclick="resolveDispute('${d.id}', 'closed')">Close</button>`
                                        : '<span style="color: var(--gray-400); font-size: 12px;">—</span>'
                                }
                            </td>
                        </tr>
                    `
                        )
                        .join('')}
                </tbody>
            </table>
        `;
    } catch (error) {
        showError(error, 'Unable to load disputes.');
    }
}

async function resolveDispute(disputeId, newStatus) {
    showConfirmModal({
        title: newStatus === 'resolved' ? 'Resolve Dispute' : 'Close Dispute',
        message: `Mark this dispute as ${newStatus}?`,
        confirmLabel: newStatus === 'resolved' ? 'Mark Resolved' : 'Close Dispute',
        onConfirm: async () => {
            try {
                await withLoading(async () => {
                    const { error } = await supabaseClient.from('disputes').update({ status: newStatus, resolved_at: new Date().toISOString() }).eq('id', disputeId);
                    if (error) throw error;
                });
                await logAdminAction(`dispute_${newStatus}`, 'dispute', disputeId, null, {});
                showToast('success', `Dispute marked ${newStatus}.`);
                renderDisputesTable();
            } catch (error) {
                showError(error, 'Unable to update this dispute.');
            }
        }
    });
}

/**
 * Users table -- search by name/email, sort by join date or name,
 * paginated. Uses the users list already cached in AppState.adminData
 * from renderAdmin(), no extra fetch needed.
 */
function renderUsersTable() {
    if (!AppState.adminData) return;
    const all = AppState.adminData.users;

    const search = (document.getElementById('usersSearchInput')?.value || '').toLowerCase().trim();
    const sort = document.getElementById('usersSortSelect')?.value || 'date_desc';

    let filtered = search ? all.filter((u) => u.name.toLowerCase().includes(search) || u.email.toLowerCase().includes(search)) : all.slice();

    const sorters = {
        date_desc: (a, b) => new Date(b.created_at) - new Date(a.created_at),
        date_asc: (a, b) => new Date(a.created_at) - new Date(b.created_at),
        name_asc: (a, b) => a.name.localeCompare(b.name)
    };
    filtered.sort(sorters[sort]);

    const { items: users, page, totalPages } = paginate(filtered, AppState.usersPage || 1);
    AppState.usersPage = page;

    document.getElementById('usersTable').innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Verification</th>
                    <th>Joined</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${users
                    .map(
                        (u) => `
                    <tr>
                        <td data-label="Name">${escapeHtml(u.name)}</td>
                        <td data-label="Email">${escapeHtml(u.email)}</td>
                        <td data-label="Role"><span class="badge ${u.role === 'admin' ? 'badge-red' : u.role === 'seller' ? 'badge-blue' : 'badge-green'}">${u.role}</span></td>
                        <td data-label="Status">${u.suspended ? '<span class="badge badge-red">Suspended</span>' : '<span class="badge badge-green">Active</span>'}</td>
                        <td data-label="Verification">${
                            u.verification_status === 'flagged'
                                ? '<span class="badge badge-yellow">Flagged</span>'
                                : u.verification_status === 'verified'
                                ? '<span class="badge badge-green">Verified</span>'
                                : '<span class="badge badge-gray">Unverified</span>'
                        }</td>
                        <td data-label="Joined">${new Date(u.created_at).toLocaleDateString('en-NZ')}</td>
                        <td data-label="Actions">${
                            u.role === 'admin'
                                ? '<span style="color: var(--gray-400); font-size: 12px;">—</span>'
                                : `<button class="btn btn-sm ${u.suspended ? 'btn-primary' : 'btn-outline btn-danger-outline'}" onclick="toggleSellerSuspension('${u.id}', '${escapeJsString(u.name)}', ${u.suspended})">${u.suspended ? 'Reinstate' : 'Suspend'}</button>
                                   <button class="btn btn-outline btn-sm" onclick="viewSellerHistory('${u.id}', '${escapeJsString(u.name)}')">History</button>
                                   ${u.verification_status !== 'flagged' && u.verification_status !== 'verified' ? `<button class="btn btn-outline btn-sm" onclick="setSellerVerificationStatus('${u.id}', 'flagged', '${escapeJsString(u.name)}')">Flag for Review</button>` : ''}`
                        }</td>
                    </tr>
                `
                    )
                    .join('')}
            </tbody>
        </table>
    `;
    renderPaginationControls('usersPagination', totalPages, page, 'goToUsersPage');
}

function goToUsersPage(page) {
    AppState.usersPage = page;
    renderUsersTable();
}

/**
 * Email Notifications page -- every row from email_queue, filterable by
 * status, with a retry button on individual failed rows plus a
 * retry-all-failed action.
 */
async function renderEmailQueueTable() {
    const table = document.getElementById('emailQueueTable');
    table.innerHTML = renderSkeletonTableRows(5, 6);

    try {
        const { data, error } = await supabaseClient.from('email_queue').select('*').order('created_at', { ascending: false }).limit(500);
        if (error) throw error;

        AppState.emailQueueRows = data || [];
        renderDashboardCards(); // failed-email count on the dashboard card depends on this

        const statusFilter = document.getElementById('emailFilterStatus')?.value || '';
        const filtered = statusFilter ? AppState.emailQueueRows.filter((e) => e.status === statusFilter) : AppState.emailQueueRows;

        if (filtered.length === 0) {
            table.innerHTML = '<p class="section-subtitle" style="padding: 16px 0;">No emails match this filter.</p>';
            document.getElementById('emailQueuePagination').innerHTML = '';
            return;
        }

        const { items: rows, page, totalPages } = paginate(filtered, AppState.emailQueuePage || 1);
        AppState.emailQueuePage = page;

        const badgeMap = { sent: 'badge-green', failed: 'badge-red', pending: 'badge-yellow' };

        table.innerHTML = `
            <table>
                <thead><tr><th>To</th><th>Subject</th><th>Event</th><th>Status</th><th>Attempts</th><th>Date</th><th>Actions</th></tr></thead>
                <tbody>
                    ${rows
                        .map(
                            (e) => `
                        <tr>
                            <td data-label="To">${escapeHtml(e.to_email)}</td>
                            <td data-label="Subject">${escapeHtml(e.subject)}</td>
                            <td data-label="Event">${escapeHtml((e.event_type || '').replace(/_/g, ' '))}</td>
                            <td data-label="Status"><span class="badge ${badgeMap[e.status] || 'badge-gray'}" title="${e.last_error ? escapeHtml(e.last_error) : ''}">${e.status}</span></td>
                            <td data-label="Attempts">${e.attempts}</td>
                            <td data-label="Date">${new Date(e.created_at).toLocaleString('en-NZ')}</td>
                            <td data-label="Actions">${
                                e.status === 'failed' ? `<button class="btn btn-outline btn-sm" onclick="retryOneEmail('${e.id}')">Retry</button>` : '<span style="color: var(--gray-400); font-size: 12px;">—</span>'
                            }</td>
                        </tr>
                    `
                        )
                        .join('')}
                </tbody>
            </table>
        `;
        renderPaginationControls('emailQueuePagination', totalPages, page, 'goToEmailQueuePage');
    } catch (error) {
        showError(error, 'Unable to load email queue.');
    }
}

function goToEmailQueuePage(page) {
    AppState.emailQueuePage = page;
    renderEmailQueueTable();
}

async function retryOneEmail(emailId) {
    try {
        await withLoading(async () => {
            const result = await fetch('/api/retry-failed-emails', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ emailId })
            });
            const data = await result.json();
            if (!result.ok) throw new Error(data.error || 'Retry failed.');
            showToast(
                data.retried > 0 ? 'success' : 'warning',
                data.retried > 0 ? 'Email resent successfully.' : 'Retry attempted, but it failed again -- the underlying issue likely needs fixing (check the error shown on hover).'
            );
        });
        await renderEmailQueueTable();
    } catch (error) {
        showError(error, 'Unable to retry this email.');
    }
}

async function retryAllFailedEmails() {
    try {
        await withLoading(async () => {
            const result = await fetch('/api/retry-failed-emails', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
            const data = await result.json();
            if (!result.ok) throw new Error(data.error || 'Retry failed.');
            showToast('info', `Retried ${data.total} email(s): ${data.retried} sent, ${data.stillFailed} still failed.`);
        });
        await renderEmailQueueTable();
    } catch (error) {
        showError(error, 'Unable to retry failed emails.');
    }
}

/**
 * A listing's freshest balance check might be the one taken at submission
 * review (keyed by submission_id, recorded before the listing even
 * existed) or a later pre/post-delivery one (keyed by listing_id) --
 * whichever is more recent wins.
 */
function getLatestBalanceCheckForListing(listing) {
    const bySubmission = listing.submissionId ? AppState.latestBalanceCheckBySubmission?.get(listing.submissionId) : null;
    const byListing = AppState.latestBalanceCheckByListing?.get(listing.id);
    if (!bySubmission) return byListing || null;
    if (!byListing) return bySubmission;
    return new Date(byListing.created_at) > new Date(bySubmission.created_at) ? byListing : bySubmission;
}

/**
 * The fraud case this exists for: a seller lists a genuine card, then
 * drains it weeks later. A green "checked" tick from a month ago would be
 * actively misleading in that scenario, so a check older than
 * BALANCE_CHECK_STALE_DAYS is shown as stale (red), never as reassuring
 * green, regardless of what it found at the time.
 */
function renderBalanceCheckBadge(listing) {
    const latest = getLatestBalanceCheckForListing(listing);
    const listingAgeDays = daysSince(listing.createdAt);

    if (!latest || latest.checked_balance === null) {
        return listingAgeDays > BALANCE_CHECK_STALE_DAYS
            ? `<span class="badge badge-red" title="No balance check has ever been recorded for this listing">Never checked</span>`
            : `<span class="badge badge-gray" title="Listed ${formatDaysAgo(listingAgeDays)} -- not checked yet">Not yet checked</span>`;
    }

    const ageDays = daysSince(latest.created_at);
    const mismatch = Number(latest.checked_balance) !== Number(latest.claimed_balance);

    if (ageDays > BALANCE_CHECK_STALE_DAYS) {
        return `<span class="badge badge-red" title="A card can be drained after being listed -- a check this old doesn't confirm today's balance">Stale check &middot; ${formatDaysAgo(ageDays)}</span>`;
    }
    if (mismatch) {
        return `<span class="badge badge-red" title="Checked balance did not match the claimed balance">Mismatch &middot; ${formatDaysAgo(ageDays)}</span>`;
    }
    return `<span class="badge badge-green" title="Balance confirmed ${formatDaysAgo(ageDays)}">Checked &middot; ${formatDaysAgo(ageDays)}</span>`;
}

function renderFilteredListingsTable(listings) {
    const container = document.getElementById('allListingsTable');
    if (!container) return;

    if (listings.length === 0) {
        container.innerHTML = '<p class="section-subtitle" style="padding: 16px 0;">No listings match these filters.</p>';
        document.getElementById('listingsPagination').innerHTML = '';
        return;
    }

    AppState.listingsFilteredFull = listings;
    const { items: pageListings, page, totalPages } = paginate(listings, AppState.listingsPage || 1);
    AppState.listingsPage = page;
    listings = pageListings;

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
                    <th>Balance Check</th>
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
                        <td data-label="Balance Check">${renderBalanceCheckBadge(l)}</td>
                        <td data-label="Actions">
                            <button class="btn btn-outline btn-sm" onclick="viewBalanceCheckHistory('${l.id}', '${l.submissionId || ''}', '${escapeJsString(l.brand)}', ${l.faceValue})">Balance Checks</button>
                            ${
                                l.status === 'sold'
                                    ? '<span style="color: var(--gray-400); font-size: 12px;">Sold — locked</span>'
                                    : l.status === 'inactive'
                                      ? '<span style="color: var(--gray-400); font-size: 12px;">Removed</span>'
                                      : `<button class="btn btn-sm ${l.suspended ? 'btn-primary' : 'btn-outline'}" onclick="toggleListingSuspension('${l.id}', '${escapeJsString(l.brand)}', ${l.suspended})">${l.suspended ? 'Unsuspend' : 'Suspend'}</button>
                               <button class="btn btn-outline btn-sm btn-danger-outline" onclick="removeListing('${l.id}', '${escapeJsString(l.brand)}')">Remove</button>`
                            }
                        </td>
                    </tr>
                `;
                    })
                    .join('')}
            </tbody>
        </table>
    `;
    renderPaginationControls('listingsPagination', totalPages, page, 'goToListingsPage');
}

function goToListingsPage(page) {
    AppState.listingsPage = page;
    renderFilteredListingsTable(AppState.listingsFilteredFull || []);
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
                invalidateListingsCache();
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
                invalidateListingsCache();
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
 * Standalone "Record Balance Check" modal, opened from a pending
 * submission's row. Always writes check_type='submission' -- pre/post-
 * delivery checks are recorded from the listing's own history modal
 * instead (viewBalanceCheckHistory below), since only a listing has a
 * "pre/post delivery" to speak of.
 */
function openRecordBalanceCheckModal(submissionDbId, claimedBalance, brand) {
    document.getElementById('balanceCheckModalTitle').textContent = `Record Balance Check — ${brand}`;
    document.getElementById('balanceCheckClaimed').textContent = formatCurrency(claimedBalance);
    document.getElementById('balanceCheckInput').value = '';
    document.getElementById('balanceCheckNotesInput').value = '';
    document.getElementById('balanceCheckError').textContent = '';
    AppState.pendingBalanceCheck = { submissionId: submissionDbId, claimedBalance };
    document.getElementById('balanceCheckOverlay').classList.remove('hidden');
    document.getElementById('balanceCheckModal').classList.remove('hidden');
    document.getElementById('balanceCheckInput').focus();
}

function closeBalanceCheckModal() {
    document.getElementById('balanceCheckOverlay').classList.add('hidden');
    document.getElementById('balanceCheckModal').classList.add('hidden');
    AppState.pendingBalanceCheck = null;
}

async function submitBalanceCheck() {
    const pending = AppState.pendingBalanceCheck;
    if (!pending) return;

    const errEl = document.getElementById('balanceCheckError');
    errEl.textContent = '';
    const raw = document.getElementById('balanceCheckInput').value.trim();
    const checkedBalance = Number(raw);

    if (raw === '' || !Number.isFinite(checkedBalance) || checkedBalance < 0) {
        errEl.textContent = "Enter the balance you actually read off the retailer's page.";
        return;
    }
    const notes = document.getElementById('balanceCheckNotesInput').value.trim();

    try {
        await withLoading(async () => {
            const { error } = await supabaseClient.from('balance_checks').insert({
                submission_id: pending.submissionId,
                check_type: 'submission',
                claimed_balance: pending.claimedBalance,
                checked_balance: checkedBalance,
                notes: notes || null,
                source: 'manual',
                status: 'completed',
                checked_by: AppState.currentUser.id,
                checked_by_name: AppState.currentUser.name
            });
            if (error) throw error;
        });

        const mismatch = checkedBalance !== Number(pending.claimedBalance);
        await logAdminAction('record_balance_check', 'submission', pending.submissionId, null, {
            check_type: 'submission',
            claimed_balance: pending.claimedBalance,
            checked_balance: checkedBalance,
            mismatch
        });
        showToast(
            mismatch ? 'warning' : 'success',
            mismatch ? `Balance mismatch recorded: checked ${formatCurrency(checkedBalance)} vs claimed ${formatCurrency(pending.claimedBalance)}.` : 'Balance check recorded.'
        );

        closeBalanceCheckModal();
        renderAdmin();
    } catch (error) {
        showError(error, 'Unable to save this balance check.');
    }
}

/**
 * Full balance-check history for a listing -- every reading ever taken
 * against it, including the one from submission review (joined via
 * submissionId, since that check predates the listing existing at all).
 * This is the "if a buyer disputes I can see every reading" view. Also
 * has its own embedded form for logging a new pre/post-delivery check,
 * since a listing is the only place those make sense to record from.
 */
async function viewBalanceCheckHistory(listingId, submissionId, brand, faceValue) {
    const overlay = document.getElementById('balanceCheckHistoryOverlay');
    const modal = document.getElementById('balanceCheckHistoryModal');
    const content = document.getElementById('balanceCheckHistoryContent');
    content.innerHTML = `<h2 style="color: var(--navy); margin-bottom: 16px;">${escapeHtml(brand)} — Balance Check History</h2>` + renderSkeletonLines(4);
    overlay.classList.remove('hidden');
    modal.classList.remove('hidden');

    try {
        let query = supabaseClient.from('balance_checks').select('*').order('created_at', { ascending: false });
        query = submissionId ? query.or(`listing_id.eq.${listingId},submission_id.eq.${submissionId}`) : query.eq('listing_id', listingId);
        const { data: checks, error } = await query;
        if (error) throw error;

        const latest = (checks || [])[0] || null;
        const ageDays = latest ? daysSince(latest.created_at) : null;
        const freshnessBadge = !latest
            ? '<span class="badge badge-red">Never checked</span>'
            : ageDays > BALANCE_CHECK_STALE_DAYS
              ? `<span class="badge badge-red">Stale &middot; last checked ${formatDaysAgo(ageDays)}</span>`
              : `<span class="badge badge-green">Last checked ${formatDaysAgo(ageDays)}</span>`;
        const defaultClaimed = latest ? latest.claimed_balance : faceValue;

        content.innerHTML = `
            <h2 style="color: var(--navy); margin-bottom: 4px;">${escapeHtml(brand)} — Balance Check History</h2>
            <p class="section-subtitle" style="margin-bottom: 16px;">${freshnessBadge}</p>

            <div class="table-wrapper" style="margin-bottom: 20px;">
                <table>
                    <thead><tr><th>Type</th><th>Claimed</th><th>Checked</th><th>Age</th><th>By</th><th>Notes</th></tr></thead>
                    <tbody>
                        ${
                            (checks || []).length === 0
                                ? '<tr><td colspan="6">No balance checks recorded yet.</td></tr>'
                                : checks
                                      .map((c) => {
                                          const rowMismatch = c.checked_balance !== null && Number(c.checked_balance) !== Number(c.claimed_balance);
                                          const rowAge = daysSince(c.created_at);
                                          return `
                                <tr class="${rowMismatch ? 'row-warning' : ''}">
                                    <td data-label="Type">${escapeHtml(CHECK_TYPE_LABELS[c.check_type] || c.check_type)}</td>
                                    <td data-label="Claimed">${formatCurrency(c.claimed_balance)}</td>
                                    <td data-label="Checked">${c.checked_balance !== null ? formatCurrency(c.checked_balance) : '—'}${rowMismatch ? ' <span class="badge badge-red">Mismatch</span>' : ''}${c.status === 'failed' ? ' <span class="badge badge-yellow">Failed</span>' : ''}</td>
                                    <td data-label="Age">${formatDaysAgo(rowAge)} <span style="color: var(--gray-500); font-size: 11px;">(${new Date(c.created_at).toLocaleDateString('en-NZ')})</span></td>
                                    <td data-label="By">${escapeHtml(c.checked_by_name || (c.source === 'automated' ? 'Automated' : '—'))}</td>
                                    <td data-label="Notes">${c.notes ? escapeHtml(c.notes) : '—'}</td>
                                </tr>
                            `;
                                      })
                                      .join('')
                        }
                    </tbody>
                </table>
            </div>

            <h3 style="margin-bottom: 8px;">Record a New Check</h3>
            <div style="display: grid; gap: 12px; max-width: 360px;">
                <div class="form-group">
                    <label for="newCheckType">Check type</label>
                    <select id="newCheckType">
                        <option value="pre_delivery">Pre-delivery</option>
                        <option value="post_delivery">Post-delivery</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="newCheckClaimed">Claimed balance</label>
                    <input type="number" id="newCheckClaimed" step="0.01" min="0" value="${defaultClaimed}" />
                </div>
                <div class="form-group">
                    <label for="newCheckBalance">Balance you read off the retailer's page</label>
                    <input type="number" id="newCheckBalance" step="0.01" min="0" />
                    <span class="error-msg" id="newCheckError"></span>
                </div>
                <div class="form-group">
                    <label for="newCheckNotes">Notes (optional)</label>
                    <textarea id="newCheckNotes" rows="2"></textarea>
                </div>
                <button class="btn btn-primary" onclick="submitListingBalanceCheck('${listingId}', '${submissionId || ''}', '${escapeJsString(brand)}', ${faceValue})">Save Check</button>
            </div>
        `;
    } catch (error) {
        content.innerHTML = '<p>Unable to load balance check history.</p>';
        console.error(error);
    }
}

function closeBalanceCheckHistoryModal() {
    document.getElementById('balanceCheckHistoryOverlay').classList.add('hidden');
    document.getElementById('balanceCheckHistoryModal').classList.add('hidden');
}

async function submitListingBalanceCheck(listingId, submissionId, brand, faceValue) {
    const errEl = document.getElementById('newCheckError');
    errEl.textContent = '';

    const checkType = document.getElementById('newCheckType').value;
    const claimedRaw = document.getElementById('newCheckClaimed').value.trim();
    const checkedRaw = document.getElementById('newCheckBalance').value.trim();
    const notes = document.getElementById('newCheckNotes').value.trim();

    const claimedBalance = Number(claimedRaw);
    const checkedBalance = Number(checkedRaw);

    if (claimedRaw === '' || !Number.isFinite(claimedBalance) || claimedBalance < 0) {
        errEl.textContent = 'Enter the claimed balance.';
        return;
    }
    if (checkedRaw === '' || !Number.isFinite(checkedBalance) || checkedBalance < 0) {
        errEl.textContent = "Enter the balance you actually read off the retailer's page.";
        return;
    }

    try {
        await withLoading(async () => {
            const { error } = await supabaseClient.from('balance_checks').insert({
                submission_id: submissionId || null,
                listing_id: listingId,
                check_type: checkType,
                claimed_balance: claimedBalance,
                checked_balance: checkedBalance,
                notes: notes || null,
                source: 'manual',
                status: 'completed',
                checked_by: AppState.currentUser.id,
                checked_by_name: AppState.currentUser.name
            });
            if (error) throw error;
        });

        const mismatch = checkedBalance !== claimedBalance;
        await logAdminAction('record_balance_check', 'listing', listingId, brand, {
            check_type: checkType,
            claimed_balance: claimedBalance,
            checked_balance: checkedBalance,
            mismatch
        });
        showToast(
            mismatch ? 'warning' : 'success',
            mismatch ? `Balance mismatch recorded: checked ${formatCurrency(checkedBalance)} vs claimed ${formatCurrency(claimedBalance)}.` : 'Balance check recorded.'
        );

        await renderAdmin();
        await viewBalanceCheckHistory(listingId, submissionId || null, brand, faceValue);
    } catch (error) {
        showError(error, 'Unable to save this balance check.');
    }
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
/**
 * Opens the card/PIN validation rules editor for a single brand,
 * pre-filled with its current rules. Saving writes directly to
 * brand_discounts, which both the client-side validator and the
 * server-side trigger read from -- so a rule change here takes effect
 * everywhere immediately, no code changes needed.
 */
/**
 * Opens the branding editor for a single brand. The preview updates live
 * as colors change, using the exact same retailerBadgeHTML() function
 * that renders everywhere else in the app -- what admin sees in this
 * modal is genuinely what customers will see, not an approximation.
 */
let currentBrandingEditTarget = null;

function openBrandingModal(brand) {
    currentBrandingEditTarget = brand;
    const config = AppState.brandDiscounts[brand] || {};
    document.getElementById('brandingTitle').textContent = `${brand} — Branding`;
    document.getElementById('bColor').value = config.brandColor || '#10142E';
    document.getElementById('bTextColor').value = config.brandTextColor || '#ffffff';
    document.getElementById('bUseSplit').checked = Boolean(config.brandColorSecondary);
    document.getElementById('bSecondaryColor').value = config.brandColorSecondary || '#FFFFFF';
    toggleSplitColorInput();
    updateBrandingPreview();

    document.getElementById('bSaveBtn').onclick = saveBranding;

    document.getElementById('brandingOverlay').classList.remove('hidden');
    document.getElementById('brandingModal').classList.remove('hidden');
}

function closeBrandingModal() {
    currentBrandingEditTarget = null;
    document.getElementById('brandingOverlay').classList.add('hidden');
    document.getElementById('brandingModal').classList.add('hidden');
}

function toggleSplitColorInput() {
    const useSplit = document.getElementById('bUseSplit').checked;
    document.getElementById('bSecondaryColorGroup').classList.toggle('hidden', !useSplit);
}

/**
 * Renders a live preview using a TEMPORARY override on AppState, then
 * restores the real value immediately after -- this reuses the actual
 * retailerBadgeHTML() function instead of duplicating its rendering
 * logic, so the preview can never drift out of sync with reality.
 */
function updateBrandingPreview() {
    if (!currentBrandingEditTarget) return;
    const useSplit = document.getElementById('bUseSplit').checked;
    const originalConfig = AppState.brandDiscounts[currentBrandingEditTarget];

    AppState.brandDiscounts[currentBrandingEditTarget] = {
        ...originalConfig,
        brandColor: document.getElementById('bColor').value,
        brandTextColor: document.getElementById('bTextColor').value,
        brandColorSecondary: useSplit ? document.getElementById('bSecondaryColor').value : null
    };

    document.getElementById('brandingPreviewWrap').innerHTML = retailerBadgeHTML(currentBrandingEditTarget);

    AppState.brandDiscounts[currentBrandingEditTarget] = originalConfig;
}

async function saveBranding() {
    const brand = currentBrandingEditTarget;
    if (!brand) return;

    const color = document.getElementById('bColor').value;
    const textColor = document.getElementById('bTextColor').value;
    const useSplit = document.getElementById('bUseSplit').checked;
    const secondaryColor = useSplit ? document.getElementById('bSecondaryColor').value : null;

    try {
        await withLoading(async () => {
            const { error } = await supabaseClient
                .from('brand_discounts')
                .update({
                    brand_color: color,
                    brand_text_color: textColor,
                    brand_color_secondary: secondaryColor
                })
                .eq('brand', brand);
            if (error) throw error;
        });

        AppState.brandDiscounts[brand] = {
            ...AppState.brandDiscounts[brand],
            brandColor: color,
            brandTextColor: textColor,
            brandColorSecondary: secondaryColor
        };

        await logAdminAction('update_brand_branding', 'brand', null, brand, { color, textColor, secondaryColor });
        showToast('success', `${brand} branding updated. Applies immediately everywhere.`);
        closeBrandingModal();
        await renderBrandDiscountsTable();
    } catch (error) {
        showError(error, 'Unable to save branding.');
    }
}

function openValidationRulesModal(brand) {
    const rules = AppState.brandDiscounts[brand] || {};
    document.getElementById('validationRulesTitle').textContent = `${brand} — Card/PIN Rules`;
    document.getElementById('vrCardLength').value = rules.cardNumberLength || '';
    document.getElementById('vrCardLengthAlt').value = rules.cardNumberLengthAlt || '';
    document.getElementById('vrCardFormat').value = rules.cardNumberFormat || '';
    document.getElementById('vrPinRequired').value = rules.pinRequired ? 'true' : 'false';
    document.getElementById('vrPinLength').value = rules.pinLength || '';
    document.getElementById('vrConfidence').value = rules.confidenceLevel || 'low';
    document.getElementById('vrSource').value = rules.validationSource || '';
    document.getElementById('vrNotes').value = rules.validationNotes || '';

    document.getElementById('vrSaveBtn').onclick = () => saveValidationRules(brand);

    document.getElementById('validationRulesOverlay').classList.remove('hidden');
    document.getElementById('validationRulesModal').classList.remove('hidden');
}

function closeValidationRulesModal() {
    document.getElementById('validationRulesOverlay').classList.add('hidden');
    document.getElementById('validationRulesModal').classList.add('hidden');
}

async function saveValidationRules(brand) {
    const cardLength = document.getElementById('vrCardLength').value;
    const cardLengthAlt = document.getElementById('vrCardLengthAlt').value;
    const cardFormat = document.getElementById('vrCardFormat').value;
    const pinRequired = document.getElementById('vrPinRequired').value === 'true';
    const pinLength = document.getElementById('vrPinLength').value;
    const confidence = document.getElementById('vrConfidence').value;
    const source = document.getElementById('vrSource').value.trim();
    const notes = document.getElementById('vrNotes').value.trim();

    try {
        await withLoading(async () => {
            const { error } = await supabaseClient
                .from('brand_discounts')
                .update({
                    card_number_length: cardLength ? Number(cardLength) : null,
                    card_number_length_alt: cardLengthAlt ? Number(cardLengthAlt) : null,
                    card_number_format: cardFormat || null,
                    pin_required: pinRequired,
                    pin_length: pinLength ? Number(pinLength) : null,
                    confidence_level: confidence,
                    validation_source: source || null,
                    validation_notes: notes || null
                })
                .eq('brand', brand);
            if (error) throw error;
        });

        await logAdminAction('update_validation_rules', 'brand', null, brand, { confidence, pinRequired, cardLength: cardLength || null });
        showToast('success', `${brand} card/PIN rules updated.`);
        closeValidationRulesModal();
        await renderBrandDiscountsTable();
    } catch (error) {
        showError(error, 'Unable to save validation rules.');
    }
}

/**
 * Platform economics settings: the three pricing_config values, editable
 * from admin. Every change is confirmed before saving and written to the
 * audit log -- these numbers affect every seller and every future sale,
 * not something a stray click should be able to silently alter.
 */
async function renderPricingConfigSettings() {
    const container = document.getElementById('pricingConfigSettings');
    if (!container) return;

    container.innerHTML = renderSkeletonLines(3);

    const config = await loadPricingConfig();
    if (!config) {
        container.innerHTML = '<p>Unable to load pricing configuration.</p>';
        return;
    }

    const commissionPct = Math.round(config.commissionRate * 10000) / 100;

    container.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 16px;">
            <div class="form-group">
                <label for="pcCommissionInput">Marketplace Commission (%)</label>
                <input type="number" id="pcCommissionInput" min="0" max="100" step="0.01" value="${commissionPct}">
                <span class="error-msg" id="pcCommissionError"></span>
            </div>
            <div class="form-group">
                <label for="pcMinBalanceInput">Minimum Card Balance ($)</label>
                <input type="number" id="pcMinBalanceInput" min="0" step="0.01" value="${config.minCardBalance.toFixed(2)}">
                <span class="error-msg" id="pcMinBalanceError"></span>
                <p class="field-hint-text">Applies in addition to the existing 20%-of-face-value rule -- both must pass.</p>
            </div>
            <div class="form-group">
                <label for="pcMinListingInput">Minimum Listing Price ($)</label>
                <input type="number" id="pcMinListingInput" min="0" step="0.01" value="${config.minListingPrice.toFixed(2)}">
                <span class="error-msg" id="pcMinListingError"></span>
            </div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="savePricingConfig()">Save Changes</button>
    `;
}

async function savePricingConfig() {
    const commissionInput = document.getElementById('pcCommissionInput');
    const minBalanceInput = document.getElementById('pcMinBalanceInput');
    const minListingInput = document.getElementById('pcMinListingInput');
    document.getElementById('pcCommissionError').textContent = '';
    document.getElementById('pcMinBalanceError').textContent = '';
    document.getElementById('pcMinListingError').textContent = '';

    const commissionPct = Number(commissionInput.value);
    const minBalance = Number(minBalanceInput.value);
    const minListing = Number(minListingInput.value);

    let hasError = false;
    if (!Number.isFinite(commissionPct) || commissionPct < 0 || commissionPct > 100) {
        document.getElementById('pcCommissionError').textContent = 'Enter a commission percentage between 0 and 100.';
        hasError = true;
    }
    if (!Number.isFinite(minBalance) || minBalance < 0) {
        document.getElementById('pcMinBalanceError').textContent = 'Enter a minimum balance of 0 or more.';
        hasError = true;
    }
    if (!Number.isFinite(minListing) || minListing < 0) {
        document.getElementById('pcMinListingError').textContent = 'Enter a minimum listing price of 0 or more.';
        hasError = true;
    }
    if (hasError) return;

    const commissionRate = Math.round((commissionPct / 100) * 10000) / 10000;
    const previous = AppState.pricingConfig;

    showConfirmModal({
        title: 'Save Pricing Changes',
        message: `Change commission to ${commissionPct}%, minimum card balance to $${minBalance.toFixed(2)}, and minimum listing price to $${minListing.toFixed(2)}? This applies to every submission and sale from now on.`,
        confirmLabel: 'Save Changes',
        onConfirm: async () => {
            try {
                await withLoading(async () => {
                    const { error } = await supabaseClient
                        .from('pricing_config')
                        .update({
                            marketplace_commission_rate: commissionRate,
                            min_card_balance: minBalance,
                            min_listing_price: minListing,
                            updated_at: new Date().toISOString(),
                            updated_by: AppState.currentUser.id
                        })
                        .eq('id', 1);
                    if (error) throw error;
                });

                await logAdminAction('update_pricing_config', 'pricing_config', null, null, {
                    previous: previous
                        ? { commissionRate: previous.commissionRate, minCardBalance: previous.minCardBalance, minListingPrice: previous.minListingPrice }
                        : null,
                    new: { commissionRate, minCardBalance: minBalance, minListingPrice: minListing }
                });

                showToast('success', 'Pricing configuration updated.');
                await renderPricingConfigSettings();
            } catch (error) {
                showError(error, 'Unable to save pricing configuration.');
            }
        }
    });
}

async function renderBrandDiscountsTable() {
    const container = document.getElementById('brandDiscountsTable');
    if (!container) return;

    container.innerHTML = renderSkeletonTableRows(4, 5);

    try {
        const discounts = await loadBrandDiscounts();
        const allBrands = SUPPORTED_BRANDS.slice().sort();

        container.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Brand</th>
                        <th>Preview</th>
                        <th>Current Discount</th>
                        <th>New Discount (0-25%)</th>
                        <th>Giftlio Resale Markup (0-25%)</th>
                        <th>Retailer Enabled</th>
                        <th>Instant Sell Only</th>
                        <th>Validation Confidence</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${allBrands
                        .map((brand) => {
                            const config = discounts[brand];
                            const current = config ? config.discountPercent : null;
                            const currentMarkup = config ? config.resaleMarkupPercent : 0;
                            const isAvailable = config ? config.instantSellAvailable : true;
                            const isEnabled = config ? config.retailerEnabled : true;
                            const inputId = `brandDiscountInput-${brand.replace(/[^a-zA-Z0-9]/g, '')}`;
                            const markupInputId = `brandMarkupInput-${brand.replace(/[^a-zA-Z0-9]/g, '')}`;
                            const checkboxId = `brandAvailable-${brand.replace(/[^a-zA-Z0-9]/g, '')}`;
                            const enabledId = `brandEnabled-${brand.replace(/[^a-zA-Z0-9]/g, '')}`;
                            const errorId = `${inputId}Error`;
                            const confidenceBadge = { high: 'badge-green', medium: 'badge-yellow', low: 'badge-red' }[config?.confidenceLevel || 'low'];
                            return `
                        <tr>
                            <td data-label="Brand"><strong>${escapeHtml(brand)}</strong></td>
                            <td data-label="Preview">${retailerBadgeHTML(brand)}</td>
                            <td data-label="Current Discount">${current === null ? 'Not set' : current + '%'}</td>
                            <td data-label="New Discount">
                                <input type="number" id="${inputId}" min="0" max="25" step="1" value="${current !== null ? current : ''}" placeholder="0-25" style="width: 90px;">
                                <span class="error-msg" id="${errorId}"></span>
                            </td>
                            <td data-label="Giftlio Resale Markup" title="Instant Sell only. The seller is still paid the full discounted rate above -- this is the EXTRA gap between what the seller receives and what the resale listing sells for. Marketplace listings are never affected; sellers there always set their own price.">
                                <input type="number" id="${markupInputId}" min="0" max="25" step="1" value="${currentMarkup}" placeholder="0-25" style="width: 90px;">
                            </td>
                            <td data-label="Retailer Enabled">
                                <label class="checkbox-group" style="margin:0;" title="Whole-retailer kill switch -- blocks both buying and selling this retailer app-wide when off."><input type="checkbox" id="${enabledId}" ${isEnabled ? 'checked' : ''}> Enabled</label>
                            </td>
                            <td data-label="Instant Sell Only">
                                <label class="checkbox-group" style="margin:0;" title="More granular: hides this retailer from Instant Sell submissions specifically, while Marketplace stays open."><input type="checkbox" id="${checkboxId}" ${isAvailable ? 'checked' : ''}> Available</label>
                            </td>
                            <td data-label="Validation Confidence"><span class="badge ${confidenceBadge}">${(config?.confidenceLevel || 'low').toUpperCase()}</span></td>
                            <td data-label="Actions">
                                <button class="btn btn-primary btn-sm" onclick="saveBrandDiscount('${escapeJsString(brand)}', '${inputId}', '${errorId}', '${checkboxId}', '${enabledId}', '${markupInputId}')">Save</button>
                                <button class="btn btn-outline btn-sm" onclick="openValidationRulesModal('${escapeJsString(brand)}')">Edit Card/PIN Rules</button>
                                <button class="btn btn-outline btn-sm" onclick="openBrandingModal('${escapeJsString(brand)}')">Edit Branding</button>
                            </td>
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

async function saveBrandDiscount(brand, inputId, errorId, checkboxId, enabledId, markupInputId) {
    const input = document.getElementById(inputId);
    const errorEl = document.getElementById(errorId);
    const checkbox = document.getElementById(checkboxId);
    const enabledCheckbox = document.getElementById(enabledId);
    const markupInput = markupInputId ? document.getElementById(markupInputId) : null;
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

    let markup = 0;
    if (markupInput) {
        const markupRaw = markupInput.value;
        markup = markupRaw === '' ? 0 : Number(markupRaw);
        if (Number.isNaN(markup) || !Number.isFinite(markup) || markup < 0 || markup > 25) {
            markupInput.classList.add('field-error');
            showToast('warning', 'Giftlio resale markup must be between 0 and 25.');
            return;
        }
        markupInput.classList.remove('field-error');
    }

    const instantSellAvailable = checkbox.checked;
    const retailerEnabled = enabledCheckbox.checked;

    try {
        const { error } = await supabaseClient
            .from('brand_discounts')
            .upsert(
                {
                    brand,
                    discount_percent: num,
                    resale_markup_percent: markup,
                    instant_sell_available: instantSellAvailable,
                    retailer_enabled: retailerEnabled,
                    updated_at: new Date().toISOString()
                },
                { onConflict: 'brand' }
            );

        if (error) throw error;

        // Merge rather than overwrite -- this brand's AppState entry also
        // holds the card/PIN validation rules (format, length, confidence,
        // etc.), which a plain overwrite here would silently wipe out
        // until the next full page reload.
        AppState.brandDiscounts[brand] = {
            ...AppState.brandDiscounts[brand],
            discountPercent: num,
            resaleMarkupPercent: markup,
            instantSellAvailable,
            retailerEnabled
        };
        await logAdminAction('update_brand_discount', 'brand', null, brand, { discountPercent: num, resaleMarkupPercent: markup, instantSellAvailable, retailerEnabled });
        showToast('success', `${brand} updated: ${num}% discount, ${markup}% resale markup, ${instantSellAvailable ? 'available' : 'hidden'} for Instant Sell. Applies immediately.`);
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
    let sub;
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

            sub = submissionRowToView(subData);
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

            await Promise.all([loadBrandDiscounts(), loadPricingConfig()]);
            const brandConfigForApproval = AppState.brandDiscounts[sub.brand];
            if (brandConfigForApproval && !brandConfigForApproval.retailerEnabled) {
                throw new Error(`Cannot approve: ${sub.brand} is currently disabled. Re-enable it in Brand Discounts first, or reject this submission.`);
            }

            if (isMarketplace) {
                salePrice = Number(sub.sellerSetPrice.toFixed(2));
                discount = Math.max(0, Math.min(100, Math.round((1 - salePrice / listingFaceValue) * 100)));
                // Locked in at approval time -- this is the rate THIS
                // listing was actually priced with, stored on the listing
                // itself, so it stays correct even if an admin tunes the
                // global rate later before this specific card sells.
                const payout = GiftlioPricing.calculateMarketplacePayout(salePrice, AppState.pricingConfig?.commissionRate);
                if (payout.error) {
                    throw new Error('Cannot approve: pricing configuration is missing (marketplace commission rate). Set it in Brand Settings first.');
                }
                commissionRate = AppState.pricingConfig.commissionRate * 100;
                sellerPayoutAmount = payout.sellerPayout;
            } else {
                const brandConfig = AppState.brandDiscounts[sub.brand];
                // The seller's payout (sub.offerAmount, already calculated
                // and promised to them at submission time) uses ONLY
                // discount_percent and is never touched here. The LISTING
                // price is a SEPARATE calculation using a smaller effective
                // discount (discount_percent minus resale_markup_percent),
                // so buyers pay closer to face value than what the seller
                // received -- that gap is Giftlio's margin on owned
                // inventory. A markup of 0 (the default) reproduces the
                // old behaviour exactly: listing price == seller payout.
                const rawDiscount = brandConfig ? brandConfig.discountPercent : undefined;
                const markup = brandConfig ? brandConfig.resaleMarkupPercent : 0;
                const effectiveListingDiscount = typeof rawDiscount === 'number' ? Math.max(0, rawDiscount - markup) : rawDiscount;
                const priced = GiftlioPricing.calculateSalePrice(listingFaceValue, effectiveListingDiscount);
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

                if (salePrice < 10 || sub.offerAmount < 10) {
                    throw new Error('Cannot approve: minimum card value is $10 -- this card\'s calculated price falls below that.');
                }
            }

            const { data: sellerProfile, error: sellerProfileError } = await supabaseClient
                .from('profiles')
                .select('created_at')
                .eq('id', sub.sellerId)
                .single();

            if (sellerProfileError) throw sellerProfileError;
            const sellerSince = new Date(sellerProfile.created_at).toISOString().slice(0, 7);

            // submissions.card_number/pin are encrypted at rest -- decrypt
            // here (admin's own session, checked server-side by the
            // decrypt_card_value function) before copying into card_vault,
            // whose own encrypt trigger will re-encrypt them fresh. Without
            // this step, the already-ciphertext value would get encrypted
            // a second time, corrupting it.
            const [{ data: decryptedCardNumber, error: cardNumError }, { data: decryptedPin, error: pinError }] = await Promise.all([
                supabaseClient.rpc('decrypt_card_value', { ciphertext_base64: sub.cardNumber }),
                sub.pin ? supabaseClient.rpc('decrypt_card_value', { ciphertext_base64: sub.pin }) : Promise.resolve({ data: null, error: null })
            ]);
            if (cardNumError) throw cardNumError;
            if (pinError) throw pinError;

            const { data: vaultData, error: vaultError } = await supabaseClient
                .from('card_vault')
                .insert({
                    submission_id: submissionDbId,
                    seller_id: sub.sellerId,
                    brand: sub.brand,
                    card_number: decryptedCardNumber,
                    pin: decryptedPin,
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

        // The early-return above (already-processed case) never assigns
        // sub -- if that path fired, there's nothing further to log or
        // notify about, it already showed its own toast and refreshed.
        if (!sub) return;

        invalidateListingsCache();

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
             <p>Good news — your ${escapeHtml(sub.brand)} gift card (#${escapeHtml(sub.id)}) has been reviewed and approved.</p>
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
    const { data: sub } = await supabaseClient.from('submissions').select('brand, public_id, seller_name, seller_id, offer_amount, approved_at').eq('id', submissionDbId).single();

    if (sub?.approved_at) {
        const unlocksAt = new Date(new Date(sub.approved_at).getTime() + INSTANT_SELL_PAYOUT_HOLD_HOURS * 60 * 60 * 1000);
        if (Date.now() < unlocksAt.getTime()) {
            showToast('warning', 'This payout is still within its 24-hour holding period.');
            return;
        }
    }

    showConfirmModal({
        title: 'Mark as Paid',
        message: `Confirm ${sub ? formatCurrency(sub.offer_amount) : ''} has been paid to ${sub?.seller_name || 'this seller'} for ${sub?.brand || ''} #${sub?.public_id || ''}?`,
        confirmLabel: 'Confirm Paid',
        onConfirm: async () => {
            try {
                await withLoading(async () => {
                    const { error } = await supabaseClient.from('submissions').update({ paid_at: new Date().toISOString() }).eq('id', submissionDbId).is('paid_at', null);
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
    showConfirmModal({
        title: 'Deliver Gift Card',
        message: 'Send the gift card details to the buyer by email now?',
        confirmLabel: 'Send Now',
        onConfirm: async () => {
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
    });
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
                total: listing.salePrice
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
    } else {
        // Leaving admin (or never having been there) -- no reason to keep
        // polling every 30 seconds for a page that isn't visible anymore.
        stopAdminAutoRefresh();
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
    if (page === 'how-it-works') await renderHowItWorksDiscount();

    updateBottomNavActive(page);
    window.scrollTo(0, 0);
}

/**
 * Same honest, live-data pattern as the homepage's brand tiles and hero --
 * only claims a specific discount percentage once there's a real, active
 * listing to back it up. Falls back to the generic (already-true) text
 * set in the HTML if there's nothing live yet.
 */
async function renderHowItWorksDiscount() {
    const line = document.getElementById('howItWorksDiscountLine');
    if (!line) return;
    try {
        const activeListings = await getActiveListings();
        let best = null;
        activeListings.forEach((l) => {
            if (best === null || l.discount > best) best = l.discount;
        });
        if (typeof best === 'number') {
            line.textContent = `Browse discounted gift cards from top NZ retailers, priced by the sellers themselves -- up to ${best}% off right now.`;
        }
    } catch (error) {
        console.error('Unable to load live discount for How It Works page:', error);
    }
}

function openBuyerProtectionModal() {
    document.getElementById('buyerProtectionOverlay').classList.remove('hidden');
    document.getElementById('buyerProtectionModal').classList.remove('hidden');
}

function closeBuyerProtectionModal() {
    document.getElementById('buyerProtectionOverlay').classList.add('hidden');
    document.getElementById('buyerProtectionModal').classList.add('hidden');
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
    let searchDebounceTimer = null;
    document.getElementById('searchInput')?.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            AppState.browsePage = 1; // a new search starts back at page 1
            applyFilters();
        }, 300);
    });
    document.getElementById('discountFilter')?.addEventListener('change', () => {
        AppState.browsePage = 1;
        applyFilters();
    });
    document.getElementById('sortSelect')?.addEventListener('change', () => {
        applyFilters();
    });

    document.getElementById('subReceipt')?.addEventListener('change', function () {
        const file = this.files[0];
        const fileNameEl = document.getElementById('fileName');
        const errorEl = document.getElementById('subReceiptError');
        if (errorEl) errorEl.textContent = '';

        if (!file) {
            fileNameEl.textContent = '';
            updateSubmitButtonState();
            return;
        }

        const maxSizeBytes = 5 * 1024 * 1024;
        const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];

        if (file.size > maxSizeBytes) {
            fileNameEl.textContent = '';
            this.value = '';
            if (errorEl) errorEl.textContent = `File is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 5MB.`;
            updateSubmitButtonState();
            return;
        }
        if (!allowedTypes.includes(file.type)) {
            fileNameEl.textContent = '';
            this.value = '';
            if (errorEl) errorEl.textContent = 'Only JPG, PNG, or PDF files are accepted.';
            updateSubmitButtonState();
            return;
        }

        fileNameEl.textContent = file.name;
        updateSubmitButtonState();
    });

    document.getElementById('subCardPhoto')?.addEventListener('change', function () {
        const file = this.files[0];
        const fileNameEl = document.getElementById('cardPhotoFileName');
        const errorEl = document.getElementById('subCardPhotoError');
        if (errorEl) errorEl.textContent = '';

        if (!file) {
            fileNameEl.textContent = '';
            updateSubmitButtonState();
            return;
        }

        const maxSizeBytes = 5 * 1024 * 1024;
        const allowedTypes = ['image/jpeg', 'image/png'];

        if (file.size > maxSizeBytes) {
            fileNameEl.textContent = '';
            this.value = '';
            if (errorEl) errorEl.textContent = `File is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 5MB.`;
            updateSubmitButtonState();
            return;
        }
        if (!allowedTypes.includes(file.type)) {
            fileNameEl.textContent = '';
            this.value = '';
            if (errorEl) errorEl.textContent = 'Only JPG or PNG files are accepted.';
            updateSubmitButtonState();
            return;
        }

        fileNameEl.textContent = file.name;
        updateSubmitButtonState();
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

    let swRegistration = null;

    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('service-worker.js')
            .then((registration) => {
                swRegistration = registration;
            })
            .catch((error) => {
                console.error('Service worker registration failed:', error);
            });
    });

    // Because the service worker already calls skipWaiting() + clients.claim()
    // (see service-worker.js), a new version takes over automatically in the
    // background the moment it's detected -- no waiting for tabs to close.
    // controllerchange fires exactly at that handover, and ONLY on a real
    // update (it never fires on the very first install, since there's no
    // previous controller to change from). The already-loaded page is still
    // running the OLD app.js/index.html in memory though, so this banner is
    // what tells the person a refresh will get them the new version.
    let hasShownUpdateBanner = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hasShownUpdateBanner) return;
        hasShownUpdateBanner = true;
        showUpdateAvailableBanner();
    });

    // The browser's own update check is tied to navigation and a roughly
    // 24h internal heuristic -- an installed PWA that's only ever resumed
    // from the background (not actually closed and relaunched) may never
    // navigate again, so that check might not run for a long time on its
    // own. Proactively asking the registration to check for a new version
    // whenever the app regains focus covers the common "resumed, not
    // relaunched" case; the hourly timer is a safety net for sessions left
    // open (and foregrounded) even longer than that. update() is a no-op
    // if nothing's changed, so this is cheap either way.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && swRegistration) {
            swRegistration.update().catch(() => {});
        }
    });

    setInterval(() => {
        if (swRegistration) {
            swRegistration.update().catch(() => {});
        }
    }, 60 * 60 * 1000);
}

function showUpdateAvailableBanner() {
    const banner = document.createElement('div');
    banner.className = 'update-available-banner';
    banner.innerHTML = `
        <span>A new version of Giftlio is available.</span>
        <button class="btn btn-primary btn-sm" onclick="forceFreshReload(this)">Refresh</button>
        <button class="update-banner-dismiss" aria-label="Dismiss" onclick="this.closest('.update-available-banner').remove()">×</button>
    `;
    document.body.appendChild(banner);
}

/**
 * Does exactly what the manual "DevTools -> unregister service worker ->
 * clear site data" process does, automatically, in one click: deletes
 * every cache this origin has, unregisters every service worker
 * registration, then hard-reloads. This is the nuclear option -- it
 * doesn't rely on any particular caching strategy being correct, it just
 * removes everything that could possibly be stale before reloading.
 */
async function forceFreshReload(button) {
    if (button) {
        button.disabled = true;
        button.textContent = 'Refreshing...';
    }
    try {
        if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map((key) => caches.delete(key)));
        }
        if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map((reg) => reg.unregister()));
        }
    } catch (error) {
        console.error('Error clearing caches/service worker before reload:', error);
    }
    window.location.reload();
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

function renderBuildMarker() {
    const marker = document.getElementById('buildMarker');
    if (marker) marker.textContent = `Build ${(window.GIFTLIO_BUILD_ID || 'dev').slice(0, 7)}`;
}

async function initializeApp() {
    renderBuildMarker();
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

    // Supabase's email-confirmation link auto-establishes a session directly
    // from URL tokens (detectSessionInUrl: true, see supabase-client.js) --
    // that flow never calls handleSignup() or handleLogin(), so a pending
    // seller-submission redirect has to be checked here too, on first load,
    // or it would only ever fire for a manual login and never for a
    // confirmation-link click. AppState.currentUser is already set by
    // checkAuth() above by this point.
    if (AppState.currentUser && consumeSellerSubmissionRedirect()) {
        await router('seller-dashboard', { historyMode: 'replace' });
        showSellerTab('submit');
        return;
    }

    await initializeRouting();
}

document.addEventListener('DOMContentLoaded', () => {
    initializeApp().catch((error) => {
        showError(error, 'Failed to initialize the application.');
    });
});
