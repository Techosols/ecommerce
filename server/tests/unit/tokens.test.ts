import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { verifyAccessToken } from '../../src/shared/auth/tokens.js'
import { AuthenticationError, ERROR_CODES } from '../../src/shared/errors/index.js'
import { env } from '../../src/config/index.js'

function sign(payload: object, options: jwt.SignOptions = {}, secret = env.JWT_ACCESS_SECRET) {
  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    issuer: env.JWT_ISSUER,
    expiresIn: '15m',
    ...options,
  })
}

describe('access token verification', () => {
  it('accepts a well-formed token', () => {
    const token = sign({ sub: 'user-1', sid: 'session-1', roles: ['customer'], typ: 'access' })
    expect(verifyAccessToken(token)).toEqual({
      sub: 'user-1',
      sid: 'session-1',
      roles: ['customer'],
      typ: 'access',
    })
  })

  it('rejects a token signed with a different secret', () => {
    const token = sign(
      { sub: 'u', sid: 's', typ: 'access' },
      {},
      'a-completely-different-secret-value-here',
    )
    expect(() => verifyAccessToken(token)).toThrow(AuthenticationError)
  })

  it('rejects the alg:none attack', () => {
    const forged = jwt.sign({ sub: 'u', sid: 's', typ: 'access' }, '', {
      algorithm: 'none',
      issuer: env.JWT_ISSUER,
    })
    expect(() => verifyAccessToken(forged)).toThrow(AuthenticationError)
  })

  it('rejects a refresh token presented as an access token', () => {
    const token = sign({ sub: 'u', sid: 's', typ: 'refresh' })
    expect(() => verifyAccessToken(token)).toThrow(/not an access token/)
  })

  it('rejects a token from another issuer', () => {
    const token = sign({ sub: 'u', sid: 's', typ: 'access' }, { issuer: 'someone-else' })
    expect(() => verifyAccessToken(token)).toThrow(AuthenticationError)
  })

  it('reports expiry with its own code so the client knows to refresh', () => {
    const token = sign({ sub: 'u', sid: 's', typ: 'access' }, { expiresIn: '-1s' })
    try {
      verifyAccessToken(token)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AuthenticationError).code).toBe(ERROR_CODES.TOKEN_EXPIRED)
    }
  })

  it('rejects a token missing required claims', () => {
    const token = sign({ sub: 'u', typ: 'access' })
    expect(() => verifyAccessToken(token)).toThrow(/missing required claims/)
  })
})
