import { use } from 'react'
import { AuthContext } from './auth.context'

/** Who is signed in, and the three things a screen can do about it. */
export function useAuth() {
  const value = use(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}

