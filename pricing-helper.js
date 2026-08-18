/**
 * Giftlio Pricing Helper — the single source of truth for gift card pricing
 * and balance validation. Every page that needs to validate a balance or
 * calculate a sale price must use these functions, not its own math.
 *
 * Scope: this governs INSTANT SELL pricing only (Giftlio sets the price
 * from current balance + the brand's discount percentage). Marketplace
 * mode is intentionally different -- the seller sets their own price there,
 * so calculateSalePrice() is not used for marketplace listings.
 *
 * Pure functions only: no DOM, no network, no globals beyond this module.
 * That's deliberate, so this file can be loaded in a browser AND required
 * directly in Node for real automated tests (see pricing-helper.test.js).
 */
const GiftlioPricing = (function () {
    const MIN_DISCOUNT = 0;
    const MAX_DISCOUNT = 25;

    /**
     * Clamps a discount percentage into the valid 0-25 range. Falls back to
     * the default (15%) for anything non-numeric, so a bad DB read never
     * produces an invalid price rather than just a wrong one.
     */
    /**
     * Clamps a discount percentage into the valid 0-25 range. Returns null
     * for anything unconfigured (null/undefined/empty/non-numeric) --
     * deliberately does NOT fall back to any default number. A brand with
     * no explicit percentage set is an error state the caller must handle,
     * not something to silently guess at.
     */
    function clampDiscount(percent) {
        if (percent === null || percent === undefined || percent === '') return null;
        const num = Number(percent);
        if (!Number.isFinite(num)) return null;
        return Math.min(MAX_DISCOUNT, Math.max(MIN_DISCOUNT, num));
    }

    /**
     * Validates a balance against a card's face value. Used identically on
     * the sell submission form, the admin approval flow, and anywhere else
     * a balance is entered or edited.
     *
     * Returns { valid: boolean, error: string|null }.
     */
    function validateBalance(balanceInput, faceValueInput) {
        if (balanceInput === '' || balanceInput === null || balanceInput === undefined) {
            return { valid: false, error: 'Enter the current balance.' };
        }

        const balance = Number(balanceInput);

        if (Number.isNaN(balance) || !Number.isFinite(balance)) {
            return { valid: false, error: 'Balance must be a number.' };
        }
        if (balance < 0) {
            return { valid: false, error: 'Balance cannot be negative.' };
        }

        if (faceValueInput !== null && faceValueInput !== undefined && faceValueInput !== '') {
            const faceValue = Number(faceValueInput);
            if (!Number.isNaN(faceValue) && Number.isFinite(faceValue) && balance > faceValue) {
                return { valid: false, error: "Balance cannot exceed the card's original face value." };
            }
        }

        return { valid: true, error: null };
    }

    /**
     * Validates a face value on its own (must be a positive number).
     */
    function validateFaceValue(faceValueInput) {
        if (faceValueInput === '' || faceValueInput === null || faceValueInput === undefined) {
            return { valid: false, error: "Enter the card's original value." };
        }
        const faceValue = Number(faceValueInput);
        if (Number.isNaN(faceValue) || !Number.isFinite(faceValue)) {
            return { valid: false, error: 'Value must be a number.' };
        }
        if (faceValue <= 0) {
            return { valid: false, error: 'Value must be greater than zero.' };
        }
        return { valid: true, error: null };
    }

    const PERCENT_OF_FACE_VALUE_FLOOR = 0.2;

    /**
     * The two balance floors a submission must clear, together in one
     * place so the interaction is a single testable unit instead of two
     * checks scattered across the trigger and the client: at least 20% of
     * the card's own face value, AND at least the configured absolute
     * dollar minimum -- whichever is stricter for this face value is the
     * one that actually binds. minBalanceInput must come from the live
     * pricing_config row; a missing/unconfigured value blocks rather than
     * silently allowing everything through.
     */
    function validateCardBalanceFloor(balanceInput, faceValueInput, minBalanceInput) {
        if (minBalanceInput === null || minBalanceInput === undefined || minBalanceInput === '') {
            return { valid: false, error: 'Minimum balance is not configured. Please contact support before submitting.' };
        }
        const minBalance = Number(minBalanceInput);
        if (!Number.isFinite(minBalance)) {
            return { valid: false, error: 'Minimum balance is not configured. Please contact support before submitting.' };
        }

        const balance = Number(balanceInput);
        if (balanceInput === '' || balanceInput === null || balanceInput === undefined || !Number.isFinite(balance)) {
            return { valid: false, error: 'Enter the current balance.' };
        }

        const faceValue = Number(faceValueInput);
        if (faceValueInput === null || faceValueInput === undefined || faceValueInput === '' || !Number.isFinite(faceValue) || faceValue <= 0) {
            return { valid: false, error: "Enter the card's original value first." };
        }

        const percentFloor = Math.round(faceValue * PERCENT_OF_FACE_VALUE_FLOOR * 100) / 100;
        if (balance < percentFloor) {
            return { valid: false, error: 'Cards must have at least 20% of the original value remaining to be accepted.' };
        }
        if (balance < minBalance) {
            return { valid: false, error: `Cards need at least $${minBalance.toFixed(2)} remaining. Below that isn't economical for us to process.` };
        }

        return { valid: true, error: null };
    }

    /**
     * Minimum marketplace listing/counter-offer price -- used for the
     * seller's asking price on submission AND for a counter-offer amount,
     * since both are "what a buyer would actually pay" and neither should
     * ever be allowed below the configured floor. minPriceInput must come
     * from the live pricing_config row; missing config blocks rather than
     * guessing a default.
     */
    function validateMinListingPrice(priceInput, minPriceInput) {
        if (minPriceInput === null || minPriceInput === undefined || minPriceInput === '') {
            return { valid: false, error: 'Minimum listing price is not configured. Please contact support before submitting.' };
        }
        const minPrice = Number(minPriceInput);
        if (!Number.isFinite(minPrice)) {
            return { valid: false, error: 'Minimum listing price is not configured. Please contact support before submitting.' };
        }

        const price = Number(priceInput);
        if (priceInput === '' || priceInput === null || priceInput === undefined || !Number.isFinite(price)) {
            return { valid: false, error: 'Enter your asking price.' };
        }

        if (price < minPrice) {
            return { valid: false, error: `Minimum listing price is $${minPrice.toFixed(2)}.` };
        }

        return { valid: true, error: null };
    }

    /**
     * The ONLY place Instant Sell sale price (and, by the same formula,
     * seller offer) is ever calculated. Takes the current balance and a
     * brand's discount percentage (0-25, from the brand_discounts table)
     * and returns the buyer-facing price / seller payout.
     *
     * If discountPercent is unconfigured (null), this is a configuration
     * error, not a pricing decision -- returns purchasable: false with an
     * explicit error, rather than silently guessing a percentage.
     *
     * Zero or invalid balance -> price is 0 and the card is marked
     * unpurchasable, never a negative or nonsensical price.
     */
    function calculateSalePrice(currentBalanceInput, discountPercentInput) {
        const discountPercent = clampDiscount(discountPercentInput);

        if (discountPercent === null) {
            return { salePrice: 0, discountPercent: null, purchasable: false, error: 'No discount percentage configured for this brand.' };
        }

        const balance = Number(currentBalanceInput);

        if (!Number.isFinite(balance) || balance <= 0) {
            return { salePrice: 0, discountPercent, purchasable: false, error: null };
        }

        const rawPrice = balance * (1 - discountPercent / 100);
        const salePrice = Math.round(rawPrice * 100) / 100;

        return { salePrice, discountPercent, purchasable: salePrice > 0, error: null };
    }

    /**
     * The ONLY place marketplace commission is ever calculated -- was
     * previously inlined directly in approveSubmission() (app.js), which
     * defeated the point of having a single source of truth for pricing.
     * Every caller (the live payout preview on the sell form, the
     * submission's stored offer estimate, admin approval, and the Stripe
     * webhook's instrumentation) must go through this function.
     *
     * commissionRateInput is a fraction (0.12 for 12%), always sourced
     * from the live pricing_config row -- never hardcoded, never a
     * fallback default. A missing/invalid rate is a configuration error,
     * not a pricing decision: returns an explicit error rather than
     * silently applying some other number.
     *
     * There is no buyer-side fee. The buyer pays exactly askingPrice --
     * the commission comes entirely out of the seller's payout.
     */
    function calculateMarketplacePayout(askingPriceInput, commissionRateInput) {
        if (commissionRateInput === null || commissionRateInput === undefined || commissionRateInput === '') {
            return { commission: 0, sellerPayout: 0, error: 'No commission rate configured.' };
        }
        const rate = Number(commissionRateInput);
        if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
            return { commission: 0, sellerPayout: 0, error: 'No commission rate configured.' };
        }

        const askingPrice = Number(askingPriceInput);
        if (!Number.isFinite(askingPrice) || askingPrice <= 0) {
            return { commission: 0, sellerPayout: 0, error: 'Enter a valid asking price.' };
        }

        const commission = Math.round(askingPrice * rate * 100) / 100;
        const sellerPayout = Math.round((askingPrice - commission) * 100) / 100;
        return { commission, sellerPayout, error: null };
    }

    return {
        MIN_DISCOUNT,
        MAX_DISCOUNT,
        clampDiscount,
        validateBalance,
        validateFaceValue,
        validateCardBalanceFloor,
        validateMinListingPrice,
        calculateSalePrice,
        calculateMarketplacePayout
    };
})();

// Node (for tests) vs browser (global) -- same module, both environments.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GiftlioPricing;
}
