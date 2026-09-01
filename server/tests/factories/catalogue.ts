/**
 * Catalogue fixtures (§20.3).
 *
 * Products are created through the real HTTP surface rather than by INSERT, so
 * schema drift breaks the factory rather than forty assertions, and so every
 * test exercises the same validation a real client would hit.
 */
import type { Express } from 'express'
import request from 'supertest'
import { bearer } from './auth.js'

let counter = 0
export function uniqueHandle(prefix = 'product'): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter}`
}

export interface CreatedProduct {
  id: string
  handle: string
  variants: { id: string; title: string; price: { amount: number; currency: string } }[]
  options: { id: string; name: string; values: { id: string; value: string }[] }[]
  body: Record<string, any>
}

/** A product with no options: one `Default` variant. The burger case. */
export async function createSimpleProduct(
  app: Express,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<CreatedProduct> {
  const res = await request(app)
    .post('/api/v1/admin/products')
    .set('Authorization', bearer(token))
    .send({
      title: 'Classic Burger',
      handle: uniqueHandle('classic-burger'),
      variants: [{ priceAmount: 599 }],
      ...overrides,
    })

  if (res.status !== 201) {
    throw new Error(`createSimpleProduct failed (${res.status}): ${JSON.stringify(res.body)}`)
  }
  return {
    id: res.body.data.id,
    handle: res.body.data.handle,
    variants: res.body.data.variants,
    options: res.body.data.options,
    body: res.body.data,
  }
}

/**
 * A product varying on two axes — the pizza case, six variants from
 * 3 sizes × 2 crusts. This is the shape the whole model exists for.
 */
export async function createPizza(
  app: Express,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<CreatedProduct> {
  const sizes = ['Small', 'Medium', 'Large']
  const crusts = ['Classic', 'Thin']
  const basePrice: Record<string, number> = { Small: 799, Medium: 1099, Large: 1399 }

  const variants = sizes.flatMap((size) =>
    crusts.map((crust) => ({
      priceAmount: basePrice[size]! + (crust === 'Thin' ? 50 : 0),
      options: { Size: size, Crust: crust },
    })),
  )

  const res = await request(app)
    .post('/api/v1/admin/products')
    .set('Authorization', bearer(token))
    .send({
      title: 'Pepperoni Pizza',
      handle: uniqueHandle('pepperoni-pizza'),
      options: [
        { name: 'Size', values: sizes },
        { name: 'Crust', values: crusts },
      ],
      variants,
      ...overrides,
    })

  if (res.status !== 201) {
    throw new Error(`createPizza failed (${res.status}): ${JSON.stringify(res.body)}`)
  }
  return {
    id: res.body.data.id,
    handle: res.body.data.handle,
    variants: res.body.data.variants,
    options: res.body.data.options,
    body: res.body.data,
  }
}

/** Activates and publishes, i.e. makes a product visible to the storefront. */
export async function publishProduct(
  app: Express,
  token: string,
  productId: string,
): Promise<void> {
  const activate = await request(app)
    .post(`/api/v1/admin/products/${productId}/activate`)
    .set('Authorization', bearer(token))
  if (activate.status !== 200) {
    throw new Error(`activate failed (${activate.status}): ${JSON.stringify(activate.body)}`)
  }

  const publish = await request(app)
    .post(`/api/v1/admin/products/${productId}/publish`)
    .set('Authorization', bearer(token))
    .send({})
  if (publish.status !== 200) {
    throw new Error(`publish failed (${publish.status}): ${JSON.stringify(publish.body)}`)
  }
}

export async function createCategory(
  app: Express,
  token: string,
  body: Record<string, unknown> = {},
): Promise<{ id: string; handle: string }> {
  const res = await request(app)
    .post('/api/v1/admin/categories')
    .set('Authorization', bearer(token))
    .send({ name: 'Burgers', handle: uniqueHandle('burgers'), ...body })
  if (res.status !== 201) {
    throw new Error(`createCategory failed (${res.status}): ${JSON.stringify(res.body)}`)
  }
  return { id: res.body.data.id, handle: res.body.data.handle }
}

export async function createCollection(
  app: Express,
  token: string,
  body: Record<string, unknown> = {},
): Promise<{ id: string; handle: string }> {
  const res = await request(app)
    .post('/api/v1/admin/collections')
    .set('Authorization', bearer(token))
    .send({ title: 'Best Sellers', handle: uniqueHandle('best-sellers'), ...body })
  if (res.status !== 201) {
    throw new Error(`createCollection failed (${res.status}): ${JSON.stringify(res.body)}`)
  }
  return { id: res.body.data.id, handle: res.body.data.handle }
}

/**
 * Receives stock for every variant of a product.
 *
 * Needed by any test that expects a product to be *purchasable*: a variant is
 * tracked by default, and a tracked variant with no stock is correctly
 * unavailable. Stocking it is what a shop does before selling it.
 */
export async function stockProduct(
  app: Express,
  token: string,
  product: CreatedProduct,
  quantity = 10,
): Promise<void> {
  for (const variant of product.variants) {
    const res = await request(app)
      .post('/api/v1/admin/inventory/adjustments')
      .set('Authorization', bearer(token))
      .send({ variantId: variant.id, delta: quantity, reason: 'receive' })
    if (res.status !== 201) {
      throw new Error(`stockProduct failed (${res.status}): ${JSON.stringify(res.body)}`)
    }
  }
}

/** Marks every variant of a product as untracked — a made-to-order item. */
export async function untrackProduct(
  app: Express,
  token: string,
  product: CreatedProduct,
): Promise<void> {
  for (const variant of product.variants) {
    const item = await request(app)
      .get(`/api/v1/admin/inventory/variants/${variant.id}`)
      .set('Authorization', bearer(token))
    await request(app)
      .patch(`/api/v1/admin/inventory/items/${item.body.data.id}`)
      .set('Authorization', bearer(token))
      .send({ trackInventory: false })
  }
}
