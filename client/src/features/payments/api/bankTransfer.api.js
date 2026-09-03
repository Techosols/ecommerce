import { api } from '@/lib/api'

/**
 * Paying by bank transfer.
 *
 * ── Why every call carries the order number and email ────────────────────────
 *
 * Because most of these customers have no account. Bank transfer is chosen at
 * checkout, the shopper leaves to go and make the transfer, and comes back
 * later — often on a different device from the one they ordered on. The pair
 * the confirmation page already gave them is the credential; the server scopes
 * these routes exactly the way it scopes the guest order lookup, with the same
 * rate limit and the same indistinguishable failure on either half being wrong.
 *
 * A signed-in customer sends the same pair and the server matches on ownership
 * first, so the flow is identical either way and there is only one of it.
 *
 * ── The upload is four steps, not one ────────────────────────────────────────
 *
 *   1. `requestUpload` — the shop hands out a short-lived ticket
 *   2. `putBytes`      — the file goes straight to storage, never through the API
 *   3. `completeUpload`— the server sniffs the bytes and queues processing
 *   4. `uploadStatus`  — polled until the image is `ready`
 *
 * Step 4 is not optional: `submitProof` refuses an image that has not finished
 * processing, and processing is a background job. A page that skipped it would
 * submit too early, read a refusal, and burn the submission rate limit.
 */
export const bankTransferApi = {
  /**
   * Everything the payment page needs in one request: where to send the money,
   * what the order owes, and how any previous receipt was received.
   */
  details: (claim) => api.post('/storefront/payments/bank-transfer', claim),

  requestUpload: (claim, file) =>
    api.post('/storefront/payments/bank-transfer/uploads', {
      ...claim,
      contentType: file.type,
      byteSize: file.size,
      filename: file.name,
    }),

  completeUpload: (claim, assetId) =>
    api.post('/storefront/payments/bank-transfer/uploads/complete', { ...claim, assetId }),

  uploadStatus: (claim, assetId) =>
    api.post('/storefront/payments/bank-transfer/uploads/status', { ...claim, assetId }),

  submitProof: (claim, body) =>
    api.post('/storefront/payments/bank-transfer/proofs', { ...claim, ...body }),
}

/** What the server will accept, so a wrong file is refused before it is sent. */
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']
export const ACCEPT_ATTRIBUTE = ACCEPTED_IMAGE_TYPES.join(',')
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024

/**
 * The reasons to refuse a file without asking the server.
 *
 * A phone photo of a bank app is routinely over the limit, and finding that out
 * after a slow upload on mobile data is the worst possible moment.
 */
export function validateReceipt(file) {
  if (!file) return 'Choose a screenshot of the transfer.'
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return 'That file is not an image. A screenshot or a photo of the receipt is what we need.'
  }
  if (file.size > MAX_RECEIPT_BYTES) {
    return 'That image is over 10 MB. A screenshot rather than a full-resolution photo will do.'
  }
  if (file.size === 0) return 'That file is empty.'
  return null
}

/**
 * The bytes, sent straight to storage.
 *
 * `XMLHttpRequest` rather than `fetch` for one reason: upload progress. A
 * receipt going up over mobile data with no indication of movement is a page
 * somebody closes.
 *
 * Deliberately not `api.post` — the ticket URL is storage, not the API, and it
 * must not receive the access token or the session cookies.
 */
export function putBytes(ticket, file, onProgress, signal) {
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
        new Error(
          request.status === 403
            ? 'The upload link expired before the file finished. Try again.'
            : 'The image could not be stored. Try again.',
        ),
      )
    })

    request.addEventListener('error', () =>
      reject(new Error('We could not reach the shop. Check your connection and try again.')),
    )
    request.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))

    signal?.addEventListener('abort', () => request.abort(), { once: true })
    request.send(file)
  })
}
