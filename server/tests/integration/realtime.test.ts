/**
 * Socket.IO handshake authorisation (§11.2).
 *
 * The rule under test: the client never says who it is. Identity comes from a
 * verified token, and rooms are derived server-side from its claims.
 */
import { createServer, type Server as HttpServer } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { io as createClient, type Socket } from 'socket.io-client'
import { closeRealtime, initRealtime } from '../../src/infrastructure/realtime/index.js'
import { REALTIME_EVENTS } from '../../src/infrastructure/realtime/events.js'
import { env } from '../../src/config/index.js'

function sign(claims: object, options: jwt.SignOptions = {}, secret = env.JWT_ACCESS_SECRET) {
  return jwt.sign(claims, secret, {
    algorithm: 'HS256',
    issuer: env.JWT_ISSUER,
    expiresIn: '5m',
    ...options,
  })
}

let httpServer: HttpServer
let url: string
const clients: Socket[] = []

interface Ready {
  userId: string
  rooms: string[]
  serverTime: string
}

/**
 * Connects and resolves once the server's `connection.ready` arrives. The
 * listener is attached before the connection completes — the server emits
 * immediately on connect, so attaching afterwards races the event.
 */
function connect(
  namespace: string,
  auth: Record<string, unknown>,
): Promise<{ socket: Socket; ready: Ready }> {
  return new Promise((resolve, reject) => {
    const socket = createClient(`${url}${namespace}`, {
      auth,
      transports: ['websocket'],
      reconnection: false,
      timeout: 4000,
    })
    clients.push(socket)
    socket.on(REALTIME_EVENTS.CONNECTED, (ready: Ready) => resolve({ socket, ready }))
    socket.on('connect_error', (error) => reject(error))
  })
}

describe('socket handshake', () => {
  beforeAll(async () => {
    httpServer = createServer()
    initRealtime(httpServer)
    await new Promise<void>((resolve) => httpServer.listen(0, resolve))
    const address = httpServer.address()
    const port = typeof address === 'object' && address ? address.port : 0
    url = `http://127.0.0.1:${port}`
  })

  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect()
  })

  afterAll(async () => {
    await closeRealtime()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  })

  it('refuses a connection with no token', async () => {
    await expect(connect('/storefront', {})).rejects.toThrow('UNAUTHORIZED')
  })

  it('refuses a token signed with the wrong secret', async () => {
    const token = sign(
      { sub: 'u1', sid: 's1', roles: ['customer'], typ: 'access' },
      {},
      'a-different-secret-that-is-long-enough',
    )
    await expect(connect('/storefront', { token })).rejects.toThrow('UNAUTHORIZED')
  })

  it('refuses an expired token', async () => {
    const token = sign(
      { sub: 'u1', sid: 's1', roles: ['customer'], typ: 'access' },
      { expiresIn: '-10s' },
    )
    await expect(connect('/storefront', { token })).rejects.toThrow('UNAUTHORIZED')
  })

  it('refuses a refresh token presented on the socket', async () => {
    const token = sign({ sub: 'u1', sid: 's1', roles: ['customer'], typ: 'refresh' })
    await expect(connect('/storefront', { token })).rejects.toThrow('UNAUTHORIZED')
  })

  it('accepts a valid customer and puts them only in their own room', async () => {
    const token = sign({ sub: 'user-42', sid: 's1', roles: ['customer'], typ: 'access' })
    const { ready } = await connect('/storefront', { token })

    expect(ready.userId).toBe('user-42')
    expect(ready.rooms).toEqual(['user:user-42'])
  })

  it('refuses a customer on the admin namespace, however valid their token', async () => {
    const token = sign({ sub: 'user-42', sid: 's1', roles: ['customer'], typ: 'access' })
    await expect(connect('/admin', { token })).rejects.toThrow('FORBIDDEN')
  })

  it('puts staff into the admin channels', async () => {
    const token = sign({ sub: 'staff-7', sid: 's2', roles: ['staff'], typ: 'access' })
    const { ready } = await connect('/admin', { token })

    expect(ready.rooms).toContain('admin')
    expect(ready.rooms).toContain('admin:orders')
    expect(ready.rooms).toContain('user:staff-7')
  })

  it('ignores a client-supplied identity — rooms come from the token alone', async () => {
    const token = sign({ sub: 'user-42', sid: 's1', roles: ['customer'], typ: 'access' })
    const { ready } = await connect('/storefront', { token, userId: 'user-99', roles: ['owner'] })

    expect(ready.userId).toBe('user-42')
    expect(ready.rooms).toEqual(['user:user-42'])
  })

  it('caps connections per user', async () => {
    const token = sign({ sub: 'chatty', sid: 's3', roles: ['customer'], typ: 'access' })

    for (let i = 0; i < env.SOCKET_MAX_CONNECTIONS_PER_USER; i++) {
      await connect('/storefront', { token })
    }
    await expect(connect('/storefront', { token })).rejects.toThrow('TOO_MANY_CONNECTIONS')
  })
})
