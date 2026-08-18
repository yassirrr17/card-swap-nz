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

console.log('\n--- calculateMarketplacePayout: 12% commission at several price points ---');

assertEqual(
    GiftlioPricing.calculateMarketplacePayout(15, 0.12),
    { commission: 1.8, sellerPayout: 13.2, error: null },
    '$15 asking price at 12% -> $1.80 commission, $13.20 seller payout (the minimum listing price case)'
);

assertEqual(
    GiftlioPricing.calculateMarketplacePayout(50, 0.12),
    { commission: 6, sellerPayout: 44, error: null },
    '$50 asking price at 12% -> $6 commission, $44 seller payout'
);

assertEqual(
    GiftlioPricing.calculateMarketplacePayout(100, 0.12),
    { commission: 12, sellerPayout: 88, error: null },
    '$100 asking price at 12% -> $12 commission, $88 seller payout'
);

assertEqual(
    GiftlioPricing.calculateMarketplacePayout(333.33, 0.12),
    { commission: 40, sellerPayout: 293.33, error: null },
    '$333.33 asking price at 12% -> rounds to $40.00 commission, $293.33 seller payout'
);

assertEqual(
    GiftlioPricing.calculateMarketplacePayout(100, 0),
    { commission: 0, sellerPayout: 100, error: null },
    '0% commission (config edge case) -> seller keeps the full asking price, genuinely valid'
);

console.log('\n--- calculateMarketplacePayout: missing/invalid commission rate is an explicit error, never a silent guess ---');

assertEqual(
    GiftlioPricing.calculateMarketplacePayout(100, null),
    { commission: 0, sellerPayout: 0, error: 'No commission rate configured.' },
    'null commission rate (config missing) fails loudly, never silently falls back to 10% or any other number'
);

assertEqual(
    GiftlioPricing.calculateMarketplacePayout(100, undefined),
    { commission: 0, sellerPayout: 0, error: 'No commission rate configured.' },
    'undefined commission rate fails loudly'
);

assertEqual(
    GiftlioPricing.calculateMarketplacePayout(100, 1.5),
    { commission: 0, sellerPayout: 0, error: 'No commission rate configured.' },
    'commission rate above 1 (150%, clearly a fraction/percent mixup) is rejected rather than applied'
);

console.log('\n--- validateCardBalanceFloor: absolute $20 minimum ---');

assertEqual(
    GiftlioPricing.validateCardBalanceFloor(20, 100, 20),
    { valid: true, error: null },
    'balance exactly $20 (the configured minimum) on a $100 card passes'
);

assertEqual(
    GiftlioPricing.validateCardBalanceFloor(19.99, 50, 20),
    { valid: false, error: "Cards need at least $20.00 remaining. Below that isn't economical for us to process." },
    '$19.99 balance on a $50 card clears the 20% rule ($10 needed) but is rejected -- one cent under the $20 absolute minimum'
);

console.log('\n--- validateCardBalanceFloor: interaction between the 20%-of-face-value rule and the absolute floor ---');

assertEqual(
    GiftlioPricing.validateCardBalanceFloor(25, 200, 20),
    { valid: false, error: 'Cards must have at least 20% of the original value remaining to be accepted.' },
    '$25 on a $200 card clears the $20 absolute floor but fails the 20% rule ($40 needed) -- the percentage rule is the one that actually binds here, and its message is the one shown'
);

assertEqual(
    GiftlioPricing.validateCardBalanceFloor(19, 50, 20),
    { valid: false, error: "Cards need at least $20.00 remaining. Below that isn't economical for us to process." },
    '$19 on a $50 card clears the 20% rule ($10 needed) but fails the $20 absolute floor -- the absolute floor is the one that binds here, and its message is the one shown'
);

assertEqual(
    GiftlioPricing.validateCardBalanceFloor(40, 200, 20),
    { valid: true, error: null },
    '$40 on a $200 card clears both: exactly 20% of face value AND well above the $20 absolute floor'
);

assertEqual(
    GiftlioPricing.validateCardBalanceFloor(null, 100, null),
    { valid: false, error: 'Minimum balance is not configured. Please contact support before submitting.' },
    'missing pricing config blocks the submission with an explicit error, never silently skips the floor'
);

console.log('\n--- validateMinListingPrice: $15 minimum, also used for the counter-offer floor ---');

assertEqual(
    GiftlioPricing.validateMinListingPrice(15, 15),
    { valid: true, error: null },
    'asking price exactly $15 (the configured minimum) passes'
);

assertEqual(
    GiftlioPricing.validateMinListingPrice(14.99, 15),
    { valid: false, error: 'Minimum listing price is $15.00.' },
    '$14.99 asking price is rejected -- one cent under the $15 minimum'
);

assertEqual(
    GiftlioPricing.validateMinListingPrice(12, 15),
    { valid: false, error: 'Minimum listing price is $15.00.' },
    'a seller counter-offer of $12 is rejected by the same floor a listing price would be -- counter-offers cannot land below min_listing_price'
);

assertEqual(
    GiftlioPricing.validateMinListingPrice(15, null),
    { valid: false, error: 'Minimum listing price is not configured. Please contact support before submitting.' },
    'missing pricing config blocks a counter-offer/listing price too, never silently allows it through'
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
