/**
 * Commerce fixtures (§20.3).
 *
 * Everything here goes through the real HTTP surface, for the same reason the
 * catalogue factory does: a schema change breaks the factory rather than forty
 * assertions, and every test exercises the validation a real client would hit.
 *
 * The one thing these helpers deliberately do *not* do is set prices, totals or
 * stock by INSERT. A test that seeds a total by hand is a test that would keep
 * passing after checkout stopped computing one.
 */
import type { Express } from 'express'
import request from 'supertest'
import { execute } from '../../src/infrastructure/database/query.js'
import { settingsService } from '../../src/features/settings/index.js'
import { bearer } from './auth.js'
import { createSimpleProduct, publishProduct, uniqueHandle, type CreatedProduct } from './catalogue.js'

export const GB_ADDRESS = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  line1: '1 Analytical Way',
  city: 'London',
  postalCode: 'E1 1AA',
  countryCode: 'GB',
}

/** A product that is active, published and has stock — i.e. actually buyable. */
export async function sellableProduct(
  app: Express,
  token: string,
  options: { priceAmount?: number; quantity?: number; weightGrams?: number; requiresShipping?: boolean } = {},
): Promise<CreatedProduct> {
  const product = await createSimpleProduct(app, token, {
    handle: uniqueHandle('sellable'),
    variants: [
      {
        priceAmount: options.priceAmount ?? 5000,
        weightGrams: options.weightGrams ?? 500,
        requiresShipping: options.requiresShipping ?? true,
      },
    ],
  })
  await publishProduct(app, token, product.id)

  const quantity = options.quantity ?? 10
  if (quantity > 0) {
    const res = await request(app)
      .post('/api/v1/admin/inventory/adjustments')
      .set('Authorization', bearer(token))
      .send({ variantId: product.variants[0]!.id, delta: quantity, reason: 'receive' })
    if (res.status !== 201) {
      throw new Error(`stocking failed (${res.status}): ${JSON.stringify(res.body)}`)
    }
  }
  return product
}

export async function createShippingMethod(
  app: Express,
  token: string,
  options: { countryCodes?: string[]; priceCents?: number; rateType?: string; freeOverSubtotalCents?: number } = {},
): Promise<{ zoneId: string; methodId: string }> {
  const zone = await request(app)
    .post('/api/v1/admin/shipping/zones')
    .set('Authorization', bearer(token))
    .send({ name: `Zone ${Math.random().toString(36).slice(2, 8)}`, countryCodes: options.countryCodes ?? ['GB'] })
  if (zone.status !== 201) {
    throw new Error(`zone failed (${zone.status}): ${JSON.stringify(zone.body)}`)
  }

  const method = await request(app)
    .post('/api/v1/admin/shipping/methods')
    .set('Authorization', bearer(token))
    .send({
      zoneId: zone.body.data.id,
      name: 'Standard',
      rateType: options.rateType ?? 'flat',
      priceCents: options.priceCents ?? 499,
      ...(options.freeOverSubtotalCents === undefined
        ? {}
        : { freeOverSubtotalCents: options.freeOverSubtotalCents }),
    })
  if (method.status !== 201) {
    throw new Error(`method failed (${method.status}): ${JSON.stringify(method.body)}`)
  }
  return { zoneId: zone.body.data.id, methodId: method.body.data.id }
}

export async function createDiscount(
  app: Express,
  token: string,
  body: Record<string, unknown> = {},
): Promise<{ id: string; code: string }> {
  const code = (body.code as string) ?? `SAVE${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  const res = await request(app)
    .post('/api/v1/admin/discounts')
    .set('Authorization', bearer(token))
    .send({ code, title: 'Test discount', type: 'percentage', value: 1000, ...body })
  if (res.status !== 201) {
    throw new Error(`createDiscount failed (${res.status}): ${JSON.stringify(res.body)}`)
  }
  return { id: res.body.data.id, code: res.body.data.code }
}

/**
 * A guest basket.
 *
 * `agent` keeps the cart cookie across requests, which is how a real guest is
 * identified — the tests never pass a cart id, because the API has no route
 * that would accept one.
 */
export function guest(app: Express) {
  return request.agent(app)
}

export async function addToCart(
  agent: ReturnType<typeof guest>,
  variantId: string,
  quantity = 1,
): Promise<request.Response> {
  return agent.post('/api/v1/storefront/cart/items').send({ variantId, quantity })
}

let idempotencyCounter = 0
export function idempotencyKey(): string {
  idempotencyCounter += 1
  return `00000000-0000-4000-8000-${String(idempotencyCounter).padStart(12, '0')}`
}

export interface CheckoutOptions {
  email?: string
  paymentMethod?: string
  shippingMethodId?: string | null
  discountCode?: string | null
  address?: Record<string, unknown>
  token?: string
}

/** Places an order through the real checkout endpoint. */
export async function checkout(
  agent: ReturnType<typeof guest>,
  options: CheckoutOptions = {},
): Promise<request.Response> {
  const req = agent
    .post('/api/v1/storefront/checkout')
    .set('Idempotency-Key', idempotencyKey())
  if (options.token) req.set('Authorization', bearer(options.token))

  return req.send({
    email: options.email ?? 'buyer@example.test',
    paymentMethod: options.paymentMethod ?? 'cod',
    shippingAddress: options.address ?? GB_ADDRESS,
    ...(options.shippingMethodId === undefined ? {} : { shippingMethodId: options.shippingMethodId }),
    ...(options.discountCode ? { discountCode: options.discountCode } : {}),
  })
}

/**
 * Patches store settings directly and drops the cache.
 *
 * Used for the policy knobs — COD limits, tax rate — where going through the
 * admin endpoint would add four lines of noise to every test that needs one.
 * The cache invalidation is the part that is easy to forget and produces a
 * baffling failure two tests later.
 */
export async function setSettings(patch: Record<string, unknown>): Promise<void> {
  const columns: Record<string, string> = {
    codEnabled: 'cod_enabled',
    codMinSubtotalCents: 'cod_min_subtotal_cents',
    codMaxSubtotalCents: 'cod_max_subtotal_cents',
    codFeeCents: 'cod_fee_cents',
    codCountryCodes: 'cod_country_codes',
    codRequiresAccount: 'cod_requires_account',
    codMaxOpenOrders: 'cod_max_open_orders',
    orderReservationHours: 'order_reservation_hours',
    taxRateBps: 'tax_rate_bps',
    pricesIncludeTax: 'prices_include_tax',
    currency: 'currency',
  }
  const sets: string[] = []
  const params: unknown[] = []
  for (const [field, column] of Object.entries(columns)) {
    if (!(field in patch)) continue
    params.push(patch[field])
    sets.push(`${column} = $${params.length}`)
  }
  if (sets.length === 0) return
  await execute(`UPDATE store_settings SET ${sets.join(', ')} WHERE id = 1`, params)
  settingsService.invalidate()
}

/** Backdates an order, so a sweep that looks at age has something to find. */
export async function backdateOrder(orderId: string, hours: number): Promise<void> {
  await execute(`UPDATE orders SET placed_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [
    orderId,
    String(hours),
  ])
}
