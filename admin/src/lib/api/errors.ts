/**
 * Failures the admin can reason about.
 *
 * The server's `code` is the contract — `message` is prose that may change —
 * so every branch in the UI switches on a code from here, mirrored from
 * `server/src/shared/errors/codes.ts`. Only the codes the admin actually acts
 * on are listed; anything else falls through to the server's message.
 */
export const API_ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',

  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  SESSION_REVOKED: 'SESSION_REVOKED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',

  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',

  NOT_FOUND: 'NOT_FOUND',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',

  CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',
  RATE_LIMITED: 'RATE_LIMITED',

  // Catalogue and media — the codes the product and category screens branch on.
  HANDLE_TAKEN: 'HANDLE_TAKEN',
  SKU_TAKEN: 'SKU_TAKEN',
  VARIANT_COMBINATION_EXISTS: 'VARIANT_COMBINATION_EXISTS',
  PRODUCT_NOT_PUBLISHABLE: 'PRODUCT_NOT_PUBLISHABLE',
  PRODUCT_ARCHIVED: 'PRODUCT_ARCHIVED',
  LAST_VARIANT_PROTECTED: 'LAST_VARIANT_PROTECTED',
  CATEGORY_CYCLE: 'CATEGORY_CYCLE',
  CATEGORY_IN_USE: 'CATEGORY_IN_USE',
  DOMAIN_RULE_VIOLATION: 'DOMAIN_RULE_VIOLATION',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  MEDIA_NOT_UPLOADED: 'MEDIA_NOT_UPLOADED',
  MEDIA_TOO_LARGE: 'MEDIA_TOO_LARGE',
  MEDIA_REJECTED: 'MEDIA_REJECTED',
  MEDIA_NOT_READY: 'MEDIA_NOT_READY',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  LINK_EXPIRED: 'LINK_EXPIRED',
  STORAGE_ERROR: 'STORAGE_ERROR',

  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  /** Not from the server: the request never reached it. */
  NETWORK_ERROR: 'NETWORK_ERROR',
} as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES] | (string & {})

export interface ApiErrorDetail {
  path?: string
  message?: string
  [key: string]: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  readonly requestId: string | undefined
  readonly details: ApiErrorDetail[]

  constructor(init: {
    status: number
    code: ApiErrorCode
    message: string
    requestId?: string | undefined
    details?: unknown[] | undefined
  }) {
    super(init.message)
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code
    this.requestId = init.requestId
    this.details = (init.details ?? []) as ApiErrorDetail[]
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return isApiError(error) && codes.includes(error.code)
}

/** The session is gone or was never valid — the fix is signing in again. */
export function isAuthError(error: unknown): boolean {
  return (
    hasCode(
      error,
      API_ERROR_CODES.UNAUTHENTICATED,
      API_ERROR_CODES.TOKEN_EXPIRED,
      API_ERROR_CODES.TOKEN_INVALID,
      API_ERROR_CODES.REFRESH_TOKEN_INVALID,
      API_ERROR_CODES.SESSION_REVOKED,
      API_ERROR_CODES.ACCOUNT_DISABLED,
    ) ||
    (isApiError(error) && error.status === 401)
  )
}

/**
 * Signed in, but not allowed to do this.
 *
 * Two codes because the server distinguishes them: `FORBIDDEN` is
 * `requireStaff()` refusing a customer account outright, while
 * `INSUFFICIENT_PERMISSIONS` is a staff account missing one grant.
 */
export function isForbiddenError(error: unknown): boolean {
  return hasCode(error, API_ERROR_CODES.FORBIDDEN, API_ERROR_CODES.INSUFFICIENT_PERMISSIONS)
}

export function isNotFoundError(error: unknown): boolean {
  return hasCode(error, API_ERROR_CODES.NOT_FOUND, API_ERROR_CODES.ROUTE_NOT_FOUND)
}

export function isNetworkError(error: unknown): boolean {
  return hasCode(error, API_ERROR_CODES.NETWORK_ERROR)
}

export function isValidationError(error: unknown): boolean {
  return hasCode(error, API_ERROR_CODES.VALIDATION_FAILED)
}

/**
 * Field errors keyed by path, for attaching a server rejection to the input
 * that caused it. The server sends `details: [{ path, message }]`.
 */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  if (!isApiError(error)) return {}
  const fields: Record<string, string> = {}
  for (const detail of error.details) {
    if (typeof detail?.path === 'string' && typeof detail.message === 'string') {
      // `body.email` → `email`: the UI names fields, not request envelopes.
      fields[detail.path.replace(/^(body|query|params)\./, '')] = detail.message
    }
  }
  return fields
}

/** A sentence to show a person. Never a stack trace, never a raw code. */
export function messageOf(error: unknown, fallback = 'Something went wrong.'): string {
  if (isNetworkError(error)) return 'Could not reach the server. Check your connection.'
  if (isApiError(error)) {
    if (error.status >= 500) return 'The server had a problem handling that request.'
    return error.message || fallback
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}
