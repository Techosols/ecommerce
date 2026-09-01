/**
 * Development-only object storage endpoints (§46).
 *
 * The local provider issues "signed" upload URLs that point back at this
 * server, so a developer without a Supabase project runs the exact same
 * three-step client flow: request an upload URL, PUT the bytes at it, then
 * call `complete`. These routes are what those URLs resolve to.
 *
 * They are mounted only when `STORAGE_PROVIDER=local`, and config already
 * refuses to let that provider be selected in production, so this surface
 * cannot exist on a deployed instance. Even so it is deliberately narrow: the
 * upload token is single-use and short-lived, the key is never taken from the
 * request, and the download route serves bytes with a content type that forbids
 * the browser from sniffing or executing them.
 */
import express, { Router } from 'express'
import { env, isProduction } from '../config/index.js'
import { getStorage } from '../infrastructure/storage/index.js'
import { LocalStorageProvider } from '../infrastructure/storage/providers/local.js'
import { assertSafeKey } from '../infrastructure/storage/keys.js'
import { sniffImageType, SNIFF_BYTES } from '../infrastructure/storage/sniff.js'
import { createLogger } from '../infrastructure/logging/logger.js'

const log = createLogger('storage.local')

export const LOCAL_STORAGE_PATH = '/local-storage'

export function buildLocalStorageRouter(): Router {
  const router = Router()

  router.put(
    '/upload/:token',
    express.raw({ type: '*/*', limit: env.MEDIA_MAX_BYTES }),
    (req, res, next) => {
      const provider = getStorage()
      if (!(provider instanceof LocalStorageProvider)) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } })
        return
      }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      if (body.length === 0) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Empty body' } })
        return
      }

      provider
        .completeUpload(req.params.token, body)
        .then(({ key }) => {
          log.debug({ key, byteSize: body.length }, 'local upload stored')
          res.status(200).json({ key })
        })
        .catch(() => {
          // Deliberately uniform: an expired token and an unknown token look
          // the same, so this stand-in behaves like a real signed URL would.
          res.status(403).json({
            error: { code: 'FORBIDDEN', message: 'Upload URL is invalid or has expired' },
          })
        })
        .catch(next)
    },
  )

  router.get(/^\/objects\/(.+)$/, (req, res) => {
    const provider = getStorage()
    if (!(provider instanceof LocalStorageProvider)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } })
      return
    }
    const key = req.params[0] ?? ''
    try {
      assertSafeKey(key)
    } catch {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid key' } })
      return
    }

    provider
      .download(key)
      .then((body) => {
        // Serve the type the bytes actually are, never a stored claim, and
        // forbid sniffing. A stray non-image in the dev bucket is downloaded,
        // not rendered.
        const sniffed = sniffImageType(body.subarray(0, SNIFF_BYTES))
        res.setHeader('Content-Type', sniffed ?? 'application/octet-stream')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.setHeader('Content-Disposition', 'inline')
        res.setHeader('Cache-Control', 'public, max-age=60')
        res.status(200).end(body)
      })
      .catch(() => {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Object not found' } })
      })
  })

  return router
}

/** True when the dev storage surface should exist at all. */
export function localStorageEnabled(): boolean {
  return env.STORAGE_PROVIDER === 'local' && !isProduction
}
