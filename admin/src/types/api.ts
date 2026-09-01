/**
 * The wire contract, mirrored from the server.
 *
 * These types are a copy of `server/src/shared/http/respond.ts` and
 * `pagination.ts`. They are duplicated rather than shared through a package
 * because the two applications deploy independently and a build-time coupling
 * between them would buy very little; the cost is that a change to the server
 * envelope has to be reflected here, which is why this file is small enough to
 * read in one screen and points at its source.
 */

/** `{ amount, currency }` in integer minor units. Never a float, never a string. */
export interface Money {
  amount: number
  currency: string
}

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

export interface PaginationMeta {
  page: number
  limit: number
  total: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}

export interface CursorMeta {
  nextCursor: string | null
  hasMore: boolean
}

/** What `paginated()` produces: rows in `data`, counts in `meta.pagination`. */
export interface Paginated<T> {
  items: T[]
  pagination: PaginationMeta
  /**
   * Whatever else the endpoint put in `meta` beside the pagination — the
   * store's low-stock default, a campaign's total cost. Carried through rather
   * than dropped, because those figures are the server's answer to a question
   * a page of rows cannot answer: summing one page and calling it the total is
   * exactly the bug the extra exists to prevent.
   */
  meta?: Record<string, unknown>
}

export interface OffsetQuery {
  page?: number
  limit?: number
}
