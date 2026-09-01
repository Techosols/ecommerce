import type { RuleField } from '@/components/rules'
import type {
  CollectionDetail,
  CollectionSummary,
} from '@/features/collections/types/collections.types'
import type {
  InventoryItemDetail,
  InventoryItemSummary,
  Location as StockLocation,
  Reservation,
  StockMovement,
} from '@/features/inventory/types/inventory.types'
import type {
  AuditRecord,
  Role,
  Session,
  StaffMember,
  StoreSettings,
} from '@/features/settings/types/settings.types'
import type {
  RateQuote,
  ShippingMethod,
  ShippingZone,
} from '@/features/shipping/types/shipping.types'
import type {
  DiscountDetail,
  DiscountSummary,
  Redemption,
} from '@/features/discounts/types/discounts.types'
import type {
  AttemptSummary,
  CartDetail,
  CartSummary,
  CheckoutAttempt,
} from '@/features/checkout/types/checkout.types'
import type { Category } from '@/features/categories/types/categories.types'
import type {
  CustomerDetail,
  CustomerEvent,
  CustomerSegment,
  CustomerSummary,
} from '@/features/customers/types/customers.types'
import type { CurrentUser } from '@/features/auth/auth.types'
import type { OrderDetail, OrderSummary } from '@/features/orders/types/orders.types'
import type {
  DraftDetail,
  DraftSummary,
  VariantMatch,
} from '@/features/drafts/types/drafts.types'
import type {
  Refundable,
  ReturnDetail,
  ReturnSummary,
} from '@/features/returns/types/returns.types'
import type {
  ProductDetail,
  ProductSummary,
  VariantInventory,
} from '@/features/products/types/products.types'

/**
 * Fixtures shaped exactly like the server's DTOs.
 *
 * Copied from `adminProductSummaryDto`, `adminProductDto` and
 * `adminCategoryDto` rather than invented, so a test passing here means the
 * component can read what the API actually sends.
 */

export const adminUser: CurrentUser = {
  id: 'user-admin',
  email: 'admin@example.com',
  firstName: 'Ada',
  lastName: 'Admin',
  phone: null,
  emailVerified: true,
  status: 'active',
  roles: ['admin'],
  createdAt: '2026-01-01T00:00:00.000Z',
  permissions: [
    'catalog:read',
    'catalog:write',
    'catalog:publish',
    'inventory:read',
    'inventory:adjust',
    'inventory:manage',
    'orders:read',
    'orders:write',
    'orders:cancel',
    'payments:read',
    'payments:capture',
    'payments:refund',
    'shipping:read',
    'shipping:write',
    'returns:read',
    'returns:write',
    'customers:read',
    'customers:write',
  ],
  isStaff: true,
  sessionId: 'session-admin',
}

/** Staff hold `catalog:read` and nothing else in the catalogue. */
export const staffUser: CurrentUser = {
  ...adminUser,
  id: 'user-staff',
  email: 'staff@example.com',
  firstName: 'Sam',
  lastName: 'Staff',
  roles: ['staff'],
  permissions: ['catalog:read', 'inventory:read', 'orders:read', 'customers:read'],
  sessionId: 'session-staff',
}

export function productSummary(overrides: Partial<ProductSummary> = {}): ProductSummary {
  return {
    id: 'prod-1',
    handle: 'classic-burger',
    title: 'Classic Burger',
    status: 'active',
    categoryId: 'cat-1',
    productType: 'Burger',
    vendor: 'In-house',
    tags: ['beef'],
    imageUrl: null,
    variantCount: 1,
    // Tracked, and in stock. `null` here would mean *untracked*, which is a
    // different row in the inventory column.
    available: 24,
    createdAt: '2026-02-01T10:00:00.000Z',
    updatedAt: '2026-02-02T10:00:00.000Z',
    ...overrides,
  }
}

export function productDetail(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id: 'prod-1',
    handle: 'classic-burger',
    title: 'Classic Burger',
    subtitle: 'Two patties',
    description: 'A burger.',
    status: 'active',
    publications: [],
    category: { id: 'cat-1', name: 'Burgers', handle: 'burgers' },
    productType: 'Burger',
    vendor: 'In-house',
    tags: ['beef'],
    seo: { title: null, description: null },
    metadata: {},
    options: [],
    variants: [
      {
        id: 'var-1',
        productId: 'prod-1',
        title: 'Default',
        sku: 'BURG-1',
        barcode: null,
        price: { amount: 599, currency: 'GBP' },
        compareAtPrice: null,
        weightGrams: 0,
        requiresShipping: true,
        position: 0,
        mediaId: null,
        isActive: true,
        isArchived: false,
        options: [],
        createdAt: '2026-02-01T10:00:00.000Z',
        updatedAt: '2026-02-01T10:00:00.000Z',
      },
    ],
    media: [],
    collectionIds: [],
    createdAt: '2026-02-01T10:00:00.000Z',
    updatedAt: '2026-02-02T10:00:00.000Z',
    archivedAt: null,
    ...overrides,
  }
}

/**
 * A product that varies on one axis, with a variant per value.
 *
 * Shaped the way the server returns it: options carry ids, and each variant
 * names its selection by option id *and* by name and value, because the admin
 * displays the names and posts the values.
 */
/**
 * A product whose axis is a colour — the shape the swatch picker exists for.
 *
 * Deliberately mixed: one shade has a colour and one does not, because "nobody
 * has said yet" is the state the card has to render honestly rather than as a
 * grey dot.
 */
export function productWithShades(overrides: Partial<ProductDetail> = {}): ProductDetail {
  const shades = [
    { id: 'val-mulberry', value: 'Mulberry', position: 0, swatchHex: '#7b2d4e' },
    { id: 'val-sand', value: 'Sand', position: 1, swatchHex: null },
  ]

  const base = productWithOptions({
    options: [{ id: 'opt-shade', name: 'Shade', position: 0, values: shades }],
  })

  return {
    ...base,
    variants: base.variants.map((variant, index) => ({
      ...variant,
      title: shades[index]!.value,
      options: [
        {
          optionId: 'opt-shade',
          name: 'Shade',
          valueId: shades[index]!.id,
          value: shades[index]!.value,
        },
      ],
    })),
    ...overrides,
  }
}

export function productWithOptions(overrides: Partial<ProductDetail> = {}): ProductDetail {
  const sizes = [
    { id: 'val-small', value: 'Small', position: 0, swatchHex: null },
    { id: 'val-large', value: 'Large', position: 1, swatchHex: null },
  ]

  return productDetail({
    id: 'prod-2',
    handle: 'pizza',
    title: 'Pizza',
    options: [{ id: 'opt-size', name: 'Size', position: 0, values: sizes }],
    variants: sizes.map((size, index) => ({
      id: `var-${size.value.toLowerCase()}`,
      productId: 'prod-2',
      title: size.value,
      sku: `PIZZA-${size.value.toUpperCase()}`,
      barcode: null,
      price: { amount: index === 0 ? 800 : 1200, currency: 'GBP' },
      compareAtPrice: null,
      weightGrams: 0,
      requiresShipping: true,
      position: index,
      mediaId: null,
      isActive: true,
      isArchived: false,
      options: [{ optionId: 'opt-size', name: 'Size', valueId: size.id, value: size.value }],
      createdAt: '2026-02-01T10:00:00.000Z',
      updatedAt: '2026-02-01T10:00:00.000Z',
    })),
    ...overrides,
  })
}

/** From `adminInventoryItemDto`, for one variant at one location. */
export function variantInventory(
  overrides: Partial<VariantInventory> = {},
): VariantInventory {
  return {
    id: 'inv-1',
    variantId: 'var-1',
    trackInventory: true,
    lowStockThreshold: null,
    effectiveLowStockThreshold: 5,
    totals: { onHand: 20, reserved: 2, available: 18 },
    isLow: false,
    levels: [
      {
        locationId: 'loc-1',
        locationCode: 'MAIN',
        locationName: 'Main store',
        onHand: 20,
        reserved: 2,
        available: 18,
        updatedAt: '2026-02-02T10:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

export function category(overrides: Partial<Category> = {}): Category {
  return {
    id: 'cat-1',
    parentId: null,
    name: 'Burgers',
    handle: 'burgers',
    description: null,
    imageId: null,
    position: 0,
    isActive: true,
    isArchived: false,
    createdAt: '2026-01-10T00:00:00.000Z',
    updatedAt: '2026-01-10T00:00:00.000Z',
    ...overrides,
  }
}

export const defaultPagination = {
  page: 1,
  limit: 20,
  total: 1,
  totalPages: 1,
  hasNext: false,
  hasPrev: false,
}

/** From `adminOrderCardDto`. */
export function orderSummary(
  overrides: Partial<OrderSummary> = {},
): OrderSummary {
  return {
    id: 'ord-1',
    orderNumber: '#1001',
    customerId: null,
    email: 'buyer@example.test',
    status: 'pending',
    paymentStatus: 'pending',
    fulfillmentStatus: 'unfulfilled',
    displayStatus: 'awaiting_payment',
    total: { amount: 1598, currency: 'GBP' },
    refundedTotal: { amount: 0, currency: 'GBP' },
    tags: [],
    paymentMethod: 'cod',
    source: 'storefront',
    placedAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  }
}

/** From `adminOrderDto`. */
export function orderDetail(
  overrides: Partial<OrderDetail> = {},
): OrderDetail {
  return {
    id: 'ord-1',
    orderNumber: '#1001',
    customerId: null,
    email: 'buyer@example.test',
    phone: null,
    status: 'pending',
    paymentStatus: 'pending',
    fulfillmentStatus: 'unfulfilled',
    displayStatus: 'awaiting_payment',
    currency: 'GBP',
    totals: {
      subtotal: { amount: 1198, currency: 'GBP' },
      discountTotal: { amount: 100, currency: 'GBP' },
      taxTotal: { amount: 0, currency: 'GBP' },
      shippingTotal: { amount: 500, currency: 'GBP' },
      paymentFee: { amount: 0, currency: 'GBP' },
      total: { amount: 1598, currency: 'GBP' },
      refundedTotal: { amount: 0, currency: 'GBP' },
    },
    items: [
      {
        id: 'line-1',
        productTitle: 'Classic Burger',
        variantTitle: 'Default',
        sku: 'BURG-1',
        imageUrl: null,
        options: [],
        quantity: 2,
        unitPrice: { amount: 599, currency: 'GBP' },
        subtotal: { amount: 1198, currency: 'GBP' },
        discount: { amount: 100, currency: 'GBP' },
        tax: { amount: 0, currency: 'GBP' },
        total: { amount: 1098, currency: 'GBP' },
        requiresShipping: true,
        fulfilledQuantity: 0,
        refundedQuantity: 0,
        productId: 'prod-1',
        variantId: 'var-1',
      },
    ],
    addresses: [
      {
        type: 'shipping',
        firstName: 'Ada',
        lastName: 'Buyer',
        company: null,
        line1: '1 High Street',
        line2: null,
        city: 'Leeds',
        region: null,
        postalCode: 'LS1 1AA',
        countryCode: 'GB',
        phone: null,
      },
    ],
    discounts: [
      {
        id: 'od-1',
        discountId: 'disc-1',
        code: 'WELCOME',
        type: 'fixed_amount',
        value: 100,
        amount: { amount: 100, currency: 'GBP' },
      },
    ],
    shippingMethodId: 'ship-1',
    shippingMethodName: 'Standard',
    paymentMethod: 'cod',
    customerNote: null,
    adminNote: null,
    tags: [],
    cancelReason: null,
    source: 'storefront',
    placedAt: '2026-03-01T10:00:00.000Z',
    confirmedAt: null,
    cancelledAt: null,
    completedAt: null,
    updatedAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  }
}

/** From `returnCardDto`. */
export function returnSummary(overrides: Partial<ReturnSummary> = {}): ReturnSummary {
  return {
    id: 'ret-1',
    returnNumber: 'R1001',
    orderId: 'ord-1',
    customerId: null,
    status: 'requested',
    reason: 'damaged',
    refunded: false,
    requestedAt: '2026-03-02T10:00:00.000Z',
    closedAt: null,
    ...overrides,
  }
}

/** From `adminReturnDto`. */
export function returnDetail(overrides: Partial<ReturnDetail> = {}): ReturnDetail {
  return {
    id: 'ret-1',
    returnNumber: 'R1001',
    order: { id: 'ord-1', orderNumber: '#1001', email: 'buyer@example.test', currency: 'GBP' },
    customerId: null,
    status: 'requested',
    reason: 'damaged',
    customerNote: 'Cracked in the post.',
    staffNote: null,
    refundId: null,
    lines: [
      {
        id: 'rl-1',
        orderItemId: 'line-1',
        quantity: 2,
        receivedQuantity: 0,
        restockedQuantity: 0,
        condition: null,
      },
    ],
    requestedAt: '2026-03-02T10:00:00.000Z',
    approvedAt: null,
    receivedAt: null,
    closedAt: null,
    updatedAt: '2026-03-02T10:00:00.000Z',
    ...overrides,
  }
}

/** From `GET /admin/orders/:id/refundable`. */
export function refundable(overrides: Partial<Refundable> = {}): Refundable {
  return {
    currency: 'GBP',
    maxRefundable: { amount: 1598, currency: 'GBP' },
    shippingTotal: { amount: 500, currency: 'GBP' },
    payments: [{ id: 'pay-1', method: 'cod', refundable: { amount: 1598, currency: 'GBP' } }],
    lines: [
      {
        orderItemId: 'line-1',
        productTitle: 'Classic Burger',
        variantTitle: 'Default',
        sku: 'BURG-1',
        quantity: 2,
        refundedQuantity: 0,
        refundableQuantity: 2,
        perUnit: { amount: 549, currency: 'GBP' },
        lineRefundable: { amount: 1098, currency: 'GBP' },
      },
    ],
    ...overrides,
  }
}

// ── Customers ───────────────────────────────────────────────────────────────

/** From `adminCustomerDto`. */
export function customerSummary(overrides: Partial<CustomerSummary> = {}): CustomerSummary {
  return {
    id: 'cus-1',
    email: 'grace@example.com',
    firstName: 'Grace',
    lastName: 'Hopper',
    phone: null,
    emailVerified: true,
    status: 'active',
    tags: ['vip'],
    adminNote: null,
    taxExempt: false,
    locale: null,
    marketing: { email: 'subscribed', sms: 'not_subscribed', optInLevel: 'confirmed_opt_in' },
    ordersCount: 3,
    totalSpent: { amount: 12_000, currency: 'GBP' },
    averageOrderValue: { amount: 4_000, currency: 'GBP' },
    firstOrderAt: '2026-01-04T10:00:00.000Z',
    lastOrderAt: '2026-03-01T10:00:00.000Z',
    createdAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  }
}

export function customerDetail(overrides: Partial<CustomerDetail> = {}): CustomerDetail {
  return {
    ...customerSummary(),
    addresses: [
      {
        id: 'adr-1',
        label: 'Home',
        firstName: 'Grace',
        lastName: 'Hopper',
        company: null,
        line1: '1 Navy Yard',
        line2: null,
        city: 'Arlington',
        region: null,
        postalCode: 'VA1',
        countryCode: 'GB',
        phone: null,
        isDefault: true,
      },
    ],
    ...overrides,
  }
}

export function customerEvent(overrides: Partial<CustomerEvent> = {}): CustomerEvent {
  return {
    id: 'evt-1',
    kind: 'note',
    body: 'Rang about the delayed order.',
    actorUserId: 'user-admin',
    actorName: 'admin@example.com',
    metadata: {},
    at: '2026-03-02T09:00:00.000Z',
    ...overrides,
  }
}

export function customerSegment(overrides: Partial<CustomerSegment> = {}): CustomerSegment {
  return {
    id: 'seg-1',
    name: 'Big spenders',
    description: null,
    rules: { match: 'all', conditions: [{ field: 'totalSpent', operator: 'gte', value: 5000 }] },
    isActive: true,
    memberCount: 12,
    summary: 'Total spent is at least 5000',
    createdAt: '2026-02-01T10:00:00.000Z',
    updatedAt: '2026-02-01T10:00:00.000Z',
    ...overrides,
  }
}

/** From `ruleFieldCatalogue()`. The admin never writes this table itself. */
export function ruleFields(): RuleField[] {
  return [
    {
      key: 'email',
      label: 'Email',
      type: 'text',
      operators: ['equals', 'not_equals', 'contains', 'is_set', 'is_not_set'],
    },
    {
      key: 'totalSpent',
      label: 'Total spent',
      type: 'money',
      operators: ['equals', 'gt', 'gte', 'lt', 'lte'],
      hint: 'In minor units — 5000 is £50.',
    },
    {
      key: 'marketingEmail',
      label: 'Email marketing',
      type: 'enum',
      operators: ['equals', 'not_equals', 'in', 'not_in'],
      options: ['not_subscribed', 'pending', 'subscribed', 'unsubscribed'],
    },
  ]
}

// ── Collections ─────────────────────────────────────────────────────────────

/** From `adminCollectionDto`, with the live count the list endpoint adds. */
export function collectionSummary(
  overrides: Partial<CollectionSummary> = {},
): CollectionSummary {
  return {
    id: 'col-1',
    handle: 'best-sellers',
    title: 'Best sellers',
    description: null,
    imageId: null,
    type: 'manual',
    rules: { match: 'all', conditions: [] },
    position: 0,
    isActive: true,
    isArchived: false,
    seo: { title: null, description: null },
    productCount: 3,
    createdAt: '2026-02-01T10:00:00.000Z',
    updatedAt: '2026-02-01T10:00:00.000Z',
    ...overrides,
  }
}

export function smartCollection(overrides: Partial<CollectionSummary> = {}): CollectionSummary {
  return collectionSummary({
    id: 'col-2',
    handle: 'under-50',
    title: 'Under £50',
    type: 'dynamic',
    rules: { match: 'all', conditions: [{ field: 'price', operator: 'lt', value: 5000 }] },
    summary: 'Price is less than 5000',
    productCount: 7,
    ...overrides,
  })
}

export function collectionDetail(overrides: Partial<CollectionDetail> = {}): CollectionDetail {
  return { ...collectionSummary(), productIds: ['prod-1'], ...overrides }
}

/** From `ruleFieldCatalogue()` in products.rules.ts. */
export function productRuleFields(): RuleField[] {
  return [
    {
      key: 'title',
      label: 'Title',
      type: 'text',
      operators: ['equals', 'not_equals', 'contains', 'is_set', 'is_not_set'],
    },
    {
      key: 'price',
      label: 'Price',
      type: 'money',
      operators: ['equals', 'gt', 'gte', 'lt', 'lte'],
      hint: 'The cheapest live variant, in minor units — 5000 is £50.',
    },
    {
      key: 'tags',
      label: 'Tags',
      type: 'array',
      operators: ['contains', 'not_contains', 'is_set', 'is_not_set'],
    },
  ]
}

// ── Inventory ───────────────────────────────────────────────────────────────

/** From `adminItemSummaryDto`. Carries the identity of what it counts. */
export function inventoryRow(
  overrides: Partial<InventoryItemSummary> = {},
): InventoryItemSummary {
  return {
    id: 'inv-1',
    variantId: 'var-1',
    productId: 'prod-1',
    productTitle: 'Classic Burger',
    variantTitle: 'Brioche',
    sku: 'BURG-1',
    trackInventory: true,
    lowStockThreshold: null,
    effectiveLowStockThreshold: 5,
    totals: { onHand: 20, reserved: 2, available: 18 },
    isLow: false,
    ...overrides,
  }
}

export function inventoryItem(
  overrides: Partial<InventoryItemDetail> = {},
): InventoryItemDetail {
  return {
    id: 'inv-1',
    variantId: 'var-1',
    productId: 'prod-1',
    productTitle: 'Classic Burger',
    variantTitle: 'Brioche',
    sku: 'BURG-1',
    trackInventory: true,
    lowStockThreshold: null,
    effectiveLowStockThreshold: 5,
    totals: { onHand: 20, reserved: 2, available: 18 },
    isLow: false,
    levels: [
      {
        locationId: 'loc-1',
        locationCode: 'main',
        locationName: 'Main stockroom',
        onHand: 20,
        reserved: 2,
        available: 18,
        updatedAt: '2026-03-01T10:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

export function stockLocation(overrides: Partial<StockLocation> = {}): StockLocation {
  return {
    id: 'loc-1',
    code: 'main',
    name: 'Main stockroom',
    address: null,
    isActive: true,
    isDefault: true,
    position: 0,
    isArchived: false,
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  }
}

/** An active reservation, as `GET /admin/inventory/items/:id/reservations` sends it. */
export function stockReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 'res-1',
    inventoryItemId: 'inv-1',
    locationId: 'loc-1',
    quantity: 2,
    status: 'active',
    owner: { type: 'order', id: 'ord-1' },
    orderNumber: '#1042',
    expiresAt: '2026-03-02T10:00:00.000Z',
    resolvedAt: null,
    createdAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  }
}

export function stockMovement(overrides: Partial<StockMovement> = {}): StockMovement {
  return {
    id: 'mov-1',
    inventoryItemId: 'inv-1',
    locationId: 'loc-1',
    delta: { onHand: 12, reserved: 0 },
    resulting: { onHand: 20, reserved: 2 },
    reason: 'receive',
    reference: { type: null, id: null },
    actorUserId: 'user-admin',
    note: null,
    createdAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  }
}

// ── Settings, staff and the audit trail ─────────────────────────────────────

/**
 * The owner. Holds what `adminUser` does plus the four permissions the settings
 * section needs — a distinction the screens depend on, since `settings:read`
 * and `audit:read` are deliberately not part of running the catalogue.
 */
export const ownerUser: CurrentUser = {
  ...adminUser,
  id: 'user-owner',
  email: 'owner@example.com',
  firstName: 'Olive',
  lastName: 'Owner',
  roles: ['owner'],
  permissions: [
    ...adminUser.permissions,
    'settings:read',
    'settings:write',
    'staff:read',
    'staff:write',
    'roles:assign',
    'audit:read',
    'discounts:read',
    'discounts:write',
    'analytics:read',
  ],
  sessionId: 'session-owner',
}

export function storeSettings(overrides: Partial<StoreSettings> = {}): StoreSettings {
  return {
    storeName: 'Copperleaf',
    contactEmail: 'hello@copperleaf.test',
    supportUrl: null,
    supportPhone: null,
    currency: 'GBP',
    timezone: 'Europe/London',
    weightUnit: 'g',
    taxRateBps: 2000,
    pricesIncludeTax: false,
    defaultLowStockThreshold: 5,
    orderNumberPrefix: '#',
    reservationTtlMinutes: 60,
    guestCheckoutEnabled: true,
    codEnabled: false,
    codMinSubtotalCents: 0,
    codMaxSubtotalCents: null,
    codFeeCents: 0,
    codCountryCodes: [],
    codRequiresAccount: false,
    codMaxOpenOrders: null,
    orderReservationHours: 72,
    logoMediaId: null,
    metadata: {},
    updatedAt: '2026-03-01T10:00:00.000Z',
    updatedBy: 'user-owner',
    ...overrides,
  }
}

export function staffMember(overrides: Partial<StaffMember> = {}): StaffMember {
  return {
    id: 'user-staff',
    email: 'sam@example.com',
    firstName: 'Sam',
    lastName: 'Staff',
    status: 'active',
    emailVerified: true,
    roles: ['staff'],
    lastLoginAt: '2026-03-01T09:00:00.000Z',
    createdAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  }
}

export function role(overrides: Partial<Role> = {}): Role {
  return {
    key: 'staff',
    name: 'Staff',
    description: 'Day-to-day operations.',
    permissions: ['orders:read', 'catalog:read'],
    ...overrides,
  }
}

export function auditRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: '1',
    action: 'store_settings.updated',
    resourceType: 'store_settings',
    resourceId: 'settings',
    actor: {
      userId: 'user-owner',
      email: 'owner@example.com',
      roles: ['owner'],
      ip: '203.0.113.7',
    },
    before: { taxRateBps: 2000 },
    after: { taxRateBps: 500 },
    requestId: 'req-1',
    createdAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  }
}

export function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    current: true,
    userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140.0',
    ip: '203.0.113.7',
    createdAt: '2026-03-01T09:00:00.000Z',
    expiresAt: '2026-03-31T09:00:00.000Z',
    ...overrides,
  }
}

// ── Shipping ────────────────────────────────────────────────────────────────

export function shippingZone(overrides: Partial<ShippingZone> = {}): ShippingZone {
  return {
    id: 'zone-1',
    name: 'United Kingdom',
    countryCodes: ['GB'],
    position: 0,
    isActive: true,
    isArchived: false,
    ...overrides,
  }
}

export function shippingMethod(overrides: Partial<ShippingMethod> = {}): ShippingMethod {
  return {
    id: 'method-1',
    zoneId: 'zone-1',
    name: 'Standard',
    description: 'Tracked, signed for',
    rateType: 'flat',
    priceCents: 499,
    freeOverSubtotalCents: null,
    minWeightGrams: null,
    maxWeightGrams: null,
    estimatedDaysMin: 2,
    estimatedDaysMax: 4,
    position: 0,
    isActive: true,
    ...overrides,
  }
}

export function rateQuote(overrides: Partial<RateQuote> = {}): RateQuote {
  return {
    id: 'method-1',
    name: 'Standard',
    description: 'Tracked, signed for',
    price: { amount: 499, currency: 'GBP' },
    estimatedDaysMin: 2,
    estimatedDaysMax: 4,
    ...overrides,
  }
}

// ── Discounts ───────────────────────────────────────────────────────────────

/**
 * From `discountDto`. `value` is basis points here because the type is
 * `percentage` — 2500 would be 25%, and 2500 on a `fixed_amount` would be
 * £25.00. Every fixture below states which it means.
 */
export function discountSummary(overrides: Partial<DiscountSummary> = {}): DiscountSummary {
  return {
    id: 'disc-1',
    code: 'SUMMER25',
    title: 'Summer sale',
    type: 'percentage',
    value: 2500,
    appliesTo: 'order',
    minSubtotalCents: 0,
    startsAt: null,
    endsAt: null,
    usageLimitTotal: null,
    usageLimitPerCustomer: null,
    usageCount: 0,
    requiresCustomer: false,
    isActive: true,
    status: 'active',
    archivedAt: null,
    createdAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  }
}

export function discountDetail(overrides: Partial<DiscountDetail> = {}): DiscountDetail {
  return {
    ...discountSummary(),
    productIds: [],
    categoryIds: [],
    ...overrides,
  }
}

export function redemption(overrides: Partial<Redemption> = {}): Redemption {
  return {
    id: 'red-1',
    orderId: 'ord-1',
    orderNumber: '#1042',
    customerId: 'cust-1',
    customerEmail: 'buyer@example.test',
    amount: { amount: 500, currency: 'GBP' },
    createdAt: '2026-03-02T10:00:00.000Z',
    ...overrides,
  }
}

// ── Baskets and checkout attempts ───────────────────────────────────────────

export function cartSummary(overrides: Partial<CartSummary> = {}): CartSummary {
  return {
    id: 'cart-1',
    status: 'abandoned',
    customerId: 'cust-1',
    customerEmail: 'lost@example.test',
    customerName: 'Lost Shopper',
    itemCount: 3,
    value: { amount: 4500, currency: 'GBP' },
    lastActivityAt: '2026-03-01T10:00:00.000Z',
    expiresAt: '2026-03-31T10:00:00.000Z',
    convertedOrderId: null,
    createdAt: '2026-03-01T09:00:00.000Z',
    ...overrides,
  }
}

export function cartDetail(overrides: Partial<CartDetail> = {}): CartDetail {
  return {
    id: 'cart-1',
    status: 'abandoned',
    currency: 'GBP',
    customer: { id: 'cust-1', email: 'lost@example.test', name: 'Lost Shopper' },
    lines: [
      {
        variantId: 'var-1',
        productId: 'prod-1',
        productTitle: 'Classic Burger',
        variantTitle: 'Brioche',
        sku: 'BURG-1',
        imageUrl: null,
        quantity: 3,
        unitPrice: { amount: 1500, currency: 'GBP' },
        lineTotal: { amount: 4500, currency: 'GBP' },
        purchasable: true,
        problem: null,
      },
    ],
    totals: { subtotal: { amount: 4500, currency: 'GBP' }, itemCount: 3 },
    purchasable: true,
    lastActivityAt: '2026-03-01T10:00:00.000Z',
    expiresAt: '2026-03-31T10:00:00.000Z',
    convertedOrderId: null,
    createdAt: '2026-03-01T09:00:00.000Z',
    ...overrides,
  }
}

export function checkoutAttempt(overrides: Partial<CheckoutAttempt> = {}): CheckoutAttempt {
  return {
    id: 'att-1',
    cartId: 'cart-1',
    customerId: null,
    email: 'buyer@example.test',
    orderId: 'ord-1',
    outcome: 'placed',
    failureCode: null,
    failureMessage: null,
    subtotal: { amount: 4500, currency: 'GBP' },
    itemCount: 3,
    paymentMethod: 'cod',
    countryCode: 'GB',
    createdAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  }
}

export function attemptSummary(overrides: Partial<AttemptSummary> = {}): AttemptSummary {
  return {
    from: '2026-02-22T10:00:00.000Z',
    to: '2026-03-01T10:00:00.000Z',
    placed: 80,
    failed: 20,
    reasons: [
      { code: 'INSUFFICIENT_STOCK', count: 12 },
      { code: 'DISCOUNT_INVALID', count: 8 },
    ],
    ...overrides,
  }
}

// ── Draft orders ────────────────────────────────────────────────────────────

export function draftSummary(overrides: Partial<DraftSummary> = {}): DraftSummary {
  return {
    id: 'draft-1',
    reference: 'DRAFT-AB12CD',
    customerId: null,
    email: 'phone@example.test',
    customerNote: null,
    subtotal: { amount: 4500, currency: 'GBP' },
    draftedBy: 'user-admin',
    placedOrderId: null,
    placedFromDraftAt: null,
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  }
}

/**
 * A draft that is ready to place.
 *
 * Every figure is one the server computed — `total` is not `subtotal` plus the
 * others added up here, it is what `checkoutService.preview` returned for this
 * basket. Tests that assert on it are asserting that the screen shows what it
 * was told.
 */
export function draftDetail(overrides: Partial<DraftDetail> = {}): DraftDetail {
  return {
    ...draftSummary(),
    phone: null,
    paymentMethod: 'manual',
    shippingMethodId: 'method-1',
    discountCode: null,
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
    lines: [
      {
        variantId: 'var-1',
        productId: 'prod-1',
        productTitle: 'Classic Burger',
        variantTitle: 'Brioche',
        sku: 'BURG-1',
        imageUrl: null,
        quantity: 3,
        unitPrice: { amount: 1500, currency: 'GBP' },
        lineTotal: { amount: 4500, currency: 'GBP' },
        purchasable: true,
        problem: null,
      },
    ],
    discountTotal: { amount: 0, currency: 'GBP' },
    shippingTotal: { amount: 499, currency: 'GBP' },
    taxTotal: { amount: 450, currency: 'GBP' },
    paymentFee: { amount: 0, currency: 'GBP' },
    total: { amount: 5449, currency: 'GBP' },
    shippingOptions: [
      {
        methodId: 'method-1',
        name: 'Standard',
        description: null,
        amount: { amount: 499, currency: 'GBP' },
        estimatedDaysMin: 2,
        estimatedDaysMax: 4,
      },
    ],
    paymentMethods: [
      {
        key: 'manual',
        label: 'Recorded by staff',
        description: 'A payment received outside the store and entered by hand.',
        fee: { amount: 0, currency: 'GBP' },
      },
      {
        key: 'cod',
        label: 'Cash on delivery',
        description: 'Pay the courier in cash when your order arrives.',
        fee: { amount: 200, currency: 'GBP' },
      },
    ],
    purchasable: true,
    blockers: [],
    ...overrides,
  }
}

export function variantMatch(overrides: Partial<VariantMatch> = {}): VariantMatch {
  return {
    variantId: 'var-2',
    productId: 'prod-2',
    productTitle: 'Halloumi Wrap',
    variantTitle: 'Regular',
    sku: 'WRAP-1',
    price: { amount: 900, currency: 'GBP' },
    ...overrides,
  }
}
