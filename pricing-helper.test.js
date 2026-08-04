/**
 * Automated tests for pricing-helper.js. Run with: node pricing-helper.test.js
 * Every case from the audit prompt is covered: zero balance, partial
 * balance, full balance, negative input, balance exceeding face value,
 * non-numeric input, and multiple brand discount percentages.
 */
const GiftlioPricing = require('./pricing-helper.js');

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, label) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        passed++;
        console.log(`PASS: ${label}`);
    } else {
        failed++;
        console.log(`FAIL: ${label}`);
        console.log(`  expected: ${JSON.stringify(expected)}`);
        console.log(`  actual:   ${JSON.stringify(actual)}`);
    }
}

function assertTrue(condition, label) {
    if (condition) {
        passed++;
        console.log(`PASS: ${label}`);
    } else {
        failed++;
        console.log(`FAIL: ${label}`);
    }
}

console.log('--- validateBalance ---');

assertEqual(
    GiftlioPricing.validateBalance(0, 50),
    { valid: true, error: null },
    'zero balance is valid on its own (a $0 card can be submitted; purchasability is a separate check)'
);

assertEqual(
    GiftlioPricing.validateBalance(25, 50),
    { valid: true, error: null },
    'partial balance (25 of 50) is valid'
);

assertEqual(
    GiftlioPricing.validateBalance(50, 50),
    { valid: true, error: null },
    'full balance (equal to face value) is valid'
);

assertEqual(
    GiftlioPricing.validateBalance(-10, 50),
    { valid: false, error: 'Balance cannot be negative.' },
    'negative balance is rejected'
);

assertEqual(
    GiftlioPricing.validateBalance(75, 50),
    { valid: false, error: "Balance cannot exceed the card's original face value." },
    'balance exceeding face value is rejected'
);

assertEqual(
    GiftlioPricing.validateBalance('abc', 50),
    { valid: false, error: 'Balance must be a number.' },
    'non-numeric input (letters) is rejected'
);

assertEqual(
    GiftlioPricing.validateBalance('$#@!', 50),
    { valid: false, error: 'Balance must be a number.' },
    'non-numeric input (symbols) is rejected'
);

assertEqual(
    GiftlioPricing.validateBalance('', 50),
    { valid: false, error: 'Enter the current balance.' },
    'empty string is rejected'
);

console.log('\n--- validateFaceValue ---');

assertEqual(GiftlioPricing.validateFaceValue(50), { valid: true, error: null }, 'positive face value is valid');
assertEqual(GiftlioPricing.validateFaceValue(0), { valid: false, error: 'Value must be greater than zero.' }, 'zero face value is rejected');
assertEqual(GiftlioPricing.validateFaceValue(-5), { valid: false, error: 'Value must be greater than zero.' }, 'negative face value is rejected');
assertEqual(GiftlioPricing.validateFaceValue('xyz'), { valid: false, error: 'Value must be a number.' }, 'non-numeric face value is rejected');

console.log('\n--- calculateSalePrice: zero/negative/invalid balance ---');

assertEqual(
    GiftlioPricing.calculateSalePrice(0, 15),
    { salePrice: 0, discountPercent: 15, purchasable: false, error: null },
    'zero balance -> sale price is 0 and unpurchasable'
);

assertEqual(
    GiftlioPricing.calculateSalePrice(-10, 15),
    { salePrice: 0, discountPercent: 15, purchasable: false, error: null },
    'negative balance -> sale price is 0 and unpurchasable, never negative'
);

assertEqual(
    GiftlioPricing.calculateSalePrice('not a number', 15),
    { salePrice: 0, discountPercent: 15, purchasable: false, error: null },
    'non-numeric balance -> sale price is 0 and unpurchasable, no crash'
);

console.log('\n--- calculateSalePrice: partial and full balance ---');

assertEqual(
    GiftlioPricing.calculateSalePrice(25, 15),
    { salePrice: 21.25, discountPercent: 15, purchasable: true, error: null },
    'partial balance $25 at 15% discount -> $21.25'
);

assertEqual(
    GiftlioPricing.calculateSalePrice(50, 15),
    { salePrice: 42.5, discountPercent: 15, purchasable: true, error: null },
    'full balance $50 at 15% discount -> $42.50'
);

console.log('\n--- calculateSalePrice: different brand percentages ---');

assertEqual(
    GiftlioPricing.calculateSalePrice(100, 15),
    { salePrice: 85, discountPercent: 15, purchasable: true, error: null },
    'The Warehouse-style 15% on $100 -> $85'
);

assertEqual(
    GiftlioPricing.calculateSalePrice(100, 10),
    { salePrice: 90, discountPercent: 10, purchasable: true, error: null },
    'Woolworths-style 10% on $100 -> $90'
);

assertEqual(
    GiftlioPricing.calculateSalePrice(100, 20),
    { salePrice: 80, discountPercent: 20, purchasable: true, error: null },
    'Farmers-style 20% on $100 -> $80'
);

assertEqual(
    GiftlioPricing.calculateSalePrice(100, 0),
    { salePrice: 100, discountPercent: 0, purchasable: true, error: null },
    '0% discount -> full face value, still purchasable'
);

assertEqual(
    GiftlioPricing.calculateSalePrice(100, 25),
    { salePrice: 75, discountPercent: 25, purchasable: true, error: null },
    'maximum 25% discount on $100 -> $75'
);

console.log('\n--- clampDiscount: bounds enforcement, no hardcoded fallback ---');

assertEqual(GiftlioPricing.clampDiscount(30), 25, 'discount above 25 is clamped to the 25% maximum');
assertEqual(GiftlioPricing.clampDiscount(-5), 0, 'discount below 0 is clamped to the 0% minimum');
assertEqual(GiftlioPricing.clampDiscount('garbage'), null, 'non-numeric discount returns null -- NOT a hardcoded fallback');
assertEqual(GiftlioPricing.clampDiscount(null), null, 'null discount returns null -- NOT a hardcoded fallback');
assertEqual(GiftlioPricing.clampDiscount(undefined), null, 'undefined discount (brand not in table) returns null -- NOT a hardcoded fallback');

console.log('\n--- calculateSalePrice: unconfigured brand is an explicit error, never a silent guess ---');

assertEqual(
    GiftlioPricing.calculateSalePrice(80, undefined),
    { salePrice: 0, discountPercent: null, purchasable: false, error: 'No discount percentage configured for this brand.' },
    'a brand with no configured percentage fails loudly, never silently uses 15% or any other number'
);

console.log('\n--- calculateCheckoutTotal ---');

assertEqual(
    GiftlioPricing.calculateCheckoutTotal(100),
    { serviceFee: 5, total: 105, feeWasCapped: false },
    '$100 sale price -> $5 service fee, $105 total, not capped either direction'
);

assertEqual(
    GiftlioPricing.calculateCheckoutTotal(21.25),
    { serviceFee: 1.06, total: 22.31, feeWasCapped: false },
    '$21.25 sale price -> correct fee and total, matches the partial-balance case above'
);

console.log('\n--- calculateCheckoutTotal: $1 minimum and $15 maximum cap ---');

assertEqual(
    GiftlioPricing.calculateCheckoutTotal(10),
    { serviceFee: 1, total: 11, feeWasCapped: false },
    '$10 card: raw 5% would be $0.50, floored up to the $1 minimum -- not flagged as "capped" since that flag is specifically for the $15 ceiling'
);

assertEqual(
    GiftlioPricing.calculateCheckoutTotal(500),
    { serviceFee: 15, total: 515, feeWasCapped: true },
    '$500 card: raw 5% would be $25, capped down to $15 -- feeWasCapped true so the UI can show "Maximum service fee applied"'
);

assertEqual(
    GiftlioPricing.calculateCheckoutTotal(300),
    { serviceFee: 15, total: 315, feeWasCapped: false },
    '$300 card: raw 5% is exactly $15 -- lands right at the ceiling without needing to be reduced, so NOT flagged as capped (that flag means "would have been higher than $15 if uncapped")'
);

assertEqual(
    GiftlioPricing.calculateCheckoutTotal(301),
    { serviceFee: 15, total: 316, feeWasCapped: true },
    '$301 card: raw 5% is $15.05, genuinely over the ceiling -- correctly capped to $15 and flagged'
);

console.log('\n--- Reported bug regression test: Woolworths at 10%, balance $80 ---');
console.log('    (this is the exact scenario reported as broken: 80 x 90% must equal 72, never 68)');

assertEqual(
    GiftlioPricing.calculateSalePrice(80, 10),
    { salePrice: 72, discountPercent: 10, purchasable: true, error: null },
    'Woolworths at 10% discount, $80 balance -> $72 (seller offer AND buyer price both use this formula)'
);
assertTrue(
    GiftlioPricing.calculateSalePrice(80, 10).salePrice !== 68,
    'confirms the old bug (flat 85% seller rate giving $68) cannot recur -- $68 is explicitly wrong here'
);

console.log('\n--- Every brand, full/partial/zero balance, at its own configured percentage ---');

// Mirrors the real brand_discounts table: every actual brand in the app,
// each with a DIFFERENT percentage, so a bug that accidentally uses one
// brand's number for another brand would be caught here.
const BRAND_TEST_PERCENTAGES = {
    'The Warehouse': 15,
    Woolworths: 10,
    'New World': 15,
    Farmers: 20,
    'Noel Leeming': 5,
    Briscoes: 25,
    'Rebel Sport': 0,
    'PB Tech': 15,
    "Pak'nSave": 12
};

Object.entries(BRAND_TEST_PERCENTAGES).forEach(([brand, pct]) => {
    const faceValue = 100;

    // Full balance
    const full = GiftlioPricing.calculateSalePrice(faceValue, pct);
    const expectedFull = Math.round(faceValue * (1 - pct / 100) * 100) / 100;
    assertEqual(full, { salePrice: expectedFull, discountPercent: pct, purchasable: true, error: null }, `${brand} (${pct}%): full balance $100 -> $${expectedFull}`);

    // Partial balance
    const partial = GiftlioPricing.calculateSalePrice(40, pct);
    const expectedPartial = Math.round(40 * (1 - pct / 100) * 100) / 100;
    assertEqual(partial, { salePrice: expectedPartial, discountPercent: pct, purchasable: true, error: null }, `${brand} (${pct}%): partial balance $40 -> $${expectedPartial}`);

    // Zero balance
    const zero = GiftlioPricing.calculateSalePrice(0, pct);
    assertEqual(zero, { salePrice: 0, discountPercent: pct, purchasable: false, error: null }, `${brand} (${pct}%): zero balance -> $0, unpurchasable`);

    // Balance exceeding face value is rejected at validation, not pricing --
    // confirm that gate independently for this brand's face value.
    const overBalanceCheck = GiftlioPricing.validateBalance(faceValue + 20, faceValue);
    assertTrue(overBalanceCheck.valid === false, `${brand}: balance exceeding face value is rejected by validateBalance`);

    // Invalid (non-numeric) input rejected for this brand's submission too.
    const invalidCheck = GiftlioPricing.validateBalance('not-a-number', faceValue);
    assertTrue(invalidCheck.valid === false, `${brand}: non-numeric balance input is rejected`);
});

assertEqual(
    GiftlioPricing.calculateSalePrice(100, 0),
    { salePrice: 100, discountPercent: 0, purchasable: true, error: null },
    "Rebel Sport-style 0% brand: seller/buyer gets 100% of balance, Giftlio's cut is genuinely zero -- explicitly valid"
);

assertEqual(
    GiftlioPricing.calculateSalePrice(100, 25),
    { salePrice: 75, discountPercent: 25, purchasable: true, error: null },
    'Briscoes-style 25% brand (the configurable maximum): $100 -> $75'
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
