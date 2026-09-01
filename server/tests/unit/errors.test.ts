import { describe, expect, it } from 'vitest'
import {
  AuthorizationError,
  ConflictError,
  DomainRuleError,
  ERROR_CODES,
  InternalError,
  NotFoundError,
  ValidationError,
  isAppError,
} from '../../src/shared/errors/index.js'
import {
  mapDatabaseError,
  isRetryableDatabaseError,
} from '../../src/infrastructure/database/errors.js'

function pgError(code: string, constraint?: string): Error & { code: string } {
  const error = new Error(`pg error ${code}`) as Error & { code: string; constraint?: string }
  error.code = code
  if (constraint) error.constraint = constraint
  return error
}

describe('error codes', () => {
  it('are unique', () => {
    const values = Object.values(ERROR_CODES)
    expect(new Set(values).size).toBe(values.length)
  })

  it('use their own key as the value, so a typo cannot silently alias another code', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toBe(key)
    }
  })
})

describe('AppError hierarchy', () => {
  it('maps each class to its HTTP status', () => {
    expect(new ValidationError().httpStatus).toBe(422)
    expect(new AuthorizationError().httpStatus).toBe(403)
    expect(new NotFoundError().httpStatus).toBe(404)
    expect(new ConflictError().httpStatus).toBe(409)
    expect(new InternalError().httpStatus).toBe(500)
  })

  it('marks only unexpected failures as non-operational', () => {
    expect(new ValidationError().isOperational).toBe(true)
    expect(new InternalError().isOperational).toBe(false)
  })

  it('carries field-level details', () => {
    const error = new ValidationError('bad', {
      details: [{ path: 'body.quantity', message: 'must be at least 1' }],
    })
    expect(error.details).toEqual([{ path: 'body.quantity', message: 'must be at least 1' }])
  })

  it('lets a domain rule choose its own code', () => {
    const error = new DomainRuleError(ERROR_CODES.DOMAIN_RULE_VIOLATION, 'not allowed')
    expect(error.code).toBe(ERROR_CODES.DOMAIN_RULE_VIOLATION)
    expect(isAppError(error)).toBe(true)
  })
})

describe('database error translation', () => {
  it('turns a unique violation into a 409', () => {
    const mapped = mapDatabaseError(pgError('23505'))
    expect(mapped.httpStatus).toBe(409)
    expect(mapped.code).toBe(ERROR_CODES.ALREADY_EXISTS)
  })

  it('turns a foreign key violation into a 422', () => {
    const mapped = mapDatabaseError(pgError('23503'))
    expect(mapped.httpStatus).toBe(422)
    expect(mapped.code).toBe(ERROR_CODES.REFERENCED_RESOURCE_MISSING)
  })

  it('turns a serialization failure into a retryable conflict', () => {
    const mapped = mapDatabaseError(pgError('40001'))
    expect(mapped.httpStatus).toBe(409)
    expect(mapped.code).toBe(ERROR_CODES.CONCURRENT_MODIFICATION)
    expect(mapped.retryAfter).toBe(1)
  })

  it('treats a connection failure as service unavailable', () => {
    const mapped = mapDatabaseError(pgError('08006'))
    expect(mapped.httpStatus).toBe(503)
    expect(mapped.code).toBe(ERROR_CODES.DATABASE_UNAVAILABLE)
  })

  it('never leaks an unknown driver error as operational', () => {
    const mapped = mapDatabaseError(pgError('XX000'))
    expect(mapped.httpStatus).toBe(500)
    expect(mapped.isOperational).toBe(false)
  })

  it('identifies exactly the retryable SQLSTATEs', () => {
    expect(isRetryableDatabaseError(pgError('40001'))).toBe(true)
    expect(isRetryableDatabaseError(pgError('40P01'))).toBe(true)
    expect(isRetryableDatabaseError(pgError('23505'))).toBe(false)
    expect(isRetryableDatabaseError(new Error('not a pg error'))).toBe(false)
  })
})
