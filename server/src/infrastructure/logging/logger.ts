/**
 * Structured logging (§15).
 *
 * JSON to stdout, collected by the platform. Redaction is configured once here
 * so no call site has to remember it (§15.2).
 */
import pino, { type Logger, type LoggerOptions } from 'pino'
import { env, isProduction } from '../../config/index.js'
import { getContext } from './context.js'

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'refresh_token_hash',
  'apiKey',
  '*.apiKey',
  'secret',
  '*.secret',
  'card',
  '*.card',
  'cvv',
]

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  base: { env: env.APP_ENV },
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Every line picks up the ambient request/job identifiers automatically.
  mixin() {
    const ctx = getContext()
    if (!ctx) return {}
    return {
      requestId: ctx.requestId,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      ...(ctx.jobId ? { jobId: ctx.jobId, queue: ctx.queue, attempt: ctx.attempt } : {}),
    }
  },
  timestamp: pino.stdTimeFunctions.isoTime,
}

if (env.LOG_PRETTY && !isProduction) {
  options.transport = {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,env' },
  }
}

export const logger: Logger = pino(options)

/** A child logger tagged with the module that owns it. */
export function createLogger(component: string): Logger {
  return logger.child({ component })
}
