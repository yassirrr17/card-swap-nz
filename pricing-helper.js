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
    const DEFAULT_DISCOUNT = 15;

    /**
     * Clamps a discount percentage into the valid 0-25 range. Falls back to
     * the default (15%) for anything non-numeric, so a bad DB read never
     * produces an invalid price rather than just a wrong one.
     */
    function clampDiscount(percent) {
        if (percent === null || percent === undefined || percent === '') return DEFAULT_DISCOUNT;
        const num = Number(percent);
        if (!Number.isFinite(num)) return DEFAULT_DISCOUNT;
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

    /**
     * The ONLY place Instant Sell sale price is ever calculated. Takes the
     * current balance and a brand's discount percentage (0-25, from the
     * brand_discounts table) and returns the buyer-facing price.
     *
     * Zero or invalid balance -> price is 0 and the card is marked
     * unpurchasable, never a negative or nonsensical price.
     */
    function calculateSalePrice(currentBalanceInput, discountPercentInput) {
        const balance = Number(currentBalanceInput);
        const discountPercent = clampDiscount(discountPercentInput);

        if (!Number.isFinite(balance) || balance <= 0) {
            return { salePrice: 0, discountPercent, purchasable: false };
        }

        const rawPrice = balance * (1 - discountPercent / 100);
        const salePrice = Math.round(rawPrice * 100) / 100;

        return { salePrice, discountPercent, purchasable: salePrice > 0 };
    }

    const SERVICE_FEE_RATE = 0.05;

    /**
     * Computes the buyer's checkout total from a listing's sale price --
     * the ONLY place the service fee percentage should be hardcoded. This
     * was previously duplicated as a raw 0.05 in two separate places
     * (checkout initiation and the order confirmation modal), which is
     * exactly the "no page should have its own math" problem this helper
     * exists to prevent.
     */
    function calculateCheckoutTotal(salePrice) {
        const price = Number(salePrice) || 0;
        const serviceFee = Math.round(price * SERVICE_FEE_RATE * 100) / 100;
        const total = Math.round((price + serviceFee) * 100) / 100;
        return { serviceFee, total };
    }

    return {
        MIN_DISCOUNT,
        MAX_DISCOUNT,
        DEFAULT_DISCOUNT,
        SERVICE_FEE_RATE,
        clampDiscount,
        validateBalance,
        validateFaceValue,
        calculateSalePrice,
        calculateCheckoutTotal
    };
})();

// Node (for tests) vs browser (global) -- same module, both environments.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GiftlioPricing;
}
