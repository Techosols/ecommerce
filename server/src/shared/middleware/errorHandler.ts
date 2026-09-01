/**
 * Centralised error handling (§14.3).
 *
 * Every error leaves through here. In production the response never contains a
 * stack, a SQL fragment, a constraint name or a provider message; the
 * `requestId` is the bridge between what the customer sees and what the logs
 * hold.
 */
import type { NextFunction, Request, Response } from 'express'
import { isProduction } from '../../config/index.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import {
  type AppError,
  ERROR_CODES,
  InternalError,
  MalformedRequestError,
  PayloadTooLargeError,
  isAppError,
} from '../errors/index.js'
import type { ErrorBody } from '../http/respond.js'

const log = createLogger('http.error')

interface BodyParserError extends Error {
  type?: string
  status?: number
}

/** Translates the framework's own errors into ours before they reach the client. */
function normalise(error: unknown): AppError {
  if (isAppError(error)) return error

  const candidate = error as BodyParserError
  if (candidate?.type === 'entity.too.large') {
    return new PayloadTooLargeError()
  }
  if (candidate?.type === 'entity.parse.failed') {
    return new MalformedRequestError('The request body is not valid JSON')
  }
  return new InternalError('An unexpected error occurred', { cause: error })
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Express 5 delegates to the default handler when headers are already sent.
  if (res.headersSent) {
    next(error)
    return
  }

  const appError = normalise(error)
  const logContext = {
    err: appError,
    code: appError.code,
    status: appError.httpStatus,
    method: req.method,
    path: req.originalUrl,
    requestId: req.requestId,
  }

  if (!appError.isOperational) {
    log.error(logContext, 'unhandled error')
  } else if (appError.httpStatus >= 500) {
    log.error(logContext, 'server error')
  } else if (appError.httpStatus === 429) {
    log.info(logContext, 'rate limited')
  } else {
    log.warn(logContext, 'request rejected')
  }

  if (appError.retryAfter !== undefined) {
    res.setHeader('Retry-After', String(appError.retryAfter))
  }

  const body: ErrorBody = {
    success: false,
    message: appError.isOperational ? appError.message : 'An unexpected error occurred',
    code: appError.isOperational ? appError.code : ERROR_CODES.INTERNAL_ERROR,
    requestId: req.requestId,
    ...(appError.details ? { details: appError.details } : {}),
  }

  if (!isProduction && !appError.isOperational) {
    Object.assign(body, {
      stack: appError.stack,
      cause: appError.cause instanceof Error ? appError.cause.message : appError.cause,
    })
  }

  res.status(appError.httpStatus).json(body)
}
