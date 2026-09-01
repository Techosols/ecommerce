/**
 * Supabase Storage, against the real service (§20.3, §46).
 *
 * ── This suite SKIPS unless you opt in ──────────────────────────────────────
 *
 * Set all three of these to run it:
 *
 *   SUPABASE_TEST_URL=https://<project>.supabase.co
 *   SUPABASE_TEST_SERVICE_ROLE_KEY=<service role key>
 *   SUPABASE_TEST_BUCKET=media-test
 *
 * Use a throwaway project and a bucket you are happy to have objects created
 * and deleted in: the suite writes under a unique `media/live-test/<run>/`
 * prefix and removes what it created, but it is still writing to real storage.
 *
 * It is opt-in rather than default because CI must not depend on a third-party
 * service being up, and because a service-role key does not belong in a CI
 * secret store unless someone decided it should. The consequence is stated
 * plainly: **with these variables unset, nothing in this repository has been
 * tested against real Supabase.** The suite below is the only thing that would
 * be evidence of that, and it says so in its skip message.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SupabaseStorageProvider } from '../../src/infrastructure/storage/providers/supabase.js'
import { sniffImageType } from '../../src/infrastructure/storage/sniff.js'

const url = process.env.SUPABASE_TEST_URL ?? ''
const serviceRoleKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? ''
const bucket = process.env.SUPABASE_TEST_BUCKET ?? ''

const configured = url.length > 0 && serviceRoleKey.length > 0 && bucket.length > 0

if (!configured) {
  console.info(
    '\n[skip] Supabase Storage live tests: set SUPABASE_TEST_URL, ' +
      'SUPABASE_TEST_SERVICE_ROLE_KEY and SUPABASE_TEST_BUCKET to run them.\n' +
      '       Without them, Supabase has NOT been tested against the real service.\n',
  )
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

describe.skipIf(!configured)('Supabase Storage (LIVE — real service)', () => {
  const run = randomUUID()
  const prefix = `media/live-test/${run}`
  const created: string[] = []

  let provider: SupabaseStorageProvider

  const key = (name: string): string => {
    const full = `${prefix}/${name}`
    created.push(full)
    return full
  }

  beforeAll(() => {
    provider = new SupabaseStorageProvider({ url, serviceRoleKey, bucket, isPublic: true })
  })

  afterAll(async () => {
    if (created.length > 0) await provider.remove(created)
  })

  it('reaches the bucket', async () => {
    await expect(provider.healthCheck()).resolves.toBeUndefined()
  })

  it('uploads, heads and downloads an object', async () => {
    const target = key('original.png')
    await provider.put({ key: target, body: PNG_1X1, contentType: 'image/png' })

    const info = await provider.head(target)
    expect(info?.byteSize).toBe(PNG_1X1.byteLength)
    expect(info?.mimeType).toBe('image/png')

    const body = await provider.download(target)
    expect(body.equals(PNG_1X1)).toBe(true)
    expect(sniffImageType(body)).toBe('image/png')
  })

  it('reports a missing object as undefined', async () => {
    expect(await provider.head(`${prefix}/absent.png`)).toBeUndefined()
  })

  it('refuses to overwrite without upsert', async () => {
    const target = key('once.png')
    await provider.put({ key: target, body: PNG_1X1, contentType: 'image/png' })
    await expect(
      provider.put({ key: target, body: PNG_1X1, contentType: 'image/png' }),
    ).rejects.toThrow()
  })

  it('accepts bytes PUT at a signed upload URL', async () => {
    const target = key('signed.png')
    const upload = await provider.createSignedUploadUrl(target, {
      contentType: 'image/png',
      expiresInSeconds: 300,
    })

    // Exactly what a browser would do with the ticket the API handed it.
    const response = await fetch(upload.url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
        // The one-time token, not the service-role key — which is the whole
        // point of the flow: the client never holds a credential of ours.
        authorization: `Bearer ${upload.token ?? ''}`,
      },
      body: new Uint8Array(PNG_1X1),
    })
    expect(response.ok).toBe(true)

    expect((await provider.head(target))?.byteSize).toBe(PNG_1X1.byteLength)
  })

  it('serves the object from the URL it hands out', async () => {
    const target = key('readable.png')
    await provider.put({ key: target, body: PNG_1X1, contentType: 'image/png' })

    const response = await fetch(await provider.getUrl(target))
    expect(response.ok).toBe(true)
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG_1X1)).toBe(true)
  })

  it('removes objects', async () => {
    const target = `${prefix}/temporary.png`
    await provider.put({ key: target, body: PNG_1X1, contentType: 'image/png' })
    await provider.remove([target])
    expect(await provider.head(target)).toBeUndefined()
  })
})
