/**
 * In-memory storage, for tests (§20.3).
 *
 * Implements the same contract as the real backends and is exercised by the
 * same contract suite, so a test that passes here is testing the provider
 * boundary rather than a convenient fiction. It does *not* prove anything about
 * Supabase — that is what the live suite is for.
 */
import { createHash } from 'node:crypto'
import { assertSafeKey } from '../keys.js'
import {
  StorageOperationError,
  type PutObjectInput,
  type SignedUpload,
  type StorageProvider,
  type StoredObjectInfo,
} from '../provider.js'

interface StoredObject {
  body: Buffer
  contentType: string
  lastModified: Date
}

export class MemoryStorageProvider implements StorageProvider {
  readonly name = 'memory'
  readonly bucket: string
  readonly isPublic = true

  private readonly objects = new Map<string, StoredObject>()
  /** Upload tokens issued but not yet redeemed, so tests can simulate a client. */
  private readonly uploadTokens = new Map<string, { key: string; expiresAt: Date }>()

  constructor(bucket = 'media-test') {
    this.bucket = bucket
  }

  async createSignedUploadUrl(
    key: string,
    options: { contentType: string; expiresInSeconds: number },
  ): Promise<SignedUpload> {
    assertSafeKey(key)
    const token = createHash('sha256').update(`${key}:${Date.now()}`).digest('hex').slice(0, 32)
    const expiresAt = new Date(Date.now() + options.expiresInSeconds * 1000)
    this.uploadTokens.set(token, { key, expiresAt })
    return { url: `memory://${this.bucket}/${key}?token=${token}`, token, method: 'PUT', expiresAt }
  }

  async getUrl(key: string): Promise<string> {
    assertSafeKey(key)
    return `memory://${this.bucket}/${key}`
  }

  async head(key: string): Promise<StoredObjectInfo | undefined> {
    assertSafeKey(key)
    const object = this.objects.get(key)
    if (!object) return undefined
    return {
      key,
      byteSize: object.body.byteLength,
      mimeType: object.contentType,
      lastModified: object.lastModified,
    }
  }

  async download(key: string): Promise<Buffer> {
    assertSafeKey(key)
    const object = this.objects.get(key)
    if (!object) throw new StorageOperationError('Object not found', 'download')
    return Buffer.from(object.body)
  }

  async put(input: PutObjectInput): Promise<void> {
    assertSafeKey(input.key)
    if (this.objects.has(input.key) && !input.upsert) {
      throw new StorageOperationError('Object already exists', 'put')
    }
    this.objects.set(input.key, {
      body: Buffer.from(input.body),
      contentType: input.contentType,
      lastModified: new Date(),
    })
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) {
      assertSafeKey(key)
      this.objects.delete(key)
    }
  }

  async healthCheck(): Promise<void> {
    // Nothing to reach.
  }

  // ── Test affordances ──────────────────────────────────────────────────────

  /** Stands in for the client PUTting bytes to the signed URL. */
  async completeUpload(token: string, body: Buffer, contentType: string): Promise<void> {
    const pending = this.uploadTokens.get(token)
    if (!pending) throw new StorageOperationError('Unknown upload token', 'upload')
    if (pending.expiresAt <= new Date()) {
      this.uploadTokens.delete(token)
      throw new StorageOperationError('Upload token expired', 'upload')
    }
    this.uploadTokens.delete(token)
    await this.put({ key: pending.key, body, contentType, upsert: true })
  }

  keys(): string[] {
    return [...this.objects.keys()].sort()
  }

  clear(): void {
    this.objects.clear()
    this.uploadTokens.clear()
  }
}
