/**
 * Fixtures shaped exactly like the storefront DTOs.
 *
 * Copied from `publicProductCardDto`, `publicProductDto` and
 * `publicCategoryTreeDto` rather than invented, so a test passing here means
 * the component can read what the API actually sends. In particular: a card
 * carries **no** compare-at price and no variants, and a sold-out product's
 * `priceRange` is `null` — both of which are easy to get wrong from memory.
 */

export function productCard(overrides = {}) {
  return {
    id: 'prod-1',
    handle: 'copperleaf-classic',
    title: 'Copperleaf Classic',
    subtitle: 'Two aged patties, house sauce',
    category: { name: 'Prepared Foods', handle: 'prepared-foods' },
    priceRange: {
      min: { amount: 1150, currency: 'GBP' },
      max: { amount: 1400, currency: 'GBP' },
    },
    image: null,
    available: true,
    tags: ['beef', 'signature'],
    // The colours the product comes in, published on the card so a grid can
    // draw circles without a request per card. Empty for most products.
    colours: [],
    ...overrides,
  }
}

/** A product whose axis is a colour, as the card DTO sends it. */
export function colourfulCard(overrides = {}) {
  return productCard({
    id: 'prod-2',
    handle: 'velvet-matte',
    title: 'Velvet Matte Lipstick',
    colours: [
      { value: 'Mulberry', swatchHex: '#7b2d4e' },
      { value: 'Deep Brown', swatchHex: '#4a2c20' },
    ],
    ...overrides,
  })
}

export function productDetail(overrides = {}) {
  return {
    id: 'prod-1',
    handle: 'copperleaf-classic',
    title: 'Copperleaf Classic',
    subtitle: 'Two aged patties, house sauce',
    description: 'The one we opened with.',
    category: { name: 'Prepared Foods', handle: 'prepared-foods' },
    productType: 'Burger',
    tags: ['beef', 'signature'],
    seo: { title: 'Copperleaf Classic', description: null },
    options: [
      {
        id: 'opt-1',
        name: 'Size',
        values: [
          { id: 'v1', value: 'Single', swatchHex: null },
          { id: 'v2', value: 'Double', swatchHex: null },
        ],
      },
    ],
    variants: [
      {
        id: 'var-1',
        title: 'Single',
        sku: 'CLASSIC-1',
        price: { amount: 1150, currency: 'GBP' },
        compareAtPrice: null,
        available: true,
        availability: 'in_stock',
        image: null,
        options: [{ name: 'Size', value: 'Single', valueId: 'v1' }],
      },
      {
        id: 'var-2',
        title: 'Double',
        sku: 'CLASSIC-2',
        price: { amount: 1400, currency: 'GBP' },
        compareAtPrice: null,
        available: true,
        availability: 'in_stock',
        image: null,
        options: [{ name: 'Size', value: 'Double', valueId: 'v2' }],
      },
    ],
    priceRange: {
      min: { amount: 1150, currency: 'GBP' },
      max: { amount: 1400, currency: 'GBP' },
    },
    images: [],
    available: true,
    ...overrides,
  }
}


// ── Collections ─────────────────────────────────────────────────────────────

/**
 * `publicCollectionDto`. Note what is *not* here: no `type`, no `rules`, no
 * product count. Whether a collection is manual or dynamic is the server's
 * business — the storefront asks for a handle and receives products, and a
 * shopper cannot tell the difference. That is the whole point.
 */
export function collection(overrides = {}) {
  return {
    handle: 'bestsellers',
    title: 'Bestsellers',
    description: 'What leaves the counter fastest.',
    seo: { title: 'Bestsellers', description: null },
    position: 0,
    ...overrides,
  }
}

export function collectionList() {
  return [
    collection(),
    collection({ handle: 'in-the-bakery', title: 'In the bakery', description: null, position: 1 }),
    collection({ handle: 'under-10', title: 'Under £10', description: null, position: 2 }),
  ]
}

// ── The basket ──────────────────────────────────────────────────────────────

/** One line of a cart, shaped like the server's. */
export function cartLine(overrides = {}) {
  return {
    variantId: 'var-1',
    productId: 'prod-1',
    handle: 'copperleaf-classic',
    productTitle: 'Copperleaf Classic',
    variantTitle: 'Single',
    sku: 'CLASSIC-1',
    options: [],
    image: null,
    quantity: 2,
    unitPrice: { amount: 1150, currency: 'GBP' },
    lineTotal: { amount: 2300, currency: 'GBP' },
    purchasable: true,
    availability: 'in_stock',
    problem: null,
    ...overrides,
  }
}

/**
 * A cart. `totals` are the server's arithmetic verbatim — the fixture does not
 * derive them from the lines, because the storefront must not either, and a
 * fixture that computed them would let a component that computes them pass.
 */
export function cart(overrides = {}) {
  return {
    id: 'cart-1',
    status: 'active',
    currency: 'GBP',
    lines: [cartLine()],
    totals: {
      subtotal: { amount: 2300, currency: 'GBP' },
      discountTotal: { amount: 0, currency: 'GBP' },
      taxTotal: { amount: 460, currency: 'GBP' },
      shippingTotal: { amount: 0, currency: 'GBP' },
      total: { amount: 2760, currency: 'GBP' },
      itemCount: 2,
    },
    purchasable: true,
    updatedAt: '2026-08-31T10:00:00.000Z',
    ...overrides,
  }
}

export function emptyCart() {
  return cart({
    lines: [],
    purchasable: false,
    totals: {
      subtotal: { amount: 0, currency: 'GBP' },
      discountTotal: { amount: 0, currency: 'GBP' },
      taxTotal: { amount: 0, currency: 'GBP' },
      shippingTotal: { amount: 0, currency: 'GBP' },
      total: { amount: 0, currency: 'GBP' },
      itemCount: 0,
    },
  })
}

// ── Checkout ────────────────────────────────────────────────────────────────

/** `/storefront/checkout/preview`. Every figure comes from the server. */
export function checkoutQuote(overrides = {}) {
  return {
    subtotal: { amount: 2300, currency: 'GBP' },
    discountTotal: { amount: 0, currency: 'GBP' },
    shippingTotal: { amount: 395, currency: 'GBP' },
    shippingOptions: [
      {
        id: 'ship-standard',
        name: 'Standard delivery',
        description: '2–3 working days',
        price: { amount: 395, currency: 'GBP' },
        estimatedDaysMin: 2,
        estimatedDaysMax: 3,
      },
      {
        id: 'ship-express',
        name: 'Next day',
        description: null,
        price: { amount: 895, currency: 'GBP' },
        estimatedDaysMin: 1,
        estimatedDaysMax: 1,
      },
    ],
    selectedShippingMethodId: 'ship-standard',
    taxTotal: { amount: 539, currency: 'GBP' },
    total: { amount: 3234, currency: 'GBP' },
    paymentFee: { amount: 0, currency: 'GBP' },
    paymentMethods: [
      {
        key: 'card',
        label: 'Card',
        description: 'Visa, Mastercard and Amex.',
        fee: { amount: 0, currency: 'GBP' },
      },
      {
        key: 'cod',
        label: 'Cash on delivery',
        description: 'Pay the courier.',
        fee: { amount: 150, currency: 'GBP' },
      },
    ],
    selectedPaymentMethod: 'card',
    discount: null,
    purchasable: true,
    ...overrides,
  }
}

// ── Orders ──────────────────────────────────────────────────────────────────

/**
 * `customerOrderDto` — the customer's own view of an order. Note that it
 * carries `paymentState`, a three-way summary, and *not* the admin's
 * status triple: a shopper is never shown a fulfilment status they cannot act
 * on.
 */
export function order(overrides = {}) {
  return {
    id: 'order-1',
    orderNumber: '#1001',
    status: 'pending',
    paymentState: 'awaiting_payment',
    email: 'shopper@example.test',
    phone: null,
    currency: 'GBP',
    totals: {
      subtotal: { amount: 2300, currency: 'GBP' },
      discountTotal: { amount: 0, currency: 'GBP' },
      taxTotal: { amount: 539, currency: 'GBP' },
      shippingTotal: { amount: 395, currency: 'GBP' },
      paymentFee: { amount: 0, currency: 'GBP' },
      total: { amount: 3234, currency: 'GBP' },
      refundedTotal: { amount: 0, currency: 'GBP' },
    },
    items: [
      {
        id: 'item-1',
        productTitle: 'Copperleaf Classic',
        variantTitle: 'Single',
        sku: 'CLASSIC-1',
        quantity: 2,
        unitPrice: { amount: 1150, currency: 'GBP' },
        total: { amount: 2300, currency: 'GBP' },
      },
    ],
    addresses: [
      {
        type: 'shipping',
        firstName: 'Ada',
        lastName: 'Lovelace',
        company: null,
        line1: '1 Analytical Way',
        line2: null,
        city: 'London',
        region: null,
        postalCode: 'E1 1AA',
        countryCode: 'GB',
        phone: null,
      },
    ],
    discounts: [],
    shippingMethodName: 'Standard delivery',
    paymentMethod: 'card',
    customerNote: null,
    cancelReason: null,
    placedAt: '2026-08-31T10:05:00.000Z',
    confirmedAt: null,
    cancelledAt: null,
    completedAt: null,
    ...overrides,
  }
}

/** `customerOrderCardDto` — a row in "my orders", and nothing more. */
export function orderCard(overrides = {}) {
  return {
    id: 'order-1',
    orderNumber: '#1001',
    status: 'pending',
    total: { amount: 3234, currency: 'GBP' },
    placedAt: '2026-08-31T10:05:00.000Z',
    ...overrides,
  }
}

/**
 * What `/auth/login` returns. The refresh token is absent on purpose: it
 * travels only in an httpOnly cookie, and a fixture that included one would
 * let a client that stored it pass.
 */
export function session(overrides = {}) {
  return {
    accessToken: 'access-token-1',
    tokenType: 'Bearer',
    expiresIn: 900,
    user: {
      id: 'user-1',
      email: 'shopper@example.test',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: null,
      emailVerified: true,
      status: 'active',
      roles: ['customer'],
      createdAt: '2026-01-04T09:00:00.000Z',
      permissions: [],
      isStaff: false,
      sessionId: 'session-1',
    },
    ...overrides,
  }
}

/**
 * A two-axis product with a real colour axis — the shape the swatch picker,
 * the variant-image swap and the quick-add panel all exist for.
 *
 * Deliberately not a full grid: Deep Brown comes in 5 g only. That gap is what
 * makes "not made" a distinct state from "sold out", and a picker that treats
 * them the same looks correct until somebody clicks it.
 */
export function lipstick(overrides = {}) {
  const shade = {
    id: 'opt-shade',
    name: 'Shade',
    values: [
      { id: 'val-mulberry', value: 'Mulberry', swatchHex: '#7b2d4e' },
      { id: 'val-brown', value: 'Deep Brown', swatchHex: '#4a2c20' },
    ],
  }
  const size = {
    id: 'opt-size',
    name: 'Size',
    values: [
      { id: 'val-5g', value: '5 g', swatchHex: null },
      { id: 'val-40g', value: '40 g', swatchHex: null },
    ],
  }

  const variant = (id, shadeValue, shadeId, sizeValue, sizeId, amount, extra = {}) => ({
    id,
    title: `${shadeValue} / ${sizeValue}`,
    sku: id.toUpperCase(),
    price: { amount, currency: 'GBP' },
    compareAtPrice: null,
    available: true,
    availability: 'in_stock',
    image: null,
    options: [
      { name: 'Shade', value: shadeValue, valueId: shadeId },
      { name: 'Size', value: sizeValue, valueId: sizeId },
    ],
    ...extra,
  })

  return {
    id: 'prod-2',
    handle: 'velvet-matte',
    title: 'Velvet Matte Lipstick',
    subtitle: 'Long-wear, no transfer',
    description: 'A matte that does not dry.',
    category: { name: 'Lips', handle: 'lips' },
    productType: 'Lipstick',
    tags: ['bestseller'],
    seo: { title: 'Velvet Matte Lipstick', description: null },
    options: [shade, size],
    variants: [
      variant('var-mul-5', 'Mulberry', 'val-mulberry', '5 g', 'val-5g', 1900, {
        image: { url: 'https://cdn.test/mulberry.jpg', alt: 'Mulberry', variants: {} },
      }),
      variant('var-mul-40', 'Mulberry', 'val-mulberry', '40 g', 'val-40g', 3400),
      variant('var-brown-5', 'Deep Brown', 'val-brown', '5 g', 'val-5g', 1900, {
        image: { url: 'https://cdn.test/brown.jpg', alt: 'Deep Brown', variants: {} },
      }),
      // No Deep Brown in 40 g. The gap is the point.
    ],
    priceRange: {
      min: { amount: 1900, currency: 'GBP' },
      max: { amount: 3400, currency: 'GBP' },
    },
    images: [
      { url: 'https://cdn.test/hero.jpg', alt: 'Both shades', isPrimary: true, variants: {} },
      { url: 'https://cdn.test/mulberry.jpg', alt: 'Mulberry', isPrimary: false, variants: {} },
      { url: 'https://cdn.test/brown.jpg', alt: 'Deep Brown', isPrimary: false, variants: {} },
    ],
    available: true,
    ...overrides,
  }
}

// ── The account area ────────────────────────────────────────────────────────

/** `addressDto` from the customers feature. */
export function address(overrides = {}) {
  return {
    id: 'addr-1',
    label: 'Home',
    firstName: 'Ada',
    lastName: 'Lovelace',
    company: null,
    line1: '1 Analytical Way',
    line2: null,
    city: 'London',
    region: null,
    postalCode: 'E1 1AA',
    countryCode: 'GB',
    phone: null,
    isDefault: true,
    createdAt: '2026-02-01T09:00:00.000Z',
    ...overrides,
  }
}

/**
 * `profileDto`. Note what is *not* here: no roles, no status, no spend. The
 * customer's own view is deliberately narrower than the admin's.
 */
export function profile(overrides = {}) {
  return {
    id: 'user-1',
    email: 'shopper@example.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: null,
    emailVerified: true,
    acceptsMarketing: false,
    createdAt: '2026-01-04T09:00:00.000Z',
    ...overrides,
  }
}

/** One row of `GET /auth/sessions`. The refresh token is never in it. */
export function sessionRow(overrides = {}) {
  return {
    id: 'sess-1',
    current: true,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
    ip: '203.0.113.4',
    createdAt: '2026-08-30T09:00:00.000Z',
    expiresAt: '2026-09-30T09:00:00.000Z',
    ...overrides,
  }
}

/** `returnCardDto`. */
export function returnCard(overrides = {}) {
  return {
    id: 'ret-1',
    returnNumber: 'RET-1001',
    orderId: 'order-1',
    customerId: 'user-1',
    status: 'requested',
    reason: 'damaged',
    refunded: false,
    requestedAt: '2026-08-30T10:00:00.000Z',
    closedAt: null,
    ...overrides,
  }
}

/**
 * `GET /orders/:id/returnable`.
 *
 * `returnableQuantity` is the server's arithmetic — quantity minus what has
 * already gone back — and the fixture states it rather than deriving it, so a
 * component that did its own subtraction could not pass by accident.
 */
export function returnable(overrides = {}) {
  return {
    orderId: 'order-1',
    currency: 'GBP',
    eligible: true,
    reason: null,
    lines: [
      {
        orderItemId: 'item-1',
        productTitle: 'Copperleaf Classic',
        variantTitle: 'Single',
        sku: 'CLASSIC-1',
        quantity: 3,
        returnedQuantity: 1,
        returnableQuantity: 2,
      },
    ],
    ...overrides,
  }
}

/** `notificationDto`. */
export function notification(overrides = {}) {
  return {
    id: 'note-1',
    type: 'order.shipped',
    title: 'Your order is on its way',
    body: 'Order #1001 left us this morning.',
    data: { orderId: 'order-1' },
    read: false,
    readAt: null,
    createdAt: '2026-08-31T08:00:00.000Z',
    ...overrides,
  }
}

/** The tree `GET /storefront/categories` returns, nested. */
export function categoryTree() {
  return [
    {
      name: 'Lips',
      handle: 'lips',
      description: '<p>Balms and colour.</p>',
      position: 0,
      children: [
        { name: 'Balms', handle: 'balms', description: null, position: 0, children: [] },
        { name: 'Lipstick', handle: 'lipstick', description: null, position: 1, children: [] },
      ],
    },
    { name: 'Skin', handle: 'skin', description: null, position: 1, children: [] },
  ]
}

/** One category, with the trail the detail route adds. */
export function category(overrides = {}) {
  return {
    name: 'Lips',
    handle: 'lips',
    description: '<p>Balms and colour.</p>',
    position: 0,
    children: [],
    breadcrumb: [
      { name: 'Make-up', handle: 'make-up' },
      { name: 'Lips', handle: 'lips' },
    ],
    ...overrides,
  }
}

/**
 * What `POST /storefront/payments/bank-transfer` answers: where to send the
 * money, and what became of anything already sent.
 */
export function bankTransfer(overrides = {}) {
  return {
    order: {
      id: 'order-1',
      orderNumber: '#1001',
      total: { amount: 3234, currency: 'GBP' },
      paymentMethod: 'bank_transfer',
      paymentStatus: 'pending',
      status: 'pending',
    },
    bankDetails: {
      accountName: 'Copperleaf Ltd',
      bankName: 'Example Bank',
      accountNumber: '12345678',
      iban: 'GB33BUKB20201555555555',
      swift: null,
      instructions: '<p>Use your <strong>order number</strong> as the reference.</p>',
    },
    proofs: [],
    ...overrides,
  }
}

export function paymentProof(overrides = {}) {
  return {
    id: 'proof-1',
    status: 'submitted',
    submittedAt: '2026-08-31T11:00:00.000Z',
    reviewedAt: null,
    reviewNote: null,
    senderName: 'Ada Lovelace',
    senderBank: 'Example Bank',
    ...overrides,
  }
}
