/**
 * The error hierarchy from §14.1.
 *
 * `isOperational` distinguishes "an expected outcome expressed as an error"
 * (a 404, a failed business rule) from "something we did not anticipate".
 * Only the latter is logged at `error` level with a full stack.
 */
import { ERROR_CODES, type ErrorCode } from './codes.js'

export interface ErrorDetail {
  path?: string
  message: string
  [key: string]: unknown
}

export interface AppErrorOptions {
  code?: ErrorCode
  message?: string
  details?: ErrorDetail[]
  cause?: unknown
  /** Seconds the client should wait before retrying (429/409). */
  retryAfter?: number
}

export abstract class AppError extends Error {
  abstract readonly httpStatus: number
  readonly code: ErrorCode
  readonly details: ErrorDetail[] | undefined
  readonly retryAfter: number | undefined
  readonly isOperational: boolean = true

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(options.message ?? message, options.cause !== undefined ? { cause: options.cause } : {})
    this.name = new.target.name
    this.code = options.code ?? code
    this.details = options.details
    this.retryAfter = options.retryAfter
    Error.captureStackTrace?.(this, new.target)
  }
}

export class ValidationError extends AppError {
  readonly httpStatus = 422
  constructor(message = 'The request failed validation', options: AppErrorOptions = {}) {
    super(ERROR_CODES.VALIDATION_FAILED, message, options)
  }
}

export class MalformedRequestError extends AppError {
  readonly httpStatus = 400
  constructor(message = 'The request could not be parsed', options: AppErrorOptions = {}) {
    super(ERROR_CODES.MALFORMED_REQUEST, message, options)
  }
}

export class AuthenticationError extends AppError {
  readonly httpStatus = 401
  constructor(message = 'Authentication is required', options: AppErrorOptions = {}) {
    super(ERROR_CODES.UNAUTHENTICATED, message, options)
  }
}

export class AuthorizationError extends AppError {
  readonly httpStatus = 403
  constructor(
    message = 'You are not allowed to perform this action',
    options: AppErrorOptions = {},
  ) {
    super(ERROR_CODES.FORBIDDEN, message, options)
  }
}

export class NotFoundError extends AppError {
  readonly httpStatus = 404
  constructor(message = 'Resource not found', options: AppErrorOptions = {}) {
    super(ERROR_CODES.NOT_FOUND, message, options)
  }
}

export class ConflictError extends AppError {
  readonly httpStatus = 409
  constructor(
    message = 'The request conflicts with the current state',
    options: AppErrorOptions = {},
  ) {
    super(ERROR_CODES.CONCURRENT_MODIFICATION, message, options)
  }
}

export class GoneError extends AppError {
  readonly httpStatus = 410
  constructor(message = 'This link is no longer valid', options: AppErrorOptions = {}) {
    super(ERROR_CODES.LINK_EXPIRED, message, options)
  }
}

/** A business rule said no. The workhorse of the domain layer (§14.1). */
export class DomainRuleError extends AppError {
  readonly httpStatus = 422
  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(code, message, options)
  }
}

export class RateLimitError extends AppError {
  readonly httpStatus = 429
  constructor(message = 'Too many requests', options: AppErrorOptions = {}) {
    super(ERROR_CODES.RATE_LIMITED, message, options)
  }
}

export class PayloadTooLargeError extends AppError {
  readonly httpStatus = 413
  constructor(message = 'Request body is too large', options: AppErrorOptions = {}) {
    super(ERROR_CODES.PAYLOAD_TOO_LARGE, message, options)
  }
}

export class ExternalServiceError extends AppError {
  readonly httpStatus = 502
  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(code, message, options)
  }
}

export class ServiceUnavailableError extends AppError {
  readonly httpStatus = 503
  constructor(message = 'Service temporarily unavailable', options: AppErrorOptions = {}) {
    super(ERROR_CODES.SERVICE_UNAVAILABLE, message, options)
  }
}

/** Not operational: something we did not anticipate. Always logged with a stack. */
export class InternalError extends AppError {
  readonly httpStatus = 500
  override readonly isOperational = false
  constructor(message = 'An unexpected error occurred', options: AppErrorOptions = {}) {
    super(ERROR_CODES.INTERNAL_ERROR, message, options)
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
