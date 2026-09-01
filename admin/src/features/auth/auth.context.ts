import { createContext } from 'react'
import type { CurrentUser, LoginInput, Permission } from './auth.types'

export type AuthStatus = 'restoring' | 'authenticated' | 'anonymous'

export interface AuthContextValue {
  status: AuthStatus
  user: CurrentUser | null
  /** Why the last session ended, so the login page can say so. */
  endedReason: 'expired' | 'signed-out' | 'not-staff' | null
  login: (input: LoginInput) => Promise<CurrentUser>
  logout: () => Promise<void>
  /** Re-reads `/auth/me`; call after anything that can change a role. */
  refreshUser: () => Promise<void>
  can: (permission: Permission | Permission[]) => boolean
  canAny: (permissions: Permission[]) => boolean
  hasRole: (role: string) => boolean
}

export const AuthContext = createContext<AuthContextValue | null>(null)
