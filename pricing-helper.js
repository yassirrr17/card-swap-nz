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
    { salePrice: 0, discountPercent: 15, purchasable: false },
    'zero balance -> sale price is 0 and unpurchasable'
);

assertEqual(
    GiftlioPricing.calculateSalePrice(-10, 15),
    { salePrice: 0, discountPercent: 15, purchasable: false },
    'negative balance -> sale price is 0 and unpurchasable, never negative'
);

assertEqual(
    GiftlioPricing.calculateSalePrice('not a number', 15),
    { salePrice: 0, discountPercent: 15, purchasable: false },
    'non-numeric balance -> sale price is 0 and unpurchasable, no crash'
);

console.log('\n--- calculateSalePrice: partial and full balance ---');

assertEqual(
    GiftlioPricing.calculateSalePrice(25, 15),
    { salePrice: 21.25, discountPercent: 15, purchasable: true },
    'partial balance $25 at 15% discount -> $21.25'
);

assertEqual(
    GiftlioPricing.calculateSalePrice(50, 15),
    { salePrice: 42.5, discountPercent: 15, purchasable: true },
    'full balance $50 at 15% discount -> $42.50'
);

console.log('\n--- calculateSalePrice: different brand percentages ---');

assertEqual(
    GiftlioPricing.calculateSalePrice(100, 15),
    { salePrice: 85, discountPercent: 15, purchasable: true },
    'The Warehouse-style 15% on $100 -> $85'
);

assertEqual(
    GiftlioPricing.calculateSalePrice(100, 10),
    { salePrice: 90, discountPercent: 10, purchasable: true },
    'Woolworths-style 10% on $100 -> $90'
);

assertEqual(
    GiftlioPricing.calculateSalePrice(100, 20),
    { salePrice: 80, discountPercent: 20, purchasable: true },
    'Farmers-style 20% on $100 -> $80'
);

assertEqual(
    GiftlioPricing.calculateSalePrice(100, 0),
    { salePrice: 100, discountPercent: 0, purchasable: true },
    '0% discount -> full face value, still purchasable'
);

assertEqual(
    GiftlioPricing.calculateSalePrice(100, 25),
    { salePrice: 75, discountPercent: 25, purchasable: true },
    'maximum 25% discount on $100 -> $75'
);

console.log('\n--- clampDiscount: bounds enforcement ---');

assertEqual(GiftlioPricing.clampDiscount(30), 25, 'discount above 25 is clamped to the 25% maximum');
assertEqual(GiftlioPricing.clampDiscount(-5), 0, 'discount below 0 is clamped to the 0% minimum');
assertEqual(GiftlioPricing.clampDiscount('garbage'), 15, 'non-numeric discount falls back to the 15% default');
assertEqual(GiftlioPricing.clampDiscount(null), 15, 'null discount falls back to the 15% default');
assertEqual(GiftlioPricing.clampDiscount(undefined), 15, 'undefined discount falls back to the 15% default (brand not yet in table)');

console.log('\n--- calculateCheckoutTotal ---');

assertEqual(
    GiftlioPricing.calculateCheckoutTotal(100),
    { serviceFee: 5, total: 105 },
    '$100 sale price -> $5 service fee, $105 total'
);

assertEqual(
    GiftlioPricing.calculateCheckoutTotal(21.25),
    { serviceFee: 1.06, total: 22.31 },
    '$21.25 sale price -> correct fee and total, matches the partial-balance case above'
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
