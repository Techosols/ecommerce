import { describe, expect, it } from 'vitest'
import { ROOMS, autoJoinRooms, isStaff } from '../../src/infrastructure/realtime/rooms.js'

describe('room naming', () => {
  it('scopes rooms by identity', () => {
    expect(ROOMS.user('u1')).toBe('user:u1')
    expect(ROOMS.order('o1')).toBe('order:o1')
    expect(ROOMS.adminOrders()).toBe('admin:orders')
  })
})

describe('automatic room membership', () => {
  it('is derived from verified claims, never from anything the client sends', () => {
    const rooms = autoJoinRooms('storefront', { sub: 'u1', roles: ['customer'] })
    expect(rooms).toEqual(['user:u1'])
  })

  it('gives a customer no admin room, even on the admin namespace', () => {
    expect(autoJoinRooms('admin', { sub: 'u1', roles: ['customer'] })).toEqual([])
  })

  it('puts staff in the admin channels', () => {
    const rooms = autoJoinRooms('admin', { sub: 'staff-1', roles: ['staff'] })
    expect(rooms).toContain('admin')
    expect(rooms).toContain('admin:orders')
    expect(rooms).toContain('user:staff-1')
  })

  it('never puts a customer in another customer room', () => {
    const rooms = autoJoinRooms('storefront', { sub: 'u1', roles: ['customer'] })
    expect(rooms.some((room) => room.startsWith('user:') && room !== 'user:u1')).toBe(false)
  })

  it('recognises the staff roles only', () => {
    expect(isStaff(['staff'])).toBe(true)
    expect(isStaff(['admin'])).toBe(true)
    expect(isStaff(['owner'])).toBe(true)
    expect(isStaff(['customer'])).toBe(false)
    expect(isStaff([])).toBe(false)
  })
})
