/**
 * Raw body capture for webhook signature verification (§16.6).
 *
 * A signature is computed over the exact bytes the provider sent, so the raw
 * buffer must be kept before any JSON parsing normalises it. This runs *before*
 * `express.json()` on webhook routes only — capturing every request body would
 * double the memory cost of the API for no benefit.
 */
import express, { type Request, type RequestHandler } from 'express'

declare module 'express-serve-static-core' {
  interface Request {
    rawBody?: Buffer
  }
}

export function rawBodyJson(limit = '512kb'): RequestHandler {
  return express.json({
    limit,
    verify: (req, _res, buf) => {
      ;(req as Request).rawBody = Buffer.from(buf)
    },
  })
}
