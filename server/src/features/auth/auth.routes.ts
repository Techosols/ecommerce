/**
 * Auth routes (§7.6).
 *
 * Routes stay lightweight: endpoint, middleware, controller. The per-route rate
 * limits are the interesting part — credential endpoints are the ones an
 * attacker hammers, so each gets a limit matched to how a real user behaves
 * (§16.7).
 */
import { Router, type Router as ExpressRouter } from 'express'
import { validate } from '../../shared/middleware/validate.js'
import { authenticate, authenticateOptional } from '../../shared/middleware/authenticate.js'
import { emailKeyedLimiter, ipLimiter, userLimiter } from '../../shared/middleware/rateLimit.js'
import { authController } from './auth.controller.js'
import {
  acceptInvitationSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  sessionIdParam,
  verifyEmailSchema,
} from './auth.validators.js'

export const authRoutes: ExpressRouter = Router()

// ── Registration and verification ───────────────────────────────────────────

authRoutes.post(
  '/register',
  ipLimiter({ windowMs: 60 * 60_000, limit: 5 }),
  validate({ body: registerSchema }),
  authController.register,
)

authRoutes.post(
  '/email/verify',
  ipLimiter({ windowMs: 15 * 60_000, limit: 20 }),
  validate({ body: verifyEmailSchema }),
  authController.verifyEmail,
)

authRoutes.post(
  '/email/resend',
  emailKeyedLimiter({ windowMs: 60 * 60_000, limit: 3 }),
  validate({ body: resendVerificationSchema }),
  authController.resendVerification,
)

// ── Login and sessions ──────────────────────────────────────────────────────

authRoutes.post(
  '/login',
  // Two limits together: per address, so one account cannot be ground down,
  // and per IP, so one attacker cannot spray many accounts.
  emailKeyedLimiter({ windowMs: 15 * 60_000, limit: 5 }),
  ipLimiter({ windowMs: 15 * 60_000, limit: 20 }),
  validate({ body: loginSchema }),
  authController.login,
)

authRoutes.post(
  '/refresh',
  ipLimiter({ windowMs: 15 * 60_000, limit: 60 }),
  validate({ body: refreshSchema }),
  authController.refresh,
)

// Logout works with or without a valid access token: a client whose access
// token has expired must still be able to end its session.
authRoutes.post(
  '/logout',
  authenticateOptional(),
  validate({ body: logoutSchema }),
  authController.logout,
)

authRoutes.post('/logout-all', authenticate(), authController.logoutAll)

authRoutes.get('/me', authenticate(), authController.me)

authRoutes.get('/sessions', authenticate(), authController.listSessions)

authRoutes.delete(
  '/sessions/:id',
  authenticate(),
  validate({ params: sessionIdParam }),
  authController.revokeSession,
)

// ── Passwords ───────────────────────────────────────────────────────────────

authRoutes.post(
  '/password/forgot',
  emailKeyedLimiter({ windowMs: 15 * 60_000, limit: 5 }),
  ipLimiter({ windowMs: 60 * 60_000, limit: 20 }),
  validate({ body: forgotPasswordSchema }),
  authController.forgotPassword,
)

authRoutes.post(
  '/password/reset',
  ipLimiter({ windowMs: 15 * 60_000, limit: 10 }),
  validate({ body: resetPasswordSchema }),
  authController.resetPassword,
)

authRoutes.post(
  '/invitation/accept',
  ipLimiter({ windowMs: 15 * 60_000, limit: 10 }),
  validate({ body: acceptInvitationSchema }),
  authController.acceptInvitation,
)

authRoutes.post(
  '/password/change',
  authenticate(),
  userLimiter({ windowMs: 15 * 60_000, limit: 5 }),
  validate({ body: changePasswordSchema }),
  authController.changePassword,
)
