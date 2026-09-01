/** Shared primitive types (§2). */

declare const brand: unique symbol
type Brand<T, B> = T & { readonly [brand]: B }

/**
 * Money is always an integer number of minor units (§4.1 rule 2).
 * Branding stops a quantity being passed where an amount is expected.
 */
export type Cents = Brand<number, 'Cents'>

export function cents(value: number): Cents {
  if (!Number.isInteger(value)) {
    throw new TypeError(`Money must be an integer number of minor units, received ${value}`)
  }
  return value as Cents
}

export type ISODateString = string
export type UUID = string

export interface PaginationMeta {
  page: number
  limit: number
  total: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}

export interface CursorMeta {
  limit: number
  nextCursor: string | null
  hasNext: boolean
}

export interface Paginated<T> {
  rows: T[]
  total: number
}
