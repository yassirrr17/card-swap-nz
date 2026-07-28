const DEFAULT_CHECKOUT_STEP = 1;
const MAX_CHECKOUT_STEP = 4;
const DEFAULT_LISTING_PRICE_FACTOR = 0.9;
const SELLER_OFFER_RATE = 0.85;

const AppState = {
    currentUser: null,
    currentListing: null,
    checkoutStep: DEFAULT_CHECKOUT_STEP,
    currentOrder: null
};

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
    'how-it-works': 'how-it-works-section'
};

const BRAND_COLORS = {
    'The Warehouse': '#0073e6',
    Countdown: '#e4002b',
    'New World': '#00843d',
    Farmers: '#c8102e',
    'Noel Leeming': '#0033a0',
    Briscoes: '#e31837',
    'Rebel Sport': '#1a1a1a',
    'PB Tech': '#ff6600'
};

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

function getPageFromHash() {
    const page = window.location.hash.replace('#', '');
    return PAGE_SECTION_MAP[page] ? page : 'home';
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
    if (historyMode === 'none') return;

    const nextState = routeState ? { ...routeState, page } : buildRouteState(page);
    const nextUrl = `#${page}`;

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
}

function showError(error, fallback = 'Something went wrong. Please try again.') {
    console.error(error);
    alert(error?.message || fallback);
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
        cardVaultId: row.card_vault_id
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
        if (getPageFromHash() !== 'home') router('home', { historyMode: 'replace' });
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
        document.getElementById('signupNameError').textContent = 'Name must be at least 2 characters';
        hasError = true;
    }

    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
        document.getElementById('signupEmailError').textContent = 'Please enter a valid email';
        hasError = true;
    }

    if (password.length < 8) {
        document.getElementById('signupPasswordError').textContent = 'Password must be at least 8 characters';
        hasError = true;
    }

    if (password !== confirm) {
        document.getElementById('signupConfirmError').textContent = 'Passwords do not match';
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
                alert('Account created successfully!');
                router('home');
                return;
            }

            alert('Account created. Please verify your email and then sign in.');
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

    try {
        await withLoading(async () => {
            const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) throw error;

            AppState.currentUser = await fetchProfile(data.user.id);
            updateNavForUser();
            router('home');
        });
    } catch (error) {
        document.getElementById('loginPasswordError').textContent = 'Invalid email or password';
    }
}

async function handleForgot() {
    const email = document.getElementById('forgotEmail').value.trim();

    try {
        await withLoading(async () => {
            const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
                redirectTo: `${window.location.origin}${window.location.pathname}`
            });

            if (error) throw error;
        });

        alert(`If this email exists in our system, a reset link has been sent to ${email}`);
        router('login');
    } catch (error) {
        showError(error, 'Unable to request a reset link.');
    }
}

async function handleResetPassword() {
    document.getElementById('resetPasswordError').textContent = '';
    document.getElementById('resetPasswordConfirmError').textContent = '';

    const password = document.getElementById('resetPassword').value;
    const confirm = document.getElementById('resetPasswordConfirm').value;

    let hasError = false;

    if (password.length < 8) {
        document.getElementById('resetPasswordError').textContent = 'Password must be at least 8 characters';
        hasError = true;
    }

    if (password !== confirm) {
        document.getElementById('resetPasswordConfirmError').textContent = 'Passwords do not match';
        hasError = true;
    }

    if (hasError) return;

    try {
        await withLoading(async () => {
            const { error } = await supabaseClient.auth.updateUser({ password });
            if (error) throw error;
        });

        alert('Your password has been updated. Please log in with your new password.');

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
    return (data || []).map(listingRowToView);
}

function renderListingCard(listing) {
    const safeBrand = escapeHtml(listing.brand);
    const safeSeller = escapeHtml(listing.seller || 'Verified Seller');

    return `
        <div class="listing-card" onclick="viewListing('${listing.id}')">
            <div class="listing-card-header" style="border-left: 4px solid ${BRAND_COLORS[listing.brand] || '#1a237e'}">
                <h3>${safeBrand}</h3>
            </div>
            <div class="listing-card-body">
                <div class="listing-value">${formatCurrency(listing.faceValue)}</div>
                <div class="listing-price">${formatCurrency(listing.salePrice)}</div>
                <span class="discount-badge">Save ${listing.discount}%</span>
                <div class="listing-seller">Sold by: ${safeSeller}</div>
                <button class="btn btn-primary" onclick="event.stopPropagation(); viewListing('${listing.id}')">Buy Now</button>
            </div>
        </div>
    `;
}

async function renderHome() {
    const brands = ['The Warehouse', 'Countdown', 'New World', 'Farmers', 'Noel Leeming', 'Briscoes', 'Rebel Sport', 'PB Tech'];
    const brandsGrid = document.getElementById('brandsGrid');
    brandsGrid.innerHTML = brands
        .map(
            (b) => `
        <div class="brand-card" onclick="filterByBrand('${b}')" style="border-top: 4px solid ${BRAND_COLORS[b] || '#1a237e'}">
            <h3>${b}</h3>
            <p>Up to 20% off</p>
        </div>
    `
        )
        .join('');

    try {
        await withLoading(async () => {
            const listings = (await getActiveListings()).slice(0, 4);
            document.getElementById('featuredGrid').innerHTML = listings.map((l) => renderListingCard(l)).join('');
        });
    } catch (error) {
        document.getElementById('featuredGrid').innerHTML = '<p style="color: var(--gray-500);">Unable to load featured listings.</p>';
        showError(error, 'Unable to load featured listings.');
    }
}

async function renderBrowse() {
    await applyFilters();
}

async function applyFilters() {
    try {
        await withLoading(async () => {
            let listings = await getActiveListings();
            const search = document.getElementById('searchInput').value.toLowerCase();
            const discountFilter = document.getElementById('discountFilter').value;
            const sort = document.getElementById('sortSelect').value;

            if (search) {
                listings = listings.filter((l) => l.brand.toLowerCase().includes(search));
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

            const grid = document.getElementById('browseGrid');
            const empty = document.getElementById('browseEmpty');

            if (listings.length === 0) {
                grid.innerHTML = '';
                empty.classList.remove('hidden');
            } else {
                empty.classList.add('hidden');
                grid.innerHTML = listings.map((l) => renderListingCard(l)).join('');
            }
        });
    } catch (error) {
        showError(error, 'Unable to load listings.');
    }
}

function clearFilters() {
    document.getElementById('searchInput').value = '';
    document.getElementById('discountFilter').value = '';
    document.getElementById('sortSelect').value = 'newest';
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
                    <div class="detail-brand">${safeBrand}</div>
                    <div class="detail-value">${formatCurrency(listing.faceValue)}</div>
                    <div class="detail-price">${formatCurrency(listing.salePrice)}</div>
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
                        <p>⭐⭐⭐⭐⭐ 4.5 stars</p>
                    </div>
                    <div class="detail-section">
                        <h3>Description</h3>
                        <p>This is a genuine ${safeBrand} gift card with a verified balance. Card details will be delivered via email within 24 hours of purchase after manual verification.</p>
                    </div>
                    <div class="detail-section">
                        <h3>Trust & Safety</h3>
                        <p>✓ Manual balance verification included<br>
                        ✓ Secure payment via Stripe<br>
                        ✓ Email delivery within 24 hours</p>
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
        serviceFee: AppState.currentListing.salePrice * 0.05,
        total: AppState.currentListing.salePrice * 1.05
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
    `;
}

function goToCheckoutStep(step) {
    if (step === 3) {
        const name = document.getElementById('buyerName').value.trim();
        const email = document.getElementById('buyerEmail').value.trim();
        const phone = document.getElementById('buyerPhone').value.trim();

        if (!name || !email || !phone) return;

        AppState.currentOrder.buyerName = name;
        AppState.currentOrder.buyerEmail = email;
        AppState.currentOrder.buyerPhone = phone;
    }

    AppState.checkoutStep = normalizeCheckoutStep(step);
    updateCheckoutSteps();
    syncHistory('checkout', 'push');
}

async function placeOrder() {
    if (!document.getElementById('termsCheck').checked) {
        alert('Please agree to the Terms and Conditions');
        return;
    }

    if (!AppState.currentOrder?.listing || !AppState.currentUser) return;

    const orderId = generatePublicId('CS');
    const listing = AppState.currentOrder.listing;

    try {
        await withLoading(async () => {
            const payload = {
                public_id: orderId,
                listing_id: listing.id,
                buyer_id: AppState.currentUser.id,
                buyer_name: AppState.currentOrder.buyerName,
                buyer_email: AppState.currentOrder.buyerEmail,
                buyer_phone: AppState.currentOrder.buyerPhone,
                brand: listing.brand,
                face_value: listing.faceValue,
                sale_price: listing.salePrice,
                service_fee: AppState.currentOrder.serviceFee,
                total: AppState.currentOrder.total,
                status: 'pending_verification'
            };

            const { error: orderError } = await supabaseClient.from('orders').insert(payload);
            if (orderError) throw orderError;

            const { error: listingError } = await supabaseClient
                .from('listings')
                .update({ status: 'sold', sold_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                .eq('id', listing.id);

            if (listingError) throw listingError;
        });

        document.getElementById('confirmOrderId').textContent = `Order ID: ${orderId}`;
        document.getElementById('confirmSummary').innerHTML = `
            <div class="summary-row">
                <span>${listing.brand}</span>
                <span>${formatCurrency(listing.faceValue)} value</span>
            </div>
            <div class="summary-row total">
                <span>Total Paid</span>
                <span>${formatCurrency(AppState.currentOrder.total)}</span>
            </div>
        `;

        AppState.checkoutStep = MAX_CHECKOUT_STEP;
        updateCheckoutSteps();
        syncHistory('checkout', 'push');
    } catch (error) {
        showError(error, 'Unable to place your order.');
    }
}

async function renderOrders() {
    if (!AppState.currentUser) {
        router('login');
        return;
    }

    try {
        await withLoading(async () => {
            const { data, error } = await supabaseClient
                .from('orders')
                .select('*')
                .eq('buyer_id', AppState.currentUser.id)
                .order('created_at', { ascending: false });

            if (error) throw error;

            const orders = (data || []).map(orderRowToView);
            const table = document.getElementById('ordersTable');
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
                                <td>${o.id}</td>
                                <td>${o.brand}</td>
                                <td>${formatCurrency(o.faceValue)}</td>
                                <td>${formatCurrency(o.total)}</td>
                                <td>${new Date(o.date).toLocaleDateString('en-NZ')}</td>
                                <td><span class="badge ${badgeClass[o.status] || 'badge-gray'}">${o.status}</span></td>
                                <td><button class="btn btn-outline" style="padding: 6px 12px; font-size: 12px;" onclick="viewOrderDetail('${o.dbId}')">View</button></td>
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
                    <p><strong>Price Paid:</strong> ${formatCurrency(order.total)} (includes ${formatCurrency(order.serviceFee)} fee)</p>
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

            const totalSubmitted = submissions.length;
            const cardsSold = listings.filter((l) => l.status === 'sold').length;
            const totalEarnings = submissions
                .filter((s) => ['Listed', 'Sold', 'Approved'].includes(s.status))
                .reduce((sum, s) => sum + (s.offerAmount || 0), 0);
            const pendingPayout = submissions
                .filter((s) => ['Listed', 'Approved'].includes(s.status))
                .reduce((sum, s) => sum + (s.offerAmount || 0), 0);

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
        showError(error, 'Unable to load seller dashboard.');
    }
}

function updateOffer() {
    const value = parseFloat(document.getElementById('subValue').value) || 0;
    const offer = value * SELLER_OFFER_RATE;
    document.getElementById('offerAmount').textContent = formatCurrency(offer);
}

async function handleSubmission() {
    if (!AppState.currentUser) {
        router('login');
        return;
    }

    const brand = document.getElementById('subBrand').value;
    const value = parseFloat(document.getElementById('subValue').value);
    const balance = parseFloat(document.getElementById('subBalance').value);
    const expiry = document.getElementById('subExpiry').value;
    const cardNum = document.getElementById('subCardNum').value;
    const pin = document.getElementById('subPin').value;
    const terms = document.getElementById('subTerms').checked;

    if (!brand || !value || !balance || !expiry || !cardNum || !terms) {
        alert('Please fill in all required fields');
        return;
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
                offer_amount: value * SELLER_OFFER_RATE,
                status: 'pending_review'
            });

            if (error) throw error;
        });

        alert(`Your gift card has been submitted for manual verification. Submission ID: ${submissionPublicId}`);
        document.getElementById('submissionForm').reset();
        document.getElementById('fileName').textContent = '';
        document.getElementById('offerAmount').textContent = '$0.00';
        showSellerTab('submissions');
    } catch (error) {
        showError(error, 'Unable to submit your gift card.');
    }
}

async function renderSellerSubmissions() {
    if (!AppState.currentUser) return;

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

            const badgeMap = {
                'Pending Review': 'badge-yellow',
                Approved: 'badge-green',
                Rejected: 'badge-red',
                Listed: 'badge-blue',
                Sold: 'badge-green'
            };

            table.innerHTML = `
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Brand</th>
                            <th>Value</th>
                            <th>Your Offer</th>
                            <th>Status</th>
                            <th>Date</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${submissions
                            .map(
                                (s) => `
                            <tr>
                                <td>${s.id}</td>
                                <td>${s.brand}</td>
                                <td>${formatCurrency(s.faceValue)}</td>
                                <td>${formatCurrency(s.offerAmount)}</td>
                                <td><span class="badge ${badgeMap[s.status] || 'badge-gray'}">${s.status}</span></td>
                                <td>${new Date(s.createdAt).toLocaleDateString('en-NZ')}</td>
                            </tr>
                        `
                            )
                            .join('')}
                    </tbody>
                </table>
            `;
        });
    } catch (error) {
        showError(error, 'Unable to load submissions.');
    }
}

async function renderSellerEarnings() {
    if (!AppState.currentUser) return;

    try {
        await withLoading(async () => {
            const { data, error } = await supabaseClient.from('submissions').select('*').eq('seller_id', AppState.currentUser.id);
            if (error) throw error;

            const submissions = (data || []).map(submissionRowToView);
            const total = submissions
                .filter((s) => ['Listed', 'Sold', 'Approved'].includes(s.status))
                .reduce((sum, s) => sum + (s.offerAmount || 0), 0);

            document.getElementById('earnTotal').textContent = formatCurrency(total);
            document.getElementById('earnAvailable').textContent = formatCurrency(total);
            document.getElementById('earnPaid').textContent = '$0.00';
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

    try {
        await withLoading(async () => {
            const [usersRes, listingsRes, submissionsRes, ordersRes] = await Promise.all([
                supabaseClient.from('profiles').select('id'),
                supabaseClient.from('listings').select('*'),
                supabaseClient.from('submissions').select('*'),
                supabaseClient.from('orders').select('total')
            ]);

            if (usersRes.error) throw usersRes.error;
            if (listingsRes.error) throw listingsRes.error;
            if (submissionsRes.error) throw submissionsRes.error;
            if (ordersRes.error) throw ordersRes.error;

            const users = usersRes.data || [];
            const listings = (listingsRes.data || []).map(listingRowToView);
            const submissions = (submissionsRes.data || []).map(submissionRowToView);
            const orders = ordersRes.data || [];

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
                                    <td>${s.id}</td>
                                    <td>${s.sellerName}</td>
                                    <td>${s.brand}</td>
                                    <td>${formatCurrency(s.faceValue)}</td>
                                    <td>${formatCurrency(s.currentBalance)}</td>
                                    <td>${s.expiryDate}</td>
                                    <td>${new Date(s.createdAt).toLocaleDateString('en-NZ')}</td>
                                    <td>
                                        <button class="btn btn-primary" style="padding: 6px 12px; font-size: 12px;" onclick="approveSubmission('${s.dbId}')">Approve</button>
                                        <button class="btn btn-outline" style="padding: 6px 12px; font-size: 12px; margin-left: 4px; color: var(--red); border-color: var(--red);" onclick="rejectSubmission('${s.dbId}')">Reject</button>
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
                                (l) => `
                            <tr>
                                <td>${l.id.slice(0, 8)}</td>
                                <td>${l.brand}</td>
                                <td>${formatCurrency(l.faceValue)}</td>
                                <td>${formatCurrency(l.salePrice)}</td>
                                <td>${l.discount}%</td>
                                <td>${l.seller}</td>
                                <td><span class="badge ${l.status === 'active' ? 'badge-green' : l.status === 'sold' ? 'badge-blue' : 'badge-gray'}">${l.status}</span></td>
                            </tr>
                        `
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
                                <td>${u.name}</td>
                                <td>${u.email}</td>
                                <td><span class="badge ${u.role === 'admin' ? 'badge-red' : u.role === 'seller' ? 'badge-blue' : 'badge-green'}">${u.role}</span></td>
                                <td>${new Date(u.created_at).toLocaleDateString('en-NZ')}</td>
                            </tr>
                        `
                            )
                            .join('')}
                    </tbody>
                </table>
            `;
        });
    } catch (error) {
        showError(error, 'Unable to load admin dashboard.');
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
            const salePrice = Number((listingFaceValue * DEFAULT_LISTING_PRICE_FACTOR).toFixed(2));
            const discount = Math.max(0, Math.min(100, Math.round((1 - salePrice / listingFaceValue) * 100)));

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
                expiry_date: sub.expiryDate
            });

            if (listingError) throw listingError;

            const { error: updateError } = await supabaseClient
                .from('submissions')
                .update({ status: 'approved', approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                .eq('id', submissionDbId);

            if (updateError) throw updateError;
        });

        alert('Submission approved and listed on marketplace!');
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

        alert(`Submission rejected. Reason: ${reason}`);
        renderAdmin();
    } catch (error) {
        showError(error, 'Unable to reject submission.');
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
    const page = Object.hasOwn(PAGE_SECTION_MAP, routeState.page) ? routeState.page : getPageFromHash();

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
                serviceFee: listing.salePrice * 0.05,
                total: listing.salePrice * 1.05
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

    await restoreRoute({ page: getPageFromHash() }, 'replace');
}

async function router(page, options = {}) {
    const { historyMode = 'push', routeState = null } = options;

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
    if (page === 'orders') await renderOrders();
    if (page === 'seller-dashboard') await renderSellerDashboard();
    if (page === 'admin') await renderAdmin();

    window.scrollTo(0, 0);
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
        await restoreRoute(e.state || { page: getPageFromHash() }, 'none');
    });

    supabaseClient.auth.onAuthStateChange((event, session) => {
        handleAuthStateChange(event, session);
    });
}

/* ===== PWA: service worker, install prompt, offline detection =====
 * All additive -- none of this touches existing auth/listing/order/
 * dashboard logic above. */

let deferredInstallPrompt = null;

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').catch((error) => {
            console.error('Service worker registration failed:', error);
        });
    });
}

function setupPWAInstall() {
    const installBtn = document.getElementById('installBtn');
    if (!installBtn) return;

    window.addEventListener('beforeinstallprompt', (event) => {
        // Prevent the default mini-infobar and show our own branded button instead.
        event.preventDefault();
        deferredInstallPrompt = event;
        installBtn.classList.remove('hidden');
    });

    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        installBtn.classList.add('hidden');
    });
}

async function promptInstall() {
    const installBtn = document.getElementById('installBtn');
    if (!deferredInstallPrompt) return;

    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn?.classList.add('hidden');
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
    await initializeRouting();
}

document.addEventListener('DOMContentLoaded', () => {
    initializeApp().catch((error) => {
        showError(error, 'Failed to initialize the application.');
    });
});
