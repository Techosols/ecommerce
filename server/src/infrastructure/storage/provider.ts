/**
 * The object-storage seam (§46).
 *
 * Feature code never imports a vendor SDK. It asks a `StorageProvider` for a
 * signed upload URL, a readable URL, or the bytes of an object — and the
 * adapter under `providers/` decides whether that means Supabase Storage, the
 * local filesystem, or an in-memory map.
 *
 * Two rules the interface deliberately encodes:
 *
 *  • **The caller supplies a key, never a path fragment from a client.** Key
 *    generation lives in `keys.ts` and is entirely server-side, so a client
 *    cannot choose a bucket, escape a prefix, or overwrite someone else's
 *    object (§16.3).
 *
 *  • **A signed upload URL is a promise about *where*, not about *what*.**
 *    Bytes uploaded directly to storage have not been inspected by us, so the
 *    provider also exposes `head` and `download` — the server verifies the
 *    object after the fact and only then lets anything reference it.
 */

export interface SignedUpload {
  /** Where the client PUTs/POSTs the bytes. Short-lived. */
  url: string
  /**
   * Supabase returns a one-time upload token that must be sent with the
   * request. Other backends leave this undefined.
   */
  token?: string
  /** HTTP method the client must use. */
  method: 'PUT' | 'POST'
  expiresAt: Date
}

export interface StoredObjectInfo {
  key: string
  byteSize: number
  mimeType: string | undefined
  lastModified: Date | undefined
}

export interface PutObjectInput {
  key: string
  body: Buffer
  contentType: string
  /** `Cache-Control`, in seconds. Derivatives are immutable, so this is long. */
  cacheSeconds?: number
  /** Replace an existing object at this key. Off by default. */
  upsert?: boolean
}

export interface StorageProvider {
  readonly name: string
  /** The bucket this provider is bound to. Exposed for the audit trail. */
  readonly bucket: string
  /** True when objects are world-readable and `getUrl` returns a stable URL. */
  readonly isPublic: boolean

  /** Issues a short-lived URL the client uploads to directly. */
  createSignedUploadUrl(key: string, options: {
    contentType: string
    expiresInSeconds: number
  }): Promise<SignedUpload>

  /**
   * A URL a browser can read the object from. A stable public URL on a public
   * bucket; a signed, expiring URL otherwise.
   */
  getUrl(key: string, options?: { expiresInSeconds?: number }): Promise<string>

  /** Metadata only — used to check size and declared type before downloading. */
  head(key: string): Promise<StoredObjectInfo | undefined>

  /** The bytes. Used by the image worker to inspect and re-encode. */
  download(key: string): Promise<Buffer>

  /** Server-side write. Used for generated derivatives, never for raw uploads. */
  put(input: PutObjectInput): Promise<void>

  remove(keys: string[]): Promise<void>

  /** Readiness probe. Cheap, and must not throw for an empty bucket. */
  healthCheck(): Promise<void>
}

/** Thrown by an adapter when the backend refuses or is unreachable. */
export class StorageOperationError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options)
    this.name = 'StorageOperationError'
  }
}
