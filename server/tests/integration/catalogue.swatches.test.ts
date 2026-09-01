/**
 * What a colour looks like (migration 0028).
 *
 * The feature is small and the ways it goes wrong are not:
 *
 *   **A swatch belongs to the value, not the variant.** "Mulberry" is the same
 *   colour in the 5g and the 40g, and a model that stored it twice would let
 *   the two copies disagree.
 *
 *   **The column is one spelling.** Lower-case `#rrggbb`, enforced by a CHECK.
 *   The boundary is forgiving — `#FFF` and `FFFFFF` are accepted and
 *   normalised — precisely so the storage never has to be.
 *
 *   **Null is a real answer.** Most options are not colours. A "Size" value has
 *   nothing to put here, and the storefront must fall back to the name rather
 *   than paint a black circle.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { setStorage } from '../../src/infrastructure/storage/index.js'
import { MemoryStorageProvider } from '../../src/infrastructure/storage/providers/memory.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import { makePng } from '../factories/images.js'
import { processImageHandler } from '../../src/jobs/media/processImage.job.js'
import { QUEUES } from '../../src/infrastructure/queue/index.js'
import { createLogger } from '../../src/infrastructure/logging/logger.js'
import { publishProduct, uniqueHandle } from '../factories/catalogue.js'
import {
  describeIfDatabase,
  setupDatabase,
  teardownDatabase,
  truncateAll,
} from '../setup/database.js'

vi.mock('../../src/infrastructure/queue/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof QueueModule>()
  return { ...actual, enqueue: vi.fn(async () => 'stub-job-id') }
})

const app = createApp()
const storage = new MemoryStorageProvider('media-test')

describeIfDatabase('catalogue — option value swatches', () => {
  let admin: Awaited<ReturnType<typeof createUserAndLogin>>

  beforeAll(setupDatabase)
  beforeEach(async () => {
    setStorage(storage)
    storage.clear()
    admin = await createUserAndLogin(app, { roles: ['admin'] })
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(async () => {
    setStorage(undefined)
    await teardownDatabase()
  })

  /**
   * A lipstick in two shades and two sizes — the shape the feature exists for.
   *
   * The variants are derived from the values passed in rather than hard-coded,
   * so a test that renames a shade cannot end up with variants selecting a
   * value that no longer exists.
   */
  async function createLipstick(values: (string | { value: string; swatchHex?: string })[]) {
    const names = values.map((entry) => (typeof entry === 'string' ? entry : entry.value))
    const res = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', bearer(admin.accessToken))
      .send({
        title: 'Velvet Matte Lipstick',
        handle: uniqueHandle('velvet-matte'),
        options: [
          { name: 'Shade', values },
          { name: 'Size', values: ['5 g', '40 g'] },
        ],
        variants: names.flatMap((shade) => [
          { priceAmount: 619500, options: { Shade: shade, Size: '5 g' } },
          { priceAmount: 819500, options: { Shade: shade, Size: '40 g' } },
        ]),
      })
    if (res.status !== 201) {
      throw new Error(`createLipstick failed (${res.status}): ${JSON.stringify(res.body)}`)
    }
    return res.body.data
  }

  // ── Setting one ───────────────────────────────────────────────────────────

  it('accepts a colour when the product is created', async () => {
    const product = await createLipstick([
      { value: 'Mulberry', swatchHex: '#7b2d4e' },
      { value: 'Deep Brown', swatchHex: '#4a2c20' },
    ])

    const shade = product.options.find((option: { name: string }) => option.name === 'Shade')
    expect(shade.values.map((value: { value: string; swatchHex: string }) => value.swatchHex)).toEqual([
      '#7b2d4e',
      '#4a2c20',
    ])
  })

  it('still accepts a bare string, so nothing that worked before stops working', async () => {
    const product = await createLipstick(['Mulberry', 'Deep Brown'])

    const shade = product.options.find((option: { name: string }) => option.name === 'Shade')
    expect(shade.values.every((value: { swatchHex: null }) => value.swatchHex === null)).toBe(true)
  })

  it('normalises the three spellings a person actually types', async () => {
    const product = await createLipstick([
      { value: 'Mulberry', swatchHex: '#7B2D4E' },
      { value: 'Deep Brown', swatchHex: '4a2c20' },
    ])

    const shade = product.options.find((option: { name: string }) => option.name === 'Shade')
    // Upper-case folded, missing hash added — one spelling reaches the column.
    expect(shade.values[0].swatchHex).toBe('#7b2d4e')
    expect(shade.values[1].swatchHex).toBe('#4a2c20')
  })

  it('expands three-digit shorthand', async () => {
    const product = await createLipstick([{ value: 'Chalk', swatchHex: '#fff' }, 'Deep Brown'])

    const shade = product.options.find((option: { name: string }) => option.name === 'Shade')
    expect(shade.values[0].swatchHex).toBe('#ffffff')
  })

  it('refuses something that is not a colour, with the shape it wanted', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', bearer(admin.accessToken))
      .send({
        title: 'Bad Swatch',
        handle: uniqueHandle('bad-swatch'),
        options: [{ name: 'Shade', values: [{ value: 'Mulberry', swatchHex: 'mulberry' }] }],
        variants: [{ priceAmount: 100, options: { Shade: 'Mulberry' } }],
      })

    expect(res.status).toBe(422)
    expect(JSON.stringify(res.body)).toContain('#b4622d')
  })

  // ── Changing one on a live product ────────────────────────────────────────

  it('recolours a value on a live product without touching its variants', async () => {
    const product = await createLipstick(['Mulberry', 'Deep Brown'])
    await publishProduct(app, admin.accessToken, product.id)

    const shade = product.options.find((option: { name: string }) => option.name === 'Shade')
    const mulberry = shade.values.find((value: { value: string }) => value.value === 'Mulberry')

    const res = await request(app)
      .patch(`/api/v1/admin/products/${product.id}/options/${shade.id}/values/${mulberry.id}`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ swatchHex: '#7b2d4e' })

    expect(res.status).toBe(200)
    const updated = res.body.data.options.find((option: { name: string }) => option.name === 'Shade')
    expect(
      updated.values.find((value: { value: string }) => value.value === 'Mulberry').swatchHex,
    ).toBe('#7b2d4e')
    // Every variant is still there, still selecting what it selected.
    expect(res.body.data.variants).toHaveLength(4)
  })

  it('clears a colour back to null', async () => {
    const product = await createLipstick([{ value: 'Mulberry', swatchHex: '#7b2d4e' }, 'Deep Brown'])
    const shade = product.options.find((option: { name: string }) => option.name === 'Shade')
    const mulberry = shade.values.find((value: { value: string }) => value.value === 'Mulberry')

    const res = await request(app)
      .patch(`/api/v1/admin/products/${product.id}/options/${shade.id}/values/${mulberry.id}`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ swatchHex: null })

    expect(res.status).toBe(200)
    const updated = res.body.data.options.find((option: { name: string }) => option.name === 'Shade')
    expect(
      updated.values.find((value: { value: string }) => value.value === 'Mulberry').swatchHex,
    ).toBeNull()
  })

  it('refuses a value id that belongs to another product', async () => {
    const mine = await createLipstick(['Mulberry', 'Deep Brown'])
    const theirs = await createLipstick(['Rose', 'Sand'])

    const myShade = mine.options.find((option: { name: string }) => option.name === 'Shade')
    const theirShade = theirs.options.find((option: { name: string }) => option.name === 'Shade')

    const res = await request(app)
      .patch(
        `/api/v1/admin/products/${mine.id}/options/${myShade.id}/values/${theirShade.values[0].id}`,
      )
      .set('Authorization', bearer(admin.accessToken))
      .send({ swatchHex: '#000000' })

    expect(res.status).toBe(404)
  })

  it('needs catalogue write permission', async () => {
    const product = await createLipstick(['Mulberry', 'Deep Brown'])
    const shade = product.options.find((option: { name: string }) => option.name === 'Shade')
    const customer = await createUserAndLogin(app, { roles: ['customer'] })

    const res = await request(app)
      .patch(`/api/v1/admin/products/${product.id}/options/${shade.id}/values/${shade.values[0].id}`)
      .set('Authorization', bearer(customer.accessToken))
      .send({ swatchHex: '#000000' })

    expect(res.status).toBe(403)
  })

  // ── What the storefront sees ──────────────────────────────────────────────

  it('publishes the colour to the storefront', async () => {
    const product = await createLipstick([
      { value: 'Mulberry', swatchHex: '#7b2d4e' },
      { value: 'Deep Brown', swatchHex: '#4a2c20' },
    ])
    await publishProduct(app, admin.accessToken, product.id)

    const res = await request(app).get(`/api/v1/storefront/products/${product.handle}`)

    expect(res.status).toBe(200)
    const shade = res.body.data.options.find((option: { name: string }) => option.name === 'Shade')
    expect(shade.values).toEqual([
      { id: expect.any(String), value: 'Mulberry', swatchHex: '#7b2d4e' },
      { id: expect.any(String), value: 'Deep Brown', swatchHex: '#4a2c20' },
    ])
  })

  it('publishes null for an option that is not a colour', async () => {
    const product = await createLipstick([{ value: 'Mulberry', swatchHex: '#7b2d4e' }, 'Deep Brown'])
    await publishProduct(app, admin.accessToken, product.id)

    const res = await request(app).get(`/api/v1/storefront/products/${product.handle}`)

    const size = res.body.data.options.find((option: { name: string }) => option.name === 'Size')
    expect(size.values.every((value: { swatchHex: null }) => value.swatchHex === null)).toBe(true)
  })

  // ── The other half: the picture changes too ───────────────────────────────

  /**
   * Uploads an image and attaches it to a product, returning the
   * `product_media` id — which is what a variant's `mediaId` points at.
   */
  async function attachImage(productId: string): Promise<string> {
    const bytes = await makePng()
    const ticket = await request(app)
      .post('/api/v1/admin/media/uploads')
      .set('Authorization', bearer(admin.accessToken))
      .send({ contentType: 'image/png', byteSize: bytes.byteLength, filename: 'shade.png' })
    expect(ticket.status).toBe(202)

    await storage.completeUpload(ticket.body.data.upload.token, bytes, 'image/png')
    await request(app)
      .post(`/api/v1/admin/media/${ticket.body.data.assetId}/complete`)
      .set('Authorization', bearer(admin.accessToken))
      .send({})

    // The queue is stubbed in this file, so the processing job is run by hand.
    // Without it the asset stays `processing` and never gets a URL — which is
    // the behaviour `imageUrls` relies on, and the reason attaching would 422.
    await processImageHandler(
      { mediaAssetId: ticket.body.data.assetId },
      {
        jobId: 'job-1',
        queue: QUEUES.MEDIA_PROCESS_IMAGE,
        attempt: 1,
        logger: createLogger('test'),
        signal: new AbortController().signal,
      },
    )

    const attached = await request(app)
      .post(`/api/v1/admin/products/${productId}/media`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ mediaId: ticket.body.data.assetId })
    expect(attached.status).toBe(201)

    const media = attached.body.data.media
    return media[media.length - 1].id
  }

  it('publishes a variant’s own image, so the photo can follow the colour', async () => {
    const product = await createLipstick([
      { value: 'Mulberry', swatchHex: '#7b2d4e' },
      { value: 'Deep Brown', swatchHex: '#4a2c20' },
    ])
    const productMediaId = await attachImage(product.id)

    // Hang it on the Mulberry / 5 g variant only.
    const target = product.variants.find(
      (variant: { title: string }) => variant.title === 'Mulberry / 5 g',
    )
    const patched = await request(app)
      .patch(`/api/v1/admin/variants/${target.id}`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ mediaId: productMediaId })
    expect(patched.status).toBe(200)

    await publishProduct(app, admin.accessToken, product.id)
    const res = await request(app).get(`/api/v1/storefront/products/${product.handle}`)

    const withImage = res.body.data.variants.find((variant: { id: string }) => variant.id === target.id)
    expect(withImage.image).not.toBeNull()
    expect(withImage.image.url).toEqual(expect.any(String))

    // And every other variant says so plainly rather than borrowing that one.
    const others = res.body.data.variants.filter((variant: { id: string }) => variant.id !== target.id)
    expect(others.every((variant: { image: null }) => variant.image === null)).toBe(true)
  })

  it('publishes null when a variant has no image of its own', async () => {
    const product = await createLipstick(['Mulberry', 'Deep Brown'])
    await publishProduct(app, admin.accessToken, product.id)

    const res = await request(app).get(`/api/v1/storefront/products/${product.handle}`)
    expect(res.body.data.variants.every((variant: { image: null }) => variant.image === null)).toBe(
      true,
    )
  })

  it('still exposes no admin-only field alongside the new ones', async () => {
    const product = await createLipstick([{ value: 'Mulberry', swatchHex: '#7b2d4e' }, 'Deep Brown'])
    await publishProduct(app, admin.accessToken, product.id)

    const res = await request(app).get(`/api/v1/storefront/products/${product.handle}`)
    const body = JSON.stringify(res.body)

    // `mediaId` is the admin's pointer; the storefront gets a resolved image or
    // null, never the id it was resolved from.
    expect(body).not.toContain('mediaId')
    expect(body).not.toContain('optionSignature')
  })

  it('appends a value with a colour to a live option', async () => {
    const product = await createLipstick(['Mulberry', 'Deep Brown'])
    const shade = product.options.find((option: { name: string }) => option.name === 'Shade')

    const res = await request(app)
      .post(`/api/v1/admin/products/${product.id}/options/${shade.id}/values`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ value: 'Rose', swatchHex: '#c76b7f' })

    expect(res.status).toBe(201)
    const updated = res.body.data.options.find((option: { name: string }) => option.name === 'Shade')
    expect(
      updated.values.find((value: { value: string }) => value.value === 'Rose').swatchHex,
    ).toBe('#c76b7f')
  })
})
