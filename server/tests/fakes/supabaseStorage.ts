/**
 * An in-memory stand-in for `supabase.storage.from(bucket)` (§20.3).
 *
 * It reproduces the SDK's *shape* — the `{ data, error }` envelope, the fact
 * that there is no HEAD so metadata comes from a filtered `list`, the one-time
 * upload token — so the adapter's translation layer can be tested without a
 * network.
 *
 * It reproduces the SDK's shape, not Supabase's behaviour. Nothing that passes
 * against this fake is evidence that the real service does the same thing; that
 * is what the opt-in live suite is for, and why it skips loudly rather than
 * silently when credentials are absent.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

interface StoredObject {
  body: Buffer
  contentType: string
  cacheControl: string
  updatedAt: Date
}

interface Envelope<T> {
  data: T | null
  error: { message: string } | null
}

const ok = <T>(data: T): Envelope<T> => ({ data, error: null })
const err = (message: string): Envelope<never> => ({ data: null, error: { message } })

export class FakeSupabaseStorageBucket {
  readonly objects = new Map<string, StoredObject>()
  readonly tokens = new Map<string, string>()
  /** Every method name called, in order — lets a test assert on the call shape. */
  readonly calls: string[] = []
  /** Set to make the next call of a given operation fail. */
  failNext = new Map<string, string>()

  constructor(
    readonly bucket: string,
    readonly baseUrl: string,
  ) {}

  private record(operation: string): string | undefined {
    this.calls.push(operation)
    const message = this.failNext.get(operation)
    if (message !== undefined) this.failNext.delete(operation)
    return message
  }

  async createSignedUploadUrl(path: string) {
    const failure = this.record('createSignedUploadUrl')
    if (failure) return err(failure)
    const token = `tok_${Buffer.from(path).toString('hex').slice(0, 24)}`
    this.tokens.set(token, path)
    return ok({
      signedUrl: `${this.baseUrl}/storage/v1/object/upload/sign/${this.bucket}/${path}?token=${token}`,
      token,
      path,
    })
  }

  getPublicUrl(path: string) {
    this.calls.push('getPublicUrl')
    return { data: { publicUrl: `${this.baseUrl}/storage/v1/object/public/${this.bucket}/${path}` } }
  }

  async createSignedUrl(path: string, expiresIn: number) {
    const failure = this.record('createSignedUrl')
    if (failure) return err(failure)
    if (!this.objects.has(path)) return err('Object not found')
    return ok({
      signedUrl: `${this.baseUrl}/storage/v1/object/sign/${this.bucket}/${path}?token=sig&exp=${expiresIn}`,
    })
  }

  async list(prefix: string, options: { search?: string; limit?: number } = {}) {
    const failure = this.record('list')
    if (failure) return err(failure)

    const scope = prefix === '' ? '' : `${prefix}/`
    const entries: {
      name: string
      updated_at: string
      metadata: { size: number; mimetype: string }
    }[] = []

    for (const [key, object] of this.objects) {
      if (!key.startsWith(scope)) continue
      const name = key.slice(scope.length)
      // Supabase lists one level: anything deeper is a folder entry.
      if (name.includes('/')) continue
      // `search` is a prefix match, not an exact one — which is precisely why
      // the adapter filters the result by exact name afterwards.
      if (options.search && !name.startsWith(options.search)) continue
      entries.push({
        name,
        updated_at: object.updatedAt.toISOString(),
        metadata: { size: object.body.byteLength, mimetype: object.contentType },
      })
    }

    return ok(entries.slice(0, options.limit ?? 100))
  }

  async download(path: string) {
    const failure = this.record('download')
    if (failure) return err(failure)
    const object = this.objects.get(path)
    if (!object) return err('Object not found')
    return ok(new Blob([new Uint8Array(object.body)], { type: object.contentType }))
  }

  async upload(
    path: string,
    body: Buffer,
    options: { contentType?: string; cacheControl?: string; upsert?: boolean } = {},
  ) {
    const failure = this.record('upload')
    if (failure) return err(failure)
    if (this.objects.has(path) && !options.upsert) {
      return err('The resource already exists')
    }
    this.objects.set(path, {
      body: Buffer.from(body),
      contentType: options.contentType ?? 'application/octet-stream',
      cacheControl: options.cacheControl ?? '3600',
      updatedAt: new Date(),
    })
    return ok({ path, id: path, fullPath: `${this.bucket}/${path}` })
  }

  async remove(paths: string[]) {
    const failure = this.record('remove')
    if (failure) return err(failure)
    // Supabase does not treat a missing key as an error.
    for (const path of paths) this.objects.delete(path)
    return ok(paths.map((path) => ({ name: path })))
  }

  /** Stands in for the client PUTting bytes at the signed upload URL. */
  async redeemUploadToken(token: string, body: Buffer, contentType: string): Promise<void> {
    const path = this.tokens.get(token)
    if (!path) throw new Error('Unknown upload token')
    this.tokens.delete(token)
    await this.upload(path, body, { contentType, upsert: true })
  }

  clear(): void {
    this.objects.clear()
    this.tokens.clear()
    this.calls.length = 0
    this.failNext.clear()
  }
}

export interface FakeSupabase {
  client: SupabaseClient
  bucket: FakeSupabaseStorageBucket
}

export function createFakeSupabase(
  bucketName = 'media-test',
  baseUrl = 'https://project.supabase.test',
): FakeSupabase {
  const bucket = new FakeSupabaseStorageBucket(bucketName, baseUrl)
  const client = {
    storage: {
      from(name: string) {
        if (name !== bucketName) throw new Error(`Unexpected bucket "${name}"`)
        return bucket
      },
    },
  }
  return { client: client as unknown as SupabaseClient, bucket }
}
