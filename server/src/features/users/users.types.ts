import type { UserStatus } from '../../shared/auth/actor.js'

export type { UserStatus }

/** The identity row as the rest of the server sees it. Never carries the hash. */
export interface User {
  id: string
  email: string
  status: UserStatus
  emailVerified: boolean
  firstName: string | null
  lastName: string | null
  phone: string | null
  lastLoginAt: Date | null
  createdAt: Date
  roles: string[]
}

/** Only `auth` ever asks for this, and only inside a login or password flow. */
export interface UserCredentials {
  id: string
  email: string
  status: UserStatus
  passwordHash: string | null
  emailVerified: boolean
}

export interface UserAccess {
  userId: string
  email: string
  status: UserStatus
  emailVerified: boolean
  roles: string[]
}

export interface Role {
  key: string
  name: string
  description: string
  permissions: string[]
}

export interface CreateUserInput {
  email: string
  passwordHash?: string | null
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
  roles: string[]
}
