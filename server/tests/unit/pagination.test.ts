import { describe, expect, it } from 'vitest'
import {
  buildCursorMeta,
  buildPaginationMeta,
  decodeCursor,
  encodeCursor,
  offsetPaginationQuery,
  toOffset,
} from '../../src/shared/http/pagination.js'
import { MAX_PAGE_SIZE } from '../../src/config/constants.js'
import { MalformedRequestError } from '../../src/shared/errors/index.js'

describe('offset pagination', () => {
  it('applies defaults', () => {
    expect(offsetPaginationQuery.parse({})).toEqual({ page: 1, limit: 20 })
  })

  it('coerces string query values', () => {
    expect(offsetPaginationQuery.parse({ page: '3', limit: '50' })).toEqual({ page: 3, limit: 50 })
  })

  it('caps the page size', () => {
    expect(() => offsetPaginationQuery.parse({ limit: String(MAX_PAGE_SIZE + 1) })).toThrow()
  })

  it('rejects a zero or negative page', () => {
    expect(() => offsetPaginationQuery.parse({ page: '0' })).toThrow()
    expect(() => offsetPaginationQuery.parse({ page: '-1' })).toThrow()
  })

  it('computes the SQL offset', () => {
    expect(toOffset({ page: 1, limit: 20 })).toEqual({ limit: 20, offset: 0 })
    expect(toOffset({ page: 4, limit: 25 })).toEqual({ limit: 25, offset: 75 })
  })

  it('builds metadata the frontend can navigate with', () => {
    expect(buildPaginationMeta({ page: 2, limit: 20 }, 137)).toEqual({
      page: 2,
      limit: 20,
      total: 137,
      totalPages: 7,
      hasNext: true,
      hasPrev: true,
    })
  })

  it('reports no pages for an empty collection', () => {
    expect(buildPaginationMeta({ page: 1, limit: 20 }, 0)).toMatchObject({
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    })
  })
})

describe('cursor pagination', () => {
  it('round-trips a cursor', () => {
    const cursor = encodeCursor({ sortValue: '2026-08-29T10:00:00.000Z', id: 'abc' })
    expect(decodeCursor(cursor)).toEqual({ sortValue: '2026-08-29T10:00:00.000Z', id: 'abc' })
  })

  it('rejects a malformed cursor with a 400, not a crash', () => {
    expect(() => decodeCursor('not-base64-json')).toThrow(MalformedRequestError)
  })

  it('trims the sentinel row and exposes the next cursor', () => {
    const rows = [
      { id: 'a', createdAt: '3' },
      { id: 'b', createdAt: '2' },
      { id: 'c', createdAt: '1' },
    ]
    const result = buildCursorMeta(rows, 2, (row) => ({ sortValue: row.createdAt, id: row.id }))

    expect(result.rows).toHaveLength(2)
    expect(result.meta.hasNext).toBe(true)
    expect(decodeCursor(result.meta.nextCursor!)).toEqual({ sortValue: '2', id: 'b' })
  })

  it('reports the end of the collection', () => {
    const rows = [{ id: 'a', createdAt: '1' }]
    const result = buildCursorMeta(rows, 5, (row) => ({ sortValue: row.createdAt, id: row.id }))
    expect(result.meta.hasNext).toBe(false)
    expect(result.meta.nextCursor).toBeNull()
  })
})
