/** Mirrors `toDto` in `server/src/features/media/media.admin.routes.ts`. */

export type MediaStatus = 'pending' | 'processing' | 'ready' | 'failed'

export interface MediaAsset {
  id: string
  status: MediaStatus
  mimeType: string
  byteSize: number
  width: number | null
  height: number | null
  originalFilename: string | null
  alt: string | null
  failureReason: string | null
  createdAt: string
  updatedAt: string
  /** Present only once the asset is `ready` — an unverified object gets no URL. */
  url?: string
  /** Derivatives the worker produced, keyed by size name. */
  variants?: Record<string, string>
}

/** The reservation the server hands back before any bytes are sent. */
export interface UploadTicket {
  assetId: string
  upload: {
    url: string
    method: string
    token: string
    expiresAt: string
  }
  /** Echoed so the client can confirm the *server* chose the path. */
  storageKey: string
}

/**
 * What the server will accept, from `ALLOWED_IMAGE_TYPES`.
 *
 * Checked in the browser as a courtesy: it saves an upload that would be
 * rejected. The server sniffs the leading bytes and believes those, not the
 * declared type, so this list cannot be used to smuggle anything past it.
 */
export const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
] as const

export const ACCEPT_ATTRIBUTE = ACCEPTED_IMAGE_TYPES.join(',')

/** Matches the server's `MEDIA_MAX_BYTES` default. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

export type UploadPhase = 'idle' | 'requesting' | 'uploading' | 'processing' | 'ready' | 'failed'

export interface UploadProgress {
  phase: UploadPhase
  /** 0–100 for the transfer itself; processing has no meaningful percentage. */
  percent: number
  error?: string
}
