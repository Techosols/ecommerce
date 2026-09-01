/**
 * The Supabase Storage adapter, against a fake SDK client (§20.3, §46).
 *
 * ── What these tests do and do not prove ────────────────────────────────────
 *
 * They run against an in-memory fake that mimics the SDK's `{ data, error }`
 * shape. They therefore prove that the adapter translates the interface
 * correctly: that it filters a `list` result by exact name, that it never lets
 * a raw provider error escape, that it asserts key safety before every call,
 * that a public bucket yields a stable URL and a private one a signed one.
 *
 * They prove **nothing about Supabase itself**. No request leaves this process.
 * The real service is exercised only by `storage.supabase.live.test.ts`, which
 * is opt-in and skips unless real credentials are supplied.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { SupabaseStorageProvider } from '../../src/infrastructure/storage/providers/supabase.js'
import { StorageOperationError } from '../../src/infrastructure/storage/provider.js'
import { createFakeSupabase, type FakeSupabaseStorageBucket } from '../fakes/supabaseStorage.js'
import { runStorageProviderContract, PNG_1X1 } from '../contract/storageProvider.js'

const SERVICE_ROLE_KEY = 'service-role-key-that-must-never-leak-0123456789'

function build(options: { isPublic?: boolean } = {}) {
  const { client, bucket } = createFakeSupabase()
  const provider = new SupabaseStorageProvider({
    url: 'https://project.supabase.test',
    serviceRoleKey: SERVICE_ROLE_KEY,
    bucket: 'media-test',
    isPublic: options.isPublic ?? true,
    client,
  })
  return { provider, bucket }
}

// The same contract every other adapter satisfies — run here against the fake.
runStorageProviderContract('supabase (fake SDK client — NOT the real service)', () => {
  const { provider, bucket } = build()
  return {
    provider,
    async completeUpload(token, body, contentType) {
      await bucket.redeemUploadToken(token as string, body, contentType)
    },
    async cleanup() {
      bucket.clear()
    },
  }
})

describe('supabase adapter specifics (fake SDK client)', () => {
  let provider: SupabaseStorageProvider
  let bucket: FakeSupabaseStorageBucket

  beforeEach(() => {
    const built = build()
    provider = built.provider
    bucket = built.bucket
  })

  it('never puts the service-role key in a URL it hands out', async () => {
    const key = 'media/2026/03/asset/original.png'
    await provider.put({ key, body: PNG_1X1, contentType: 'image/png' })

    const upload = await provider.createSignedUploadUrl(key, {
      contentType: 'image/png',
      expiresInSeconds: 300,
    })
    const readable = await provider.getUrl(key)

    for (const url of [upload.url, readable]) {
      expect(url).not.toContain(SERVICE_ROLE_KEY)
      expect(url).not.toContain('service-role')
    }
  })

  it('reports our own expiry for an upload, since the SDK takes no TTL', async () => {
    const before = Date.now()
    const upload = await provider.createSignedUploadUrl('media/a/original.png', {
      contentType: 'image/png',
      expiresInSeconds: 300,
    })
    expect(upload.token).toBeTruthy()
    expect(upload.method).toBe('PUT')
    expect(upload.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 299_000)
    expect(upload.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 300_000)
  })

  it('returns a stable public URL on a public bucket', async () => {
    const key = 'media/2026/03/asset/original.png'
    await provider.put({ key, body: PNG_1X1, contentType: 'image/png' })

    const first = await provider.getUrl(key)
    const second = await provider.getUrl(key)
    expect(first).toBe(second)
    expect(first).toContain('/object/public/')
    expect(bucket.calls).toContain('getPublicUrl')
  })

  it('signs a URL on a private bucket instead', async () => {
    const built = build({ isPublic: false })
    const key = 'media/2026/03/asset/original.png'
    await built.provider.put({ key, body: PNG_1X1, contentType: 'image/png' })

    const url = await built.provider.getUrl(key, { expiresInSeconds: 60 })
    expect(url).toContain('/object/sign/')
    expect(url).toContain('exp=60')
    expect(built.bucket.calls).toContain('createSignedUrl')
  })

  it('filters the list result by exact name, so a prefix match is not a hit', async () => {
    // Supabase's `search` is a prefix match. "original.png" would also match
    // "original.png.bak", and treating that as the object would report the
    // wrong size to the size check.
    await provider.put({
      key: 'media/2026/03/asset/original.png.bak',
      body: Buffer.concat([PNG_1X1, Buffer.alloc(100)]),
      contentType: 'image/png',
    })

    expect(await provider.head('media/2026/03/asset/original.png')).toBeUndefined()
  })

  it('does not treat a deeper object as a sibling', async () => {
    await provider.put({
      key: 'media/2026/03/asset/nested/original.png',
      body: PNG_1X1,
      contentType: 'image/png',
    })
    expect(await provider.head('media/2026/03/asset/original.png')).toBeUndefined()
  })

  it('reports the size and type recorded by the backend', async () => {
    const key = 'media/2026/03/asset/original.png'
    await provider.put({ key, body: PNG_1X1, contentType: 'image/png' })

    const info = await provider.head(key)
    expect(info).toMatchObject({ key, byteSize: PNG_1X1.byteLength, mimeType: 'image/png' })
    expect(info?.lastModified).toBeInstanceOf(Date)
  })

  it('wraps a provider error and does not leak its message', async () => {
    bucket.failNext.set('download', 'JWT expired: service_role key rejected by project abc123')

    const error = await provider
      .download('media/2026/03/asset/original.png')
      .then(() => null)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(StorageOperationError)
    expect((error as Error).message).toBe('Storage download failed')
    expect((error as Error).message).not.toContain('JWT')
    expect((error as Error).message).not.toContain('abc123')
  })

  it.each([
    ['createSignedUploadUrl', () => provider.createSignedUploadUrl('media/a/original.png', {
      contentType: 'image/png',
      expiresInSeconds: 60,
    })],
    ['upload', () => provider.put({ key: 'media/a/original.png', body: PNG_1X1, contentType: 'image/png' })],
    ['remove', () => provider.remove(['media/a/original.png'])],
    ['list', () => provider.healthCheck()],
  ])('turns a failed %s into a StorageOperationError', async (operation, act) => {
    bucket.failNext.set(operation, 'backend exploded')
    await expect(act()).rejects.toBeInstanceOf(StorageOperationError)
  })

  it('checks key safety before it ever reaches the SDK', async () => {
    const before = bucket.calls.length
    await expect(provider.head('media/../../etc/passwd')).rejects.toThrow(/unsafe/i)
    await expect(provider.remove(['ok/key.png', '../escape.png'])).rejects.toThrow(/unsafe/i)
    expect(bucket.calls.length).toBe(before)
  })

  it('sends a long cache lifetime for immutable derivatives', async () => {
    await provider.put({
      key: 'media/2026/03/asset/thumb.webp',
      body: PNG_1X1,
      contentType: 'image/webp',
      cacheSeconds: 31_536_000,
    })
    expect(bucket.objects.get('media/2026/03/asset/thumb.webp')?.cacheControl).toBe('31536000')
  })

  it('does nothing at all when asked to remove no keys', async () => {
    const before = bucket.calls.length
    await provider.remove([])
    expect(bucket.calls.length).toBe(before)
  })
})
