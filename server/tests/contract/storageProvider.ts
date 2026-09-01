/**
 * The `StorageProvider` contract, as executable specification (§20.3, §46).
 *
 * Every adapter runs the same suite. That is the point of the seam: if the
 * memory provider and the Supabase provider both satisfy this, then a feature
 * test written against the memory provider is testing behaviour the real
 * backend also has, rather than a convenient fiction.
 *
 * What this suite deliberately does *not* claim: that Supabase works. Running
 * it against a mocked SDK proves the adapter calls the SDK correctly, not that
 * the service behaves as documented. Only `storage.supabase.live.test.ts`,
 * which is opt-in and skips without real credentials, tests that.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StorageProvider } from '../../src/infrastructure/storage/provider.js'

/** A real, decodable 1×1 PNG. Small enough to keep inline, valid enough to sniff. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

export interface ContractHarness {
  provider: StorageProvider
  /** Stands in for the client uploading to the signed URL it was given. */
  completeUpload(token: string | undefined, body: Buffer, contentType: string): Promise<void>
  /** Removes everything the suite created. */
  cleanup(keys: string[]): Promise<void>
}

let sequence = 0
function uniqueKey(suffix = 'original.png'): string {
  sequence += 1
  return `media/contract/${Date.now().toString(36)}-${sequence}/${suffix}`
}

export function runStorageProviderContract(
  name: string,
  createHarness: () => Promise<ContractHarness> | ContractHarness,
): void {
  describe(`StorageProvider contract: ${name}`, () => {
    let harness: ContractHarness
    let provider: StorageProvider
    const created: string[] = []

    const track = (key: string): string => {
      created.push(key)
      return key
    }

    beforeAll(async () => {
      harness = await createHarness()
      provider = harness.provider
    })

    afterAll(async () => {
      await harness.cleanup(created)
    })

    it('exposes its identity', () => {
      expect(provider.name).toBeTruthy()
      expect(provider.bucket).toBeTruthy()
      expect(typeof provider.isPublic).toBe('boolean')
    })

    it('round-trips an object through put, head and download', async () => {
      const key = track(uniqueKey())
      await provider.put({ key, body: PNG_1X1, contentType: 'image/png' })

      const info = await provider.head(key)
      expect(info?.byteSize).toBe(PNG_1X1.byteLength)

      const body = await provider.download(key)
      expect(body.equals(PNG_1X1)).toBe(true)
    })

    it('reports a missing object as undefined rather than throwing', async () => {
      expect(await provider.head(uniqueKey('missing.png'))).toBeUndefined()
    })

    it('throws a StorageOperationError when downloading a missing object', async () => {
      await expect(provider.download(uniqueKey('missing.png'))).rejects.toThrow()
    })

    it('refuses to overwrite unless asked to', async () => {
      const key = track(uniqueKey())
      await provider.put({ key, body: PNG_1X1, contentType: 'image/png' })

      await expect(
        provider.put({ key, body: PNG_1X1, contentType: 'image/png' }),
      ).rejects.toThrow()

      const replacement = Buffer.concat([PNG_1X1, Buffer.from([0])])
      await provider.put({ key, body: replacement, contentType: 'image/png', upsert: true })
      expect((await provider.download(key)).byteLength).toBe(replacement.byteLength)
    })

    it('accepts bytes uploaded through a signed upload URL', async () => {
      const key = track(uniqueKey())
      const upload = await provider.createSignedUploadUrl(key, {
        contentType: 'image/png',
        expiresInSeconds: 300,
      })

      expect(upload.url).toMatch(/^[a-z]+:\/\//)
      expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now())
      expect(['PUT', 'POST']).toContain(upload.method)

      // Nothing exists until the client actually uploads.
      expect(await provider.head(key)).toBeUndefined()

      await harness.completeUpload(upload.token, PNG_1X1, 'image/png')
      expect((await provider.head(key))?.byteSize).toBe(PNG_1X1.byteLength)
    })

    it('returns a readable URL that contains the key', async () => {
      const key = track(uniqueKey())
      await provider.put({ key, body: PNG_1X1, contentType: 'image/png' })

      const url = await provider.getUrl(key)
      expect(url).toContain(key)
    })

    it('removes objects, and removing a missing key is not an error', async () => {
      const key = uniqueKey()
      await provider.put({ key, body: PNG_1X1, contentType: 'image/png' })
      await provider.remove([key])
      expect(await provider.head(key)).toBeUndefined()

      await expect(provider.remove([uniqueKey('gone.png')])).resolves.toBeUndefined()
    })

    it('rejects an unsafe key everywhere it accepts one', async () => {
      const traversal = 'media/../../etc/passwd'
      await expect(provider.head(traversal)).rejects.toThrow(/unsafe/i)
      await expect(provider.download(traversal)).rejects.toThrow()
      await expect(
        provider.put({ key: traversal, body: PNG_1X1, contentType: 'image/png' }),
      ).rejects.toThrow(/unsafe/i)
      await expect(provider.getUrl(traversal)).rejects.toThrow(/unsafe/i)
    })

    it('has a health check that succeeds against an empty bucket', async () => {
      await expect(provider.healthCheck()).resolves.toBeUndefined()
    })
  })
}

export { PNG_1X1 }
