/**
 * Media: the three-step upload, and what makes it safe (§23.4, §16.3).
 *
 * The whole design rests on one claim — that between "the client uploaded
 * something" and "we serve it", the server actually looks at the bytes. These
 * tests attack that claim: they upload things that lie about their type, things
 * that are not images at all, things with a payload appended after a valid
 * header, and things nobody ever uploaded.
 *
 * Storage is the in-memory provider, driven through the same `StorageProvider`
 * interface the Supabase adapter implements. See `storage.supabase.test.ts` for
 * what that does and does not prove.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { setStorage } from '../../src/infrastructure/storage/index.js'
import { MemoryStorageProvider } from '../../src/infrastructure/storage/providers/memory.js'
import { mediaService } from '../../src/features/media/index.js'
import { processImageHandler } from '../../src/jobs/media/processImage.job.js'
import { cleanupMediaHandler } from '../../src/jobs/media/cleanupMedia.job.js'
import { execute, queryOne } from '../../src/infrastructure/database/query.js'
import { createLogger } from '../../src/infrastructure/logging/logger.js'
import { usersService } from '../../src/features/users/index.js'
import type { JobContext } from '../../src/infrastructure/queue/register.js'
import { QUEUES } from '../../src/infrastructure/queue/queues.js'
import { bearer, createUserAndLogin, eventNames } from '../factories/auth.js'
import { makeJpeg, makeJpegWithExif, makePng, makePolyglotPng } from '../factories/images.js'
import {
  describeIfDatabase,
  setupDatabase,
  teardownDatabase,
  truncateAll,
} from '../setup/database.js'

const enqueued: { queue: string; payload: unknown }[] = []

vi.mock('../../src/infrastructure/queue/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof QueueModule>()
  return {
    ...actual,
    enqueue: vi.fn(async (queue: string, payload: unknown) => {
      enqueued.push({ queue, payload })
      return 'stub-job-id'
    }),
  }
})

const app = createApp()
const storage = new MemoryStorageProvider('media-test')

function jobContext(queue: JobContext['queue'] = QUEUES.MEDIA_PROCESS_IMAGE): JobContext {
  return {
    jobId: 'job-1',
    queue,
    attempt: 1,
    logger: createLogger('test'),
    signal: new AbortController().signal,
  }
}

interface Ticket {
  assetId: string
  token: string
  storageKey: string
}

/** Step 1: ask for somewhere to put bytes. */
async function requestUpload(
  accessToken: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await request(app)
    .post('/api/v1/admin/media/uploads')
    .set('Authorization', bearer(accessToken))
    .send({ contentType: 'image/png', byteSize: 1024, filename: 'photo.png', ...body })
  return { status: res.status, body: res.body }
}

/** Steps 1 and 2: get a ticket and put the bytes where it says. */
async function uploadTo(
  accessToken: string,
  bytes: Buffer,
  options: { contentType?: string; declared?: string } = {},
): Promise<Ticket> {
  const declared = options.declared ?? options.contentType ?? 'image/png'
  const res = await requestUpload(accessToken, { contentType: declared, byteSize: bytes.byteLength })
  expect(res.status).toBe(202)

  const token = res.body.data.upload.token as string
  await storage.completeUpload(token, bytes, options.contentType ?? declared)

  return { assetId: res.body.data.assetId, token, storageKey: res.body.data.storageKey }
}

function complete(accessToken: string, assetId: string) {
  return request(app)
    .post(`/api/v1/admin/media/${assetId}/complete`)
    .set('Authorization', bearer(accessToken))
    .send({})
}

async function assetRow(id: string) {
  return queryOne<{
    status: string
    mime_type: string | null
    declared_mime: string
    byte_size: number | null
    failure_reason: string | null
    variants: Record<string, { key: string }>
  }>(
    `SELECT status, mime_type, declared_mime, byte_size, failure_reason, variants
       FROM media_assets WHERE id = $1`,
    [id],
  )
}

describeIfDatabase('media uploads', () => {
  let admin: Awaited<ReturnType<typeof createUserAndLogin>>

  beforeAll(setupDatabase)
  beforeEach(async () => {
    enqueued.length = 0
    storage.clear()
    setStorage(storage)
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

  // ── Step 1: the ticket ────────────────────────────────────────────────────

  it('hands back a server-generated key, never one the client chose', async () => {
    const res = await requestUpload(admin.accessToken, { filename: '../../etc/passwd' })

    expect(res.status).toBe(202)
    expect(res.body.data.storageKey).toMatch(
      /^media\/\d{4}\/\d{2}\/[0-9a-f-]{36}\/original\.png$/,
    )
    expect(res.body.data.upload.url).toBeTruthy()
    expect(new Date(res.body.data.upload.expiresAt).getTime()).toBeGreaterThan(Date.now())

    // The filename survives only as a label, stripped of its path.
    const row = await queryOne<{ original_filename: string; status: string }>(
      'SELECT original_filename, status FROM media_assets WHERE id = $1',
      [res.body.data.assetId],
    )
    expect(row?.original_filename).toBe('passwd')
    expect(row?.status).toBe('pending')
  })

  it('refuses a content type outside the allowlist before any key exists', async () => {
    for (const contentType of ['image/svg+xml', 'text/html', 'application/pdf']) {
      const res = await requestUpload(admin.accessToken, { contentType })
      expect(res.status).toBe(422)
    }
    const count = await queryOne<{ count: number }>('SELECT count(*)::int FROM media_assets')
    expect(count?.count).toBe(0)
  })

  it('refuses a declared size beyond the limit', async () => {
    const res = await requestUpload(admin.accessToken, { byteSize: 999_000_000 })
    expect(res.status).toBe(422)
  })

  it('is not reachable without catalog:write', async () => {
    const staff = await createUserAndLogin(app, { roles: ['staff'] })
    const res = await requestUpload(staff.accessToken)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('INSUFFICIENT_PERMISSIONS')
  })

  // ── Step 3: inspection ────────────────────────────────────────────────────

  it('accepts a real image and queues it for processing', async () => {
    const png = await makePng()
    const ticket = await uploadTo(admin.accessToken, png)

    const res = await complete(admin.accessToken, ticket.assetId)
    expect(res.status).toBe(202)
    expect(res.body.data.status).toBe('processing')

    expect(enqueued).toContainEqual({
      queue: 'media.process_image',
      payload: { mediaAssetId: ticket.assetId },
    })
    expect(await eventNames()).toContain('media.uploaded')
  })

  it('refuses to complete an asset whose bytes never arrived', async () => {
    const res = await requestUpload(admin.accessToken)
    const completed = await complete(admin.accessToken, res.body.data.assetId)

    expect(completed.status).toBe(422)
    expect(completed.body.code).toBe('MEDIA_NOT_UPLOADED')
    expect(enqueued).toHaveLength(0)
  })

  it('rejects bytes that are not an image, whatever they claimed to be', async () => {
    const html = Buffer.from('<!doctype html><script>alert(1)</script>')
    const ticket = await uploadTo(admin.accessToken, html, { declared: 'image/png' })

    const res = await complete(admin.accessToken, ticket.assetId)
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('MEDIA_REJECTED')

    const row = await assetRow(ticket.assetId)
    expect(row?.status).toBe('failed')
    expect(row?.failure_reason).toMatch(/not a recognised image/i)
    expect(enqueued).toHaveLength(0)
  })

  it('rejects an SVG dressed up as a PNG', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const ticket = await uploadTo(admin.accessToken, svg, { declared: 'image/png' })

    const res = await complete(admin.accessToken, ticket.assetId)
    expect(res.status).toBe(422)
    expect((await assetRow(ticket.assetId))?.status).toBe('failed')
  })

  it('records the real type when the declared one is merely wrong', async () => {
    // Browsers mislabel files; that is not an attack, and the real type wins.
    const jpeg = await makeJpeg()
    const ticket = await uploadTo(admin.accessToken, jpeg, { declared: 'image/png' })

    const res = await complete(admin.accessToken, ticket.assetId)
    expect(res.status).toBe(202)

    await processImageHandler({ mediaAssetId: ticket.assetId }, jobContext())
    const row = await assetRow(ticket.assetId)
    expect(row?.declared_mime).toBe('image/png')
    expect(row?.mime_type).toBe('image/jpeg')
  })

  it('rejects an object that is empty in storage', async () => {
    const res = await requestUpload(admin.accessToken)
    await storage.completeUpload(res.body.data.upload.token, Buffer.alloc(0), 'image/png')

    const completed = await complete(admin.accessToken, res.body.data.assetId)
    expect(completed.status).toBe(422)
    expect(completed.body.code).toBe('MEDIA_TOO_LARGE')
    expect((await assetRow(res.body.data.assetId))?.status).toBe('failed')
  })

  it('rejects an object that exceeds the limit once it has actually arrived', async () => {
    // The declared size was honest-looking; the uploaded object is not.
    const res = await requestUpload(admin.accessToken, { byteSize: 1024 })
    const oversized = Buffer.concat([await makePng(), Buffer.alloc(11 * 1024 * 1024)])
    await storage.completeUpload(res.body.data.upload.token, oversized, 'image/png')

    const completed = await complete(admin.accessToken, res.body.data.assetId)
    expect(completed.status).toBe(422)
    expect(completed.body.code).toBe('MEDIA_TOO_LARGE')
  })

  it('is idempotent: completing twice enqueues once', async () => {
    const ticket = await uploadTo(admin.accessToken, await makePng())

    const first = await complete(admin.accessToken, ticket.assetId)
    const second = await complete(admin.accessToken, ticket.assetId)

    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(enqueued.filter((e) => e.queue === 'media.process_image')).toHaveLength(1)
  })

  it('404s for an asset that does not exist', async () => {
    const res = await complete(admin.accessToken, '00000000-0000-4000-8000-000000000000')
    expect(res.status).toBe(404)
  })

  // ── Processing ────────────────────────────────────────────────────────────

  it('re-encodes, generates variants and marks the asset ready', async () => {
    const ticket = await uploadTo(admin.accessToken, await makePng(400, 300))
    await complete(admin.accessToken, ticket.assetId)

    await processImageHandler({ mediaAssetId: ticket.assetId }, jobContext())

    const row = await assetRow(ticket.assetId)
    expect(row?.status).toBe('ready')
    expect(row?.mime_type).toBe('image/png')
    expect(row?.byte_size).toBeGreaterThan(0)
    expect(Object.keys(row?.variants ?? {})).toContain('thumb')

    for (const variant of Object.values(row?.variants ?? {})) {
      expect(storage.keys()).toContain(variant.key)
    }
    expect(await eventNames()).toContain('media.ready')
  })

  it('destroys an appended payload by re-encoding the original in place', async () => {
    const polyglot = await makePolyglotPng()
    expect(polyglot.toString('latin1')).toContain('<script>')

    const ticket = await uploadTo(admin.accessToken, polyglot)
    await complete(admin.accessToken, ticket.assetId)
    await processImageHandler({ mediaAssetId: ticket.assetId }, jobContext())

    // Same key: the "pristine original" is not kept alongside, because that is
    // exactly the file an attacker wants left on disk.
    const stored = await storage.download(ticket.storageKey)
    expect(stored.toString('latin1')).not.toContain('<script>')
    expect((await assetRow(ticket.assetId))?.status).toBe('ready')
  })

  it('strips EXIF, so an uploaded photo does not republish where it was taken', async () => {
    const sharp = (await import('sharp')).default
    const withExif = await makeJpegWithExif()
    expect((await sharp(withExif).metadata()).exif).toBeTruthy()

    const ticket = await uploadTo(admin.accessToken, withExif, { declared: 'image/jpeg' })
    await complete(admin.accessToken, ticket.assetId)
    await processImageHandler({ mediaAssetId: ticket.assetId }, jobContext())

    const stored = await storage.download(ticket.storageKey)
    expect((await sharp(stored).metadata()).exif).toBeUndefined()
  })

  it('never upscales a small image into a large variant', async () => {
    const ticket = await uploadTo(admin.accessToken, await makePng(64, 64))
    await complete(admin.accessToken, ticket.assetId)
    await processImageHandler({ mediaAssetId: ticket.assetId }, jobContext())

    const row = await assetRow(ticket.assetId)
    expect(Object.keys(row?.variants ?? {})).toEqual(['thumb'])
  })

  it('fails the asset when the bytes cannot be decoded', async () => {
    // A valid PNG header followed by garbage: it sniffs as PNG, and sharp
    // refuses it. The asset must end up `failed`, not stuck in `processing`.
    const broken = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(512, 0x41),
    ])
    const ticket = await uploadTo(admin.accessToken, broken)
    await complete(admin.accessToken, ticket.assetId)

    await processImageHandler({ mediaAssetId: ticket.assetId }, jobContext())

    const row = await assetRow(ticket.assetId)
    expect(row?.status).toBe('failed')
    expect(row?.failure_reason).toBeTruthy()
  })

  it('is idempotent: a redelivered job does not process a ready asset again', async () => {
    const ticket = await uploadTo(admin.accessToken, await makePng())
    await complete(admin.accessToken, ticket.assetId)
    await processImageHandler({ mediaAssetId: ticket.assetId }, jobContext())

    const first = await storage.download(ticket.storageKey)
    await processImageHandler({ mediaAssetId: ticket.assetId }, jobContext())
    const second = await storage.download(ticket.storageKey)

    expect(second.equals(first)).toBe(true)
    expect((await eventNames()).filter((n) => n === 'media.ready')).toHaveLength(1)
  })

  it('does nothing when the asset has been deleted under it', async () => {
    await expect(
      processImageHandler({ mediaAssetId: '00000000-0000-4000-8000-000000000000' }, jobContext()),
    ).resolves.toBeUndefined()
  })

  // ── Serving ───────────────────────────────────────────────────────────────

  it('withholds URLs until an asset is ready', async () => {
    const ticket = await uploadTo(admin.accessToken, await makePng())

    const pending = await request(app)
      .get(`/api/v1/admin/media/${ticket.assetId}`)
      .set('Authorization', bearer(admin.accessToken))
    expect(pending.body.data.url).toBeUndefined()

    await complete(admin.accessToken, ticket.assetId)
    await processImageHandler({ mediaAssetId: ticket.assetId }, jobContext())

    const ready = await request(app)
      .get(`/api/v1/admin/media/${ticket.assetId}`)
      .set('Authorization', bearer(admin.accessToken))
    expect(ready.body.data.url).toContain(ticket.storageKey)
    expect(ready.body.data.variants.thumb).toBeTruthy()
  })

  it('lists assets and filters by status', async () => {
    const ready = await uploadTo(admin.accessToken, await makePng())
    await complete(admin.accessToken, ready.assetId)
    await processImageHandler({ mediaAssetId: ready.assetId }, jobContext())
    await requestUpload(admin.accessToken)

    const all = await request(app)
      .get('/api/v1/admin/media')
      .set('Authorization', bearer(admin.accessToken))
    expect(all.body.meta.pagination.total).toBe(2)

    const filtered = await request(app)
      .get('/api/v1/admin/media?status=ready')
      .set('Authorization', bearer(admin.accessToken))
    expect(filtered.body.meta.pagination.total).toBe(1)
    expect(filtered.body.data[0].id).toBe(ready.assetId)
  })

  it('never exposes the storage key or bucket in a response', async () => {
    const ticket = await uploadTo(admin.accessToken, await makePng())
    await complete(admin.accessToken, ticket.assetId)
    await processImageHandler({ mediaAssetId: ticket.assetId }, jobContext())

    const res = await request(app)
      .get(`/api/v1/admin/media/${ticket.assetId}`)
      .set('Authorization', bearer(admin.accessToken))

    expect(res.body.data.storageKey).toBeUndefined()
    expect(res.body.data.bucket).toBeUndefined()
    expect(res.body.data.checksumSha256).toBeUndefined()
  })

  // ── Editing and deletion ──────────────────────────────────────────────────

  it('updates alt text and audits the change', async () => {
    const ticket = await uploadTo(admin.accessToken, await makePng())

    const res = await request(app)
      .patch(`/api/v1/admin/media/${ticket.assetId}`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ alt: 'A red square' })

    expect(res.status).toBe(200)
    expect(res.body.data.alt).toBe('A red square')

    const audit = await queryOne<{ action: string; after: { alt: string } }>(
      `SELECT action, after FROM audit_logs WHERE resource_id = $1`,
      [ticket.assetId],
    )
    expect(audit?.action).toBe('media.updated')
    expect(audit?.after.alt).toBe('A red square')
  })

  it('deletes the row and every object under the asset’s prefix', async () => {
    const ticket = await uploadTo(admin.accessToken, await makePng(400, 300))
    await complete(admin.accessToken, ticket.assetId)
    await processImageHandler({ mediaAssetId: ticket.assetId }, jobContext())
    expect(storage.keys().length).toBeGreaterThan(1)

    const res = await request(app)
      .delete(`/api/v1/admin/media/${ticket.assetId}`)
      .set('Authorization', bearer(admin.accessToken))

    expect(res.status).toBe(204)
    expect(await assetRow(ticket.assetId)).toBeUndefined()
    expect(storage.keys()).toHaveLength(0)
    expect(await eventNames()).toContain('media.deleted')
  })

  // ── The sweep ─────────────────────────────────────────────────────────────

  it('sweeps abandoned uploads and leaves everything else alone', async () => {
    const abandoned = await requestUpload(admin.accessToken)
    const recent = await requestUpload(admin.accessToken)
    const done = await uploadTo(admin.accessToken, await makePng())
    await complete(admin.accessToken, done.assetId)
    await processImageHandler({ mediaAssetId: done.assetId }, jobContext())

    await execute(`UPDATE media_assets SET created_at = now() - interval '3 days' WHERE id = $1`, [
      abandoned.body.data.assetId,
    ])

    await cleanupMediaHandler({ abandonedAfterHours: 24 }, jobContext(QUEUES.CLEANUP_MEDIA))

    expect(await assetRow(abandoned.body.data.assetId)).toBeUndefined()
    expect((await assetRow(recent.body.data.assetId))?.status).toBe('pending')
    expect((await assetRow(done.assetId))?.status).toBe('ready')
  })

  it('stops sweeping when the worker is shutting down', async () => {
    for (let i = 0; i < 3; i += 1) await requestUpload(admin.accessToken)
    await execute(`UPDATE media_assets SET created_at = now() - interval '3 days'`)

    const controller = new AbortController()
    controller.abort()

    await cleanupMediaHandler({ abandonedAfterHours: 24 }, {
      ...jobContext(QUEUES.CLEANUP_MEDIA),
      signal: controller.signal,
    })

    const count = await queryOne<{ count: number }>('SELECT count(*)::int FROM media_assets')
    expect(count?.count).toBe(3)
  })

  // ── The provider seam ─────────────────────────────────────────────────────

  it('refuses to use an asset that is not ready', () => {
    expect(() =>
      mediaService.assertReady({ status: 'pending' } as never),
    ).toThrow(/not ready/i)
  })
})
