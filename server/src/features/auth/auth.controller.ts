/**
 * Auth controllers (§1.2).
 *
 * Thin by rule: take the already-validated input, call one service method,
 * shape the response. The only logic here is HTTP — cookies and status codes.
 */
import type { Request, Response } from 'express'
import { accepted, noContent, ok } from '../../shared/http/respond.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { NotFoundError, ValidationError } from '../../shared/errors/index.js'
import { usersService } from '../users/index.js'
import { invitationsService } from '../users/users.invitations.js'
import { authService } from './auth.service.js'
import { clearRefreshCookie, readRefreshToken, setRefreshCookie } from './auth.cookies.js'
import { toCurrentUserDto, toSessionDto, toTokenDto } from './auth.mapper.js'
import type { RequestContextInput } from './auth.types.js'

function contextOf(req: Request): RequestContextInput {
  return {
    ip: req.ip ?? null,
    // Bounded: a header is attacker-controlled and this is stored.
    userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
  }
}

export const authController = {
  async register(req: Request, res: Response) {
    const body = req.body as {
      email: string
      password: string
      firstName?: string
      lastName?: string
    }

    await authService.register({ ...body, context: contextOf(req) })

    // 202 with an identical body whether or not the address was already
    // registered: the response must not be an enumeration oracle (§6.4).
    return accepted(res, {
      message: 'If that address can be registered, a verification email is on its way.',
    })
  },

  async login(req: Request, res: Response) {
    const { email, password } = req.body as { email: string; password: string }
    const { tokens, user } = await authService.login({ email, password, context: contextOf(req) })

    setRefreshCookie(res, tokens.refreshToken, tokens.refreshExpiresAt)

    const actor = await usersService.resolveActor(user.id, tokens.sessionId)
    if (!actor) throw new NotFoundError('User not found')

    return ok(res, { ...toTokenDto(tokens), user: toCurrentUserDto(user, actor) })
  },

  async refresh(req: Request, res: Response) {
    const refreshToken = readRefreshToken(req)
    if (!refreshToken) {
      throw new ValidationError('A refresh token is required', {
        details: [{ path: 'cookie.refresh_token', message: 'missing' }],
      })
    }

    const tokens = await authService.refresh(refreshToken, contextOf(req))
    setRefreshCookie(res, tokens.refreshToken, tokens.refreshExpiresAt)
    return ok(res, toTokenDto(tokens))
  },

  async logout(req: Request, res: Response) {
    await authService.logout(readRefreshToken(req), req.actor?.userId)
    clearRefreshCookie(res)
    return noContent(res)
  },

  async logoutAll(req: Request, res: Response) {
    const actor = requireActor(req)
    const revoked = await authService.logoutAll(actor.userId)
    clearRefreshCookie(res)
    return ok(res, { sessionsRevoked: revoked })
  },

  async me(req: Request, res: Response) {
    const actor = requireActor(req)
    const user = await usersService.getById(actor.userId)
    if (!user) throw new NotFoundError('User not found')
    return ok(res, toCurrentUserDto(user, actor))
  },

  async listSessions(req: Request, res: Response) {
    const actor = requireActor(req)
    const sessions = await authService.listSessions(actor.userId)
    return ok(
      res,
      sessions.map((session) => toSessionDto(session, actor.sessionId)),
    )
  },

  async revokeSession(req: Request, res: Response) {
    const actor = requireActor(req)
    await authService.revokeSession(actor.userId, req.params.id as string)
    return noContent(res)
  },

  async verifyEmail(req: Request, res: Response) {
    const { token } = req.body as { token: string }
    await authService.verifyEmail(token)
    return ok(res, { verified: true })
  },

  async resendVerification(req: Request, res: Response) {
    const { email } = req.body as { email: string }
    await authService.resendVerification(email)
    // Same answer for a verified, unverified or unknown address.
    return accepted(res, {
      message: 'If that address needs verification, a new email is on its way.',
    })
  },

  async forgotPassword(req: Request, res: Response) {
    const { email } = req.body as { email: string }
    await authService.requestPasswordReset(email, contextOf(req))
    return accepted(res, {
      message: 'If that address is registered, a password reset email is on its way.',
    })
  },

  async resetPassword(req: Request, res: Response) {
    const { token, password } = req.body as { token: string; password: string }
    await authService.resetPassword(token, password)
    // Every session was revoked, so any cookie this browser holds is now dead.
    clearRefreshCookie(res)
    return ok(res, { reset: true })
  },

  async acceptInvitation(req: Request, res: Response) {
    const { token, password } = req.body as { token: string; password: string }
    await invitationsService.accept(token, password)
    // No session is issued: the invitee signs in normally, so there is exactly
    // one login path to reason about.
    return ok(res, { accepted: true })
  },

  async changePassword(req: Request, res: Response) {
    const actor = requireActor(req)
    const { currentPassword, newPassword } = req.body as {
      currentPassword: string
      newPassword: string
    }

    await authService.changePassword({
      userId: actor.userId,
      currentPassword,
      newPassword,
      // The session making the change survives; every other one is revoked.
      keepSessionId: actor.sessionId,
    })

    return ok(res, { changed: true })
  },
}
