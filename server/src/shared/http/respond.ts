/**
 * The response envelope (§7.3).
 *
 * Every successful response leaves through one of these helpers, so the shape
 * the frontends parse is defined in exactly one file.
 */
import type { Response } from 'express'
import type { CursorMeta, PaginationMeta } from '../types/common.js'

export interface SuccessBody<T> {
  success: true
  data: T
  meta?: Record<string, unknown>
}

export interface ErrorBody {
  success: false
  message: string
  code: string
  requestId?: string
  details?: unknown[]
}

export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>): Response {
  const body: SuccessBody<T> = { success: true, data, ...(meta ? { meta } : {}) }
  return res.status(200).json(body)
}

export function created<T>(res: Response, data: T, location?: string): Response {
  if (location) res.setHeader('Location', location)
  const body: SuccessBody<T> = { success: true, data }
  return res.status(201).json(body)
}

/** 202: the request was accepted and the work is queued (§7.3). */
export function accepted<T>(res: Response, data: T): Response {
  const body: SuccessBody<T> = { success: true, data }
  return res.status(202).json(body)
}

export function noContent(res: Response): Response {
  return res.status(204).end()
}

/**
 * A page of rows.
 *
 * `extra` is for meta that belongs to the collection rather than the page — a
 * list's own closed vocabularies, most often. Shipping the statuses a returns
 * queue can be filtered by alongside the queue is what stops the client keeping
 * a copy that goes stale the first time a value is added.
 */
export function paginated<T>(
  res: Response,
  rows: T[],
  pagination: PaginationMeta,
  extra?: Record<string, unknown>,
): Response {
  const body: SuccessBody<T[]> = {
    success: true,
    data: rows,
    meta: { pagination, ...(extra ?? {}) },
  }
  return res.status(200).json(body)
}

export function cursorPaginated<T>(res: Response, rows: T[], cursor: CursorMeta): Response {
  const body: SuccessBody<T[]> = { success: true, data: rows, meta: { cursor } }
  return res.status(200).json(body)
}
