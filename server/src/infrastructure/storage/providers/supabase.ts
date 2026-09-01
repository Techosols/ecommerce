/**
 * Supabase Storage adapter (§46).
 *
 * The only file in the codebase that imports the Supabase SDK. Everything above
 * it sees `StorageProvider`.
 *
 * Three things worth knowing about this backend specifically:
 *
 *  • It is reached with the **service-role key**, which bypasses row-level
 *    security and must never leave the server. It is read once from config,
 *    held here, and never returned, logged or embedded in a URL.
 *
 *  • `createSignedUploadUrl` returns a one-time token. The client uploads
 *    straight to Supabase with it, so our API never carries the bytes — and
 *    correspondingly never sees them until it fetches the object back to
 *    inspect it.
 *
 *  • A public bucket yields a stable, CDN-cacheable URL; a private one yields a
 *    signed URL with a TTL. Product images want the former, which is why
 *    `SUPABASE_STORAGE_PUBLIC` defaults to true.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from '../../../config/index.js'
import { createLogger } from '../../logging/logger.js'
import { assertSafeKey } from '../keys.js'
import {
  StorageOperationError,
  type PutObjectInput,
  type SignedUpload,
  type StorageProvider,
  type StoredObjectInfo,
} from '../provider.js'

const log = createLogger('storage.supabase')

export interface SupabaseStorageOptions {
  url: string
  serviceRoleKey: string
  bucket: string
  isPublic: boolean
  /** Injectable so the adapter can be unit-tested without the network. */
  client?: SupabaseClient
}

export class SupabaseStorageProvider implements StorageProvider {
  readonly name = 'supabase'
  readonly bucket: string
  readonly isPublic: boolean
  private readonly client: SupabaseClient

  constructor(options: SupabaseStorageOptions) {
    this.bucket = options.bucket
    this.isPublic = options.isPublic
    this.client =
      options.client ??
      createClient(options.url, options.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
  }

  private get storage() {
    return this.client.storage.from(this.bucket)
  }

  /** Never let a Supabase error object reach a client or a log verbatim. */
  private fail(operation: string, key: string, error: unknown): never {
    const message = error instanceof Error ? error.message : String(error)
    log.error({ operation, key, err: message }, 'supabase storage operation failed')
    throw new StorageOperationError(`Storage ${operation} failed`, operation, { cause: error })
  }

  async createSignedUploadUrl(
    key: string,
    options: { contentType: string; expiresInSeconds: number },
  ): Promise<SignedUpload> {
    assertSafeKey(key)

    // Supabase does not take a TTL here; its upload tokens are short-lived by
    // design. We report our own intended expiry so callers have one contract.
    const { data, error } = await this.storage.createSignedUploadUrl(key)
    if (error || !data) this.fail('createSignedUploadUrl', key, error)

    return {
      url: data.signedUrl,
      token: data.token,
      method: 'PUT',
      expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000),
    }
  }

  async getUrl(key: string, options: { expiresInSeconds?: number } = {}): Promise<string> {
    assertSafeKey(key)

    if (this.isPublic) {
      return this.storage.getPublicUrl(key).data.publicUrl
    }

    const ttl = options.expiresInSeconds ?? env.MEDIA_SIGNED_URL_TTL_SECONDS
    const { data, error } = await this.storage.createSignedUrl(key, ttl)
    if (error || !data) this.fail('createSignedUrl', key, error)
    return data.signedUrl
  }

  async head(key: string): Promise<StoredObjectInfo | undefined> {
    assertSafeKey(key)

    // Supabase has no HEAD; a prefix listing filtered to the exact name is the
    // documented way to read an object's metadata.
    const lastSlash = key.lastIndexOf('/')
    const prefix = lastSlash === -1 ? '' : key.slice(0, lastSlash)
    const name = lastSlash === -1 ? key : key.slice(lastSlash + 1)

    const { data, error } = await this.storage.list(prefix, { search: name, limit: 100 })
    if (error) this.fail('head', key, error)

    const match = data?.find((entry) => entry.name === name)
    if (!match) return undefined

    const metadata = match.metadata as { size?: number; mimetype?: string } | null
    return {
      key,
      byteSize: metadata?.size ?? 0,
      mimeType: metadata?.mimetype,
      lastModified: match.updated_at ? new Date(match.updated_at) : undefined,
    }
  }

  async download(key: string): Promise<Buffer> {
    assertSafeKey(key)
    const { data, error } = await this.storage.download(key)
    if (error || !data) this.fail('download', key, error)
    return Buffer.from(await data.arrayBuffer())
  }

  async put(input: PutObjectInput): Promise<void> {
    assertSafeKey(input.key)
    const { error } = await this.storage.upload(input.key, input.body, {
      contentType: input.contentType,
      cacheControl: String(input.cacheSeconds ?? 31_536_000),
      upsert: input.upsert ?? false,
    })
    if (error) this.fail('put', input.key, error)
  }

  async remove(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    for (const key of keys) assertSafeKey(key)
    const { error } = await this.storage.remove(keys)
    if (error) this.fail('remove', keys[0] ?? '', error)
  }

  async healthCheck(): Promise<void> {
    // A listing of an empty bucket succeeds with zero rows, which is exactly
    // the signal we want: credentials valid, bucket reachable.
    const { error } = await this.storage.list('', { limit: 1 })
    if (error) this.fail('healthCheck', '', error)
  }
}
