import { useCallback, useRef, useState } from 'react'
import { messageOf } from '@/lib/api/errors'
import { mediaApi, putBytes } from './media.api'
import {
  ACCEPTED_IMAGE_TYPES,
  DEFAULT_MAX_BYTES,
  type MediaAsset,
  type UploadProgress,
} from './media.types'

/** How long to wait for the worker to re-encode an image before giving up. */
const PROCESSING_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 800

export interface UploadOptions {
  alt?: string
  maxBytes?: number
}

/** A local check that mirrors the server's, so an obvious reject costs no upload. */
export function validateImageFile(file: File, maxBytes = DEFAULT_MAX_BYTES): string | null {
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return `${file.name}: only JPEG, PNG, WebP, AVIF and GIF images are accepted.`
  }
  if (file.size === 0) return `${file.name} is empty.`
  if (file.size > maxBytes) {
    return `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`
  }
  return null
}

/**
 * One file, all the way from a `File` to a `ready` asset.
 *
 * The server's flow is deliberately three calls, and the fourth step — waiting
 * — is the one that is easy to forget: `complete` returns **202 processing**,
 * because the re-encode happens in the worker. Attaching an asset before it is
 * `ready` is refused by `assertReady`, so this polls until the worker has
 * finished and only then reports success.
 *
 * A failed asset carries the server's own `failureReason` ("file content is not
 * a recognised image"), which is more useful than anything invented here.
 */
export function useImageUpload() {
  const [progress, setProgress] = useState<UploadProgress>({ phase: 'idle', percent: 0 })
  const abortRef = useRef<AbortController | null>(null)

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setProgress({ phase: 'idle', percent: 0 })
  }, [])

  const upload = useCallback(
    async (file: File, options: UploadOptions = {}): Promise<MediaAsset> => {
      const localError = validateImageFile(file, options.maxBytes)
      if (localError) {
        setProgress({ phase: 'failed', percent: 0, error: localError })
        throw new Error(localError)
      }

      const controller = new AbortController()
      abortRef.current = controller

      try {
        setProgress({ phase: 'requesting', percent: 0 })
        const ticket = await mediaApi.requestUpload({
          contentType: file.type,
          byteSize: file.size,
          filename: file.name,
          ...(options.alt ? { alt: options.alt } : {}),
        })

        setProgress({ phase: 'uploading', percent: 0 })
        await putBytes(
          ticket,
          file,
          (percent) => setProgress({ phase: 'uploading', percent }),
          controller.signal,
        )

        setProgress({ phase: 'processing', percent: 100 })
        let asset = await mediaApi.complete(ticket.assetId)

        const deadline = Date.now() + PROCESSING_TIMEOUT_MS
        while (asset.status !== 'ready' && asset.status !== 'failed') {
          if (Date.now() > deadline) {
            throw new Error(
              'The image is taking longer than expected to process. It will appear once the server finishes.',
            )
          }
          if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
          asset = await mediaApi.get(ticket.assetId)
        }

        if (asset.status === 'failed') {
          throw new Error(asset.failureReason ?? 'The server rejected that image.')
        }

        setProgress({ phase: 'ready', percent: 100 })
        return asset
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setProgress({ phase: 'idle', percent: 0 })
          throw error
        }
        const message = messageOf(error, 'The upload failed.')
        setProgress({ phase: 'failed', percent: 0, error: message })
        throw error
      } finally {
        abortRef.current = null
      }
    },
    [],
  )

  const reset = useCallback(() => setProgress({ phase: 'idle', percent: 0 }), [])

  return {
    upload,
    cancel,
    reset,
    progress,
    isUploading:
      progress.phase !== 'idle' && progress.phase !== 'ready' && progress.phase !== 'failed',
  }
}
