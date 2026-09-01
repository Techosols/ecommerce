/**
 * Shared validation primitives (§17.2).
 *
 * Every schema in the codebase is strict: unknown keys are rejected rather than
 * silently dropped, which is also what closes mass assignment (§16.3).
 */
import { z } from 'zod'

export const uuidParam = z.strictObject({ id: z.uuid() })

// Normalise first, then validate: zod applies checks in pipeline order, so a
// trailing space would otherwise be rejected instead of trimmed away.
export const emailField = z.string().trim().toLowerCase().pipe(z.email().max(255))

/**
 * A URL that a browser may be asked to navigate to.
 *
 * `z.url()` alone accepts any well-formed URL, `javascript:alert(1)` included —
 * which, rendered as a link on a page the store operator does not control, is
 * stored XSS. Anything that will become an `href` is restricted to http(s)
 * here, at the boundary, rather than relying on every consumer to remember.
 */
export const webUrlField = z
  .string()
  .trim()
  .max(500)
  .pipe(z.url())
  .refine(
    (value) => {
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol)
      } catch {
        return false
      }
    },
    { message: 'must be an http(s) URL' },
  )

export const slugField = z
  .string()
  .min(1)
  .max(140)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase hyphenated slug')

export const countryCodeField = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, 'must be a two-letter ISO country code')

/** Money crosses the boundary only as an integer number of minor units (§17.3). */
export const centsField = z.number().int().nonnegative()

export const dateRangeQuery = z
  .object({
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  .refine((v) => !v.from || !v.to || new Date(v.from) <= new Date(v.to), {
    message: '`from` must not be after `to`',
    path: ['from'],
  })

/** Sort keys always come from an allowlist — never interpolated from input. */
export function sortQuery<const T extends readonly string[]>(allowed: T) {
  return z.object({
    sort: z
      .string()
      .optional()
      .superRefine((value, ctx) => {
        if (value === undefined) return
        const field = value.startsWith('-') ? value.slice(1) : value
        if (!allowed.includes(field)) {
          ctx.addIssue({
            code: 'custom',
            message: `must be one of: ${allowed.join(', ')} (prefix with "-" for descending)`,
          })
        }
      }),
  })
}

export function parseSort<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  fallback: T[number],
): { column: T[number]; direction: 'ASC' | 'DESC' } {
  if (!value) return { column: fallback, direction: 'DESC' }
  const descending = value.startsWith('-')
  const field = descending ? value.slice(1) : value
  const column = (allowed.includes(field) ? field : fallback) as T[number]
  return { column, direction: descending ? 'DESC' : 'ASC' }
}
