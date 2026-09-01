/**
 * Request validation (§17).
 *
 * The parsed result *replaces* `req.params` / `req.query` / `req.body`, so a
 * handler cannot accidentally reach the raw value. Schemas are strict, which
 * makes an unexpected field a 422 rather than a silent drop — and closes mass
 * assignment (§16.3).
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { type ZodError, type ZodType } from 'zod'
import { ValidationError, type ErrorDetail } from '../errors/index.js'

export interface ValidationSchemas {
  params?: ZodType
  query?: ZodType
  body?: ZodType
}

/** Express 5 makes `req.query` a getter, so validated values go in a side channel. */
declare module 'express-serve-static-core' {
  interface Request {
    validatedQuery?: unknown
  }
}

export function zodIssuesToDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.')
    // `unrecognized_keys` reports the offending names rather than a path.
    if (issue.code === 'unrecognized_keys') {
      return {
        path: path || undefined,
        message: `unexpected field(s): ${issue.keys.join(', ')}`,
      } as ErrorDetail
    }
    return { path: path || undefined, message: issue.message } as ErrorDetail
  })
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const details: ErrorDetail[] = []

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params)
      if (result.success) {
        req.params = result.data as Request['params']
      } else {
        details.push(...prefix('params', zodIssuesToDetails(result.error)))
      }
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query)
      if (result.success) {
        req.validatedQuery = result.data
      } else {
        details.push(...prefix('query', zodIssuesToDetails(result.error)))
      }
    }

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body)
      if (result.success) {
        req.body = result.data
      } else {
        details.push(...prefix('body', zodIssuesToDetails(result.error)))
      }
    }

    if (details.length > 0) {
      next(new ValidationError('The request failed validation', { details }))
      return
    }
    next()
  }
}

function prefix(scope: string, details: ErrorDetail[]): ErrorDetail[] {
  return details.map((detail) => ({
    ...detail,
    path: detail.path ? `${scope}.${detail.path}` : scope,
  }))
}

/** Typed accessor for the validated query, since Express 5 will not let us assign it. */
export function validatedQuery<T>(req: Request): T {
  return req.validatedQuery as T
}
