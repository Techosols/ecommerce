import { api } from '@/lib/api/client'
import { API_ERROR_CODES, ApiError } from '@/lib/api/errors'
import type { MediaAsset, UploadTicket } from './media.types'

/**
 * The media endpoints, and the raw PUT that sits between two of them.
 *
 * The upload is three steps by design (`media.admin.routes.ts`): the API never
 * takes a bucket, a path, a key or a file's bytes. It takes a *claim* about
 * what is coming, hands back somewhere to put it, then inspects what arrived.
 */
export const mediaApi = {
  /** Step 1 — reserve a key and get a short-lived URL to PUT the bytes at. */
  requestUpload: (input: {
    contentType: string
    byteSize: number
    filename?: string
    alt?: string
  }) => api.post<UploadTicket>('/admin/media/uploads', input),

  /** Step 3 — the server inspects the object and queues processing. */
  complete: (assetId: string) => api.post<MediaAsset>(`/admin/media/${assetId}/complete`),

  get: (assetId: string) => api.get<MediaAsset>(`/admin/media/${assetId}`),

  list: (params: { page?: number; limit?: number; status?: string } = {}) =>
    api.list<MediaAsset>('/admin/media', { query: params }),

  updateAlt: (assetId: string, alt: string | null) =>
    api.patch<MediaAsset>(`/admin/media/${assetId}`, { alt }),

  delete: (assetId: string) => api.delete<void>(`/admin/media/${assetId}`),
}

/**
 * Step 2 — the bytes, sent to wherever the ticket points.
 *
 * Deliberately **not** routed through `lib/api/client`: this is not an API
 * call. The URL is a signed URL belonging to the storage provider, it carries
 * its own credential in the path, and attaching the admin's bearer token to a
 * third-party host would be a token leak. In development the URL happens to
 * point back at the API's own dev storage stand-in; the client does not know or
 * care which, and sends whatever the server chose, verbatim.
 *
 * XHR rather than `fetch` for exactly one reason: upload progress. `fetch` has
 * no request-progress event, and an image upload with no feedback is the kind
 * of thing an operator clicks three more times.
 */
export function putBytes(
  ticket: UploadTicket,
  file: File,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open(ticket.upload.method || 'PUT', ticket.upload.url, true)
    request.setRequestHeader('Content-Type', file.type)

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100))
    })

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        resolve()
        return
      }
      reject(
        new ApiError({
          status: request.status,
          code: request.status === 403 ? 'LINK_EXPIRED' : API_ERROR_CODES.STORAGE_ERROR,
          message:
            request.status === 403
              ? 'The upload link expired before the file finished. Try again.'
              : 'The file could not be stored.',
        }),
      )
    })

    request.addEventListener('error', () =>
      reject(
        new ApiError({
          status: 0,
          code: API_ERROR_CODES.NETWORK_ERROR,
          message: 'The upload could not reach the storage service.',
        }),
      ),
    )

    request.addEventListener('abort', () =>
      reject(new DOMException('Upload cancelled', 'AbortError')),
    )

    signal?.addEventListener('abort', () => request.abort(), { once: true })
    request.send(file)
  })
}
