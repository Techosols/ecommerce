/**
 * Postgres SQLSTATE → AppError translation (§14.2).
 *
 * Mapped once, at the data boundary, so that no service ever contains
 * `if (err.code === '23505')`.
 */
import {
  ConflictError,
  DomainRuleError,
  ERROR_CODES,
  InternalError,
  ServiceUnavailableError,
  type AppError,
} from '../../shared/errors/index.js'

export interface PostgresError extends Error {
  code?: string
  constraint?: string
  detail?: string
  table?: string
  column?: string
}

/** SQLSTATEs that are transient by definition and safe to retry (§18.5). */
export const RETRYABLE_SQLSTATES = new Set(['40001', '40P01'])

export function isPostgresError(error: unknown): error is PostgresError {
  return error instanceof Error && typeof (error as PostgresError).code === 'string'
}

export function isRetryableDatabaseError(error: unknown): boolean {
  return isPostgresError(error) && !!error.code && RETRYABLE_SQLSTATES.has(error.code)
}

/**
 * Constraint name → specific error code. Features register their own entries so
 * that a unique violation becomes a meaningful message instead of a generic 409.
 */
const constraintCodes = new Map<string, { code: string; message: string }>()

export function registerConstraintError(constraint: string, code: string, message: string): void {
  constraintCodes.set(constraint, { code, message })
}

export function mapDatabaseError(error: unknown): AppError {
  if (!isPostgresError(error) || !error.code) {
    return new InternalError('Database operation failed', { cause: error })
  }

  switch (error.code) {
    case '23505': {
      // unique_violation
      const known = error.constraint ? constraintCodes.get(error.constraint) : undefined
      if (known) {
        return new ConflictError(known.message, {
          code: known.code as never,
          cause: error,
        })
      }
      return new ConflictError('That record already exists', {
        code: ERROR_CODES.ALREADY_EXISTS,
        cause: error,
      })
    }

    case '23503': // foreign_key_violation
      return new DomainRuleError(
        ERROR_CODES.REFERENCED_RESOURCE_MISSING,
        'A referenced record does not exist',
        { cause: error },
      )

    case '23514': // check_violation — normally a bug, surfaced as a domain rule
    case '23502': // not_null_violation
      return new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'The operation violates a data integrity rule',
        { cause: error },
      )

    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return new ConflictError('The record changed while you were working on it; please retry', {
        code: ERROR_CODES.CONCURRENT_MODIFICATION,
        cause: error,
        retryAfter: 1,
      })

    case '55P03': // lock_not_available
    case '57014': // query_canceled (statement_timeout)
      return new ConflictError('The resource is busy; please retry', {
        code: ERROR_CODES.RESOURCE_BUSY,
        cause: error,
        retryAfter: 2,
      })

    default:
      // Class 08 — connection exceptions; 53 — insufficient resources.
      if (error.code.startsWith('08') || error.code.startsWith('53')) {
        return new ServiceUnavailableError('The database is unavailable', {
          code: ERROR_CODES.DATABASE_UNAVAILABLE,
          cause: error,
        })
      }
      return new InternalError('Database operation failed', { cause: error })
  }
}
