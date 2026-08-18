/**
 * Single source of truth for every transactional/admin-alert email the app
 * sends via /api/notify-seller.js and /api/send-notification.js.
 *
 * Both endpoints accept only { eventType, entityId } from the client. Every
 * recipient address, every piece of content, and every authorization
 * decision here comes from a fresh DB read keyed by entityId -- never from
 * anything the client claims in the request body. This is what makes it
 * safe to let an ordinary logged-in user trigger these at all: they can
 * only ever cause an email whose content is a fixed template filled from
 * data the DB already has, addressed to a recipient the DB says is real,
 * and only for an entity the DB says they're actually a party to.
 */

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function money(n) {
    return `$${Number(n || 0).toFixed(2)}`;
}

function adminOrigin(req) {
    return `https://${req.headers.host}/admin`;
}

async function fetchSubmissionContext(supabaseAdmin, id) {
    const { data: submission, error } = await supabaseAdmin.from('submissions').select('*').eq('id', id).single();
    if (error || !submission) return null;
    const { data: seller } = await supabaseAdmin.from('profiles').select('email, name, notification_preference').eq('id', submission.seller_id).single();
    return { ...submission, seller_email: seller?.email || null, seller_notification_preference: seller?.notification_preference || null };
}

async function fetchOfferContext(supabaseAdmin, id) {
    const { data: offer, error } = await supabaseAdmin.from('listing_offers').select('*').eq('id', id).single();
    if (error || !offer) return null;
    const [{ data: buyer }, { data: seller }] = await Promise.all([
        supabaseAdmin.from('profiles').select('email, name, notification_preference').eq('id', offer.buyer_id).single(),
        supabaseAdmin.from('profiles').select('email, name, notification_preference').eq('id', offer.seller_id).single()
    ]);
    return {
        ...offer,
        buyer_email: buyer?.email || null,
        buyer_name: buyer?.name || '',
        buyer_notification_preference: buyer?.notification_preference || null,
        seller_email: seller?.email || null,
        seller_name: seller?.name || '',
        seller_notification_preference: seller?.notification_preference || null
    };
}

async function fetchMarketplaceOrderContext(supabaseAdmin, id) {
    const { data: order, error } = await supabaseAdmin.from('orders').select('*, listings(seller_id, seller_name, brand, seller_payout_amount)').eq('id', id).single();
    if (error || !order || !order.listings) return null;
    const { data: seller } = await supabaseAdmin.from('profiles').select('email, notification_preference').eq('id', order.listings.seller_id).single();
    return {
        ...order,
        seller_id: order.listings.seller_id,
        seller_name: order.listings.seller_name,
        brand: order.listings.brand,
        seller_payout_amount: order.listings.seller_payout_amount,
        seller_email: seller?.email || null,
        seller_notification_preference: seller?.notification_preference || null
    };
}

/**
 * Each entry may define a "seller" half (used by notify-seller.js, whose
 * recipient is looked up from the entity, never the fixed admin inbox) and
 * an "admin" half (used by send-notification.js, always sent to the fixed
 * admin inbox). An event only needs the halves it actually uses.
 */
const EVENTS = {
    submission_received: {
        fetch: fetchSubmissionContext,
        seller: {
            authorize: (ctx, callerId, isAdmin) => isAdmin || ctx.seller_id === callerId,
            recipientEmail: (ctx) => ctx.seller_email,
            recipientPreference: (ctx) => ctx.seller_notification_preference,
            subject: (ctx) => `We've received your ${ctx.brand} card submission`,
            body: (ctx) => `<p>Hi ${escapeHtml(ctx.seller_name)},</p>
                 <p>We've received your ${escapeHtml(ctx.brand)} gift card submission (#${escapeHtml(ctx.public_id)}) and it's now being reviewed. We'll email you as soon as it's been looked at.</p>`
        },
        admin: {
            authorize: (ctx, callerId, isAdmin) => isAdmin || ctx.seller_id === callerId,
            subject: (ctx) => `New Submission for Review: ${ctx.brand} #${ctx.public_id}`,
            body: (ctx, req) => `<p><strong>Retailer:</strong> ${escapeHtml(ctx.brand)}</p>
                 <p><strong>Original Value:</strong> ${money(ctx.face_value)}</p>
                 <p><strong>Current Balance:</strong> ${money(ctx.current_balance)}</p>
                 <p><strong>Expiry:</strong> ${escapeHtml(ctx.expiry_date)}</p>
                 <p><strong>Sale Mode:</strong> ${escapeHtml(ctx.sale_mode)}${ctx.sale_mode === 'marketplace' ? ` (seller asking price: ${money(ctx.seller_set_price)})` : ''}</p>
                 <p><strong>Calculated Offer:</strong> ${money(ctx.offer_amount)}</p>
                 <p><strong>Seller:</strong> ${escapeHtml(ctx.seller_name)} (${escapeHtml(ctx.seller_email)})</p>
                 <p><a href="${adminOrigin(req)}">Review this submission in the admin panel</a></p>`
        }
    },

    seller_flagged_for_verification: {
        fetch: fetchSubmissionContext,
        admin: {
            authorize: (ctx, callerId, isAdmin) => isAdmin || ctx.seller_id === callerId,
            subject: (ctx) => `Seller flagged for verification: ${ctx.seller_name}`,
            body: (ctx, req) => `<p>${escapeHtml(ctx.seller_name)} (${escapeHtml(ctx.seller_email)}) submitted a ${escapeHtml(ctx.brand)} card worth ${money(ctx.face_value)} -- above the auto-review threshold, and this account was still unverified.</p>
                 <p><a href="${adminOrigin(req)}">Review in the Seller Verification queue</a></p>`
        }
    },

    submission_approved: {
        fetch: fetchSubmissionContext,
        seller: {
            authorize: (ctx, callerId, isAdmin) => isAdmin,
            recipientEmail: (ctx) => ctx.seller_email,
            recipientPreference: (ctx) => ctx.seller_notification_preference,
            subject: (ctx) => `Your ${ctx.brand} card submission was approved!`,
            body: (ctx) => `<p>Hi ${escapeHtml(ctx.seller_name)},</p>
                 <p>Good news — your ${escapeHtml(ctx.brand)} gift card (#${escapeHtml(ctx.public_id)}) has been reviewed and approved.</p>
                 ${
                     ctx.sale_mode === 'marketplace'
                         ? `<p>It's now live on the Giftlio marketplace at your asking price. You'll be paid <strong>${money(ctx.offer_amount)}</strong> once a buyer purchases it -- we'll email you the moment that happens.</p>`
                         : `<p>Your payout of <strong>${money(ctx.offer_amount)}</strong> is on its way. This card is now Giftlio's, so there's nothing further for you to track -- you're all done here.</p>`
                 }`
        },
        admin: {
            authorize: (ctx, callerId, isAdmin) => isAdmin,
            subject: (ctx) => `Submission Approved: ${ctx.brand} #${ctx.public_id}`,
            body: (ctx) => `<p><strong>Seller:</strong> ${escapeHtml(ctx.seller_name)}</p><p><strong>Brand:</strong> ${escapeHtml(ctx.brand)}</p><p><strong>Mode:</strong> ${escapeHtml(ctx.sale_mode)}</p><p><strong>Offer:</strong> ${money(ctx.offer_amount)}</p>`
        }
    },

    submission_rejected: {
        fetch: fetchSubmissionContext,
        seller: {
            authorize: (ctx, callerId, isAdmin) => isAdmin,
            recipientEmail: (ctx) => ctx.seller_email,
            recipientPreference: (ctx) => ctx.seller_notification_preference,
            subject: (ctx) => `Your ${ctx.brand} card submission wasn't approved`,
            body: (ctx) => `<p>Hi ${escapeHtml(ctx.seller_name)},</p>
                 <p>Your submission for a ${escapeHtml(ctx.brand)} gift card (#${escapeHtml(ctx.public_id)}) wasn't approved.</p>
                 <p><strong>Reason:</strong> ${escapeHtml(ctx.rejection_reason)}</p>
                 <p>If you have questions, reply to this email or contact support@giftlio.co.nz.</p>`
        },
        admin: {
            authorize: (ctx, callerId, isAdmin) => isAdmin,
            subject: (ctx) => `Submission Rejected: ${ctx.brand} #${ctx.public_id}`,
            body: (ctx) => `<p><strong>Seller:</strong> ${escapeHtml(ctx.seller_name)}</p><p><strong>Brand:</strong> ${escapeHtml(ctx.brand)}</p><p><strong>Reason:</strong> ${escapeHtml(ctx.rejection_reason)}</p>`
        }
    },

    payout_marked_paid: {
        fetch: fetchSubmissionContext,
        seller: {
            authorize: (ctx, callerId, isAdmin) => isAdmin,
            recipientEmail: (ctx) => ctx.seller_email,
            recipientPreference: (ctx) => ctx.seller_notification_preference,
            subject: (ctx) => `Your payout for ${ctx.brand} has been sent`,
            body: (ctx) => `<p>Hi ${escapeHtml(ctx.seller_name)},</p>
                 <p>Your payout of <strong>${money(ctx.offer_amount)}</strong> for your ${escapeHtml(ctx.brand)} card (#${escapeHtml(ctx.public_id)}) has been sent.</p>
                 <p>Thanks for selling with Giftlio!</p>`
        },
        admin: {
            authorize: (ctx, callerId, isAdmin) => isAdmin,
            subject: (ctx) => `Payout Marked Paid: ${ctx.brand} #${ctx.public_id}`,
            body: (ctx) => `<p><strong>Seller:</strong> ${escapeHtml(ctx.seller_name)}</p><p><strong>Amount:</strong> ${money(ctx.offer_amount)}</p>`
        }
    },

    marketplace_payout_released: {
        fetch: fetchMarketplaceOrderContext,
        seller: {
            authorize: (ctx, callerId, isAdmin) => isAdmin,
            recipientEmail: (ctx) => ctx.seller_email,
            recipientPreference: (ctx) => ctx.seller_notification_preference,
            subject: (ctx) => `Your payout for ${ctx.brand} has been sent`,
            body: (ctx) => `<p>Hi ${escapeHtml(ctx.seller_name || '')},</p>
                 <p>Your payout of <strong>${money(ctx.seller_payout_amount)}</strong> for your ${escapeHtml(ctx.brand)} card has been sent.</p>
                 <p>Thanks for selling with Giftlio!</p>`
        }
    },

    offer_received: {
        fetch: fetchOfferContext,
        seller: {
            authorize: (ctx, callerId, isAdmin) => isAdmin || ctx.buyer_id === callerId,
            recipientEmail: (ctx) => ctx.seller_email,
            recipientPreference: (ctx) => ctx.seller_notification_preference,
            subject: (ctx) => `New offer on your listing: ${money(ctx.offer_amount)}`,
            body: (ctx, req) => `<p>${escapeHtml(ctx.buyer_name)} sent an offer of <strong>${money(ctx.offer_amount)}</strong> on your listing (listed at ${money(ctx.original_price)}).</p>
                 <p><a href="https://${req.headers.host}/seller-dashboard">Respond to this offer</a></p>`
        }
    },

    offer_accepted: {
        fetch: fetchOfferContext,
        seller: {
            authorize: (ctx, callerId, isAdmin) => isAdmin || ctx.seller_id === callerId,
            recipientEmail: (ctx) => ctx.buyer_email,
            recipientPreference: (ctx) => ctx.buyer_notification_preference,
            subject: () => `Your offer was accepted!`,
            body: (ctx) => `<p>Great news — your offer of ${money(ctx.offer_amount)} was accepted. Head back to the listing to complete your purchase at this price.</p>`
        }
    },

    offer_rejected: {
        fetch: fetchOfferContext,
        seller: {
            authorize: (ctx, callerId, isAdmin) => isAdmin || ctx.seller_id === callerId,
            recipientEmail: (ctx) => ctx.buyer_email,
            recipientPreference: (ctx) => ctx.buyer_notification_preference,
            subject: () => `Your offer wasn't accepted`,
            body: (ctx) => `<p>The seller declined your offer of ${money(ctx.offer_amount)}. You're welcome to browse other listings or make a new offer.</p>`
        }
    },

    offer_countered: {
        fetch: fetchOfferContext,
        seller: {
            authorize: (ctx, callerId, isAdmin) => isAdmin || ctx.seller_id === callerId,
            recipientEmail: (ctx) => ctx.buyer_email,
            recipientPreference: (ctx) => ctx.buyer_notification_preference,
            subject: (ctx) => `The seller countered your offer with ${money(ctx.counter_amount)}`,
            body: (ctx) => `<p>The seller countered your offer with <strong>${money(ctx.counter_amount)}</strong>. Head back to the listing to accept or walk away.</p>`
        }
    }
};

module.exports = { EVENTS, escapeHtml, money };
