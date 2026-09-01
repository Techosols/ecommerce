/**
 * Pagination helpers (§7.4).
 *
 * Two strategies, each used where it fits: offset for admin tables that need a
 * total and page jumps, keyset/cursor for storefront listings and feeds where
 * deep offsets degrade and page drift shows duplicates. An endpoint picks one
 * and never accepts both.
 */
import { z } from 'zod'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../config/index.js'
import { MalformedRequestError } from '../errors/index.js'
import type { CursorMeta, PaginationMeta } from '../types/common.js'

export const offsetPaginationQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
})

export const cursorPaginationQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
})

export type OffsetPagination = z.infer<typeof offsetPaginationQuery>
export type CursorPagination = z.infer<typeof cursorPaginationQuery>

export function toOffset(pagination: OffsetPagination): { limit: number; offset: number } {
  return { limit: pagination.limit, offset: (pagination.page - 1) * pagination.limit }
}

export function buildPaginationMeta(pagination: OffsetPagination, total: number): PaginationMeta {
  const totalPages = pagination.limit > 0 ? Math.ceil(total / pagination.limit) : 0
  return {
    page: pagination.page,
    limit: pagination.limit,
    total,
    totalPages,
    hasNext: pagination.page < totalPages,
    hasPrev: pagination.page > 1,
  }
}

/** Cursors are opaque to clients: base64url of the sort key plus the row id. */
export function encodeCursor(value: { sortValue: string; id: string }): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): { sortValue: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { sortValue?: unknown }).sortValue === 'string' &&
      typeof (parsed as { id?: unknown }).id === 'string'
    ) {
      return parsed as { sortValue: string; id: string }
    }
    throw new Error('malformed cursor payload')
  } catch (error) {
    throw new MalformedRequestError('The pagination cursor is not valid', { cause: error })
  }
}

export function buildCursorMeta<T>(
  rows: T[],
  limit: number,
  toCursor: (row: T) => { sortValue: string; id: string },
): { rows: T[]; meta: CursorMeta } {
  // Callers fetch limit + 1 to learn whether another page exists.
  const hasNext = rows.length > limit
  const page = hasNext ? rows.slice(0, limit) : rows
  const last = page.at(-1)
  return {
    rows: page,
    meta: {
      limit,
      hasNext,
      nextCursor: hasNext && last ? encodeCursor(toCursor(last)) : null,
    },
  }
}
