import type { NextFunction, Request, Response } from 'express'
import { ERROR_CODES, NotFoundError } from '../errors/index.js'

/** Any request that matched no route becomes a normal, enveloped 404. */
export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(
    new NotFoundError(`No route matches ${req.method} ${req.path}`, {
      code: ERROR_CODES.ROUTE_NOT_FOUND,
    }),
  )
}
