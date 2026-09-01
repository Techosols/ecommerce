/**
 * Local filesystem storage, for development (§46).
 *
 * Lets the whole media pipeline — signed upload, inspection, re-encoding,
 * variants — run without a Supabase project. Config refuses to let it be
 * selected in production, because a container filesystem does not survive a
 * redeploy.
 *
 * The "signed upload URL" it issues points at a development-only route on this
 * server, so the client-side flow is identical to production.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertSafeKey } from '../keys.js'
import {
  StorageOperationError,
  type PutObjectInput,
  type SignedUpload,
  type StorageProvider,
  type StoredObjectInfo,
} from '../provider.js'

export interface LocalStorageOptions {
  directory: string
  baseUrl: string
  bucket: string
}

interface PendingUpload {
  key: string
  contentType: string
  expiresAt: Date
}

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local'
  readonly bucket: string
  readonly isPublic = true

  private readonly directory: string
  private readonly baseUrl: string
  private readonly pending = new Map<string, PendingUpload>()

  constructor(options: LocalStorageOptions) {
    this.directory = path.resolve(options.directory)
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.bucket = options.bucket
  }

  /**
   * Resolves a key to a path and refuses anything that escapes the root. The
   * key is already generated server-side and checked by `assertSafeKey`; this
   * is the second lock on the same door, because a path-traversal bug here
   * would be an arbitrary-file-write.
   */
  private pathFor(key: string): string {
    assertSafeKey(key)
    const resolved = path.resolve(this.directory, key)
    if (resolved !== this.directory && !resolved.startsWith(this.directory + path.sep)) {
      throw new StorageOperationError('Resolved path escapes the storage root', 'resolve')
    }
    return resolved
  }

  async createSignedUploadUrl(
    key: string,
    options: { contentType: string; expiresInSeconds: number },
  ): Promise<SignedUpload> {
    assertSafeKey(key)
    const token = createHash('sha256')
      .update(`${key}:${Date.now()}:${Math.random()}`)
      .digest('hex')
      .slice(0, 32)
    const expiresAt = new Date(Date.now() + options.expiresInSeconds * 1000)
    this.pending.set(token, { key, contentType: options.contentType, expiresAt })

    return { url: `${this.baseUrl}/upload/${token}`, token, method: 'PUT', expiresAt }
  }

  async getUrl(key: string): Promise<string> {
    assertSafeKey(key)
    return `${this.baseUrl}/objects/${key}`
  }

  async head(key: string): Promise<StoredObjectInfo | undefined> {
    // Resolved outside the try: "the key is unsafe" is a bug in the caller and
    // must surface, whereas "no such object" is an ordinary answer.
    const target = this.pathFor(key)
    try {
      const stats = await stat(target)
      return {
        key,
        byteSize: stats.size,
        // The filesystem has no content type; the caller sniffs the bytes.
        mimeType: undefined,
        lastModified: stats.mtime,
      }
    } catch {
      return undefined
    }
  }

  async download(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key))
    } catch (error) {
      throw new StorageOperationError('Object not found', 'download', { cause: error })
    }
  }

  async put(input: PutObjectInput): Promise<void> {
    const target = this.pathFor(input.key)
    if (!input.upsert && (await this.head(input.key))) {
      throw new StorageOperationError('Object already exists', 'put')
    }
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, input.body)
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) {
      await rm(this.pathFor(key), { force: true })
    }
  }

  async healthCheck(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
  }

  // ── Development upload endpoint support ───────────────────────────────────

  /** Redeems a token issued by `createSignedUploadUrl`. One use, then gone. */
  async completeUpload(token: string, body: Buffer): Promise<{ key: string }> {
    const upload = this.pending.get(token)
    if (!upload) throw new StorageOperationError('Unknown upload token', 'upload')
    if (upload.expiresAt <= new Date()) {
      this.pending.delete(token)
      throw new StorageOperationError('Upload token expired', 'upload')
    }
    this.pending.delete(token)
    await this.put({ key: upload.key, body, contentType: upload.contentType, upsert: true })
    return { key: upload.key }
  }
}
