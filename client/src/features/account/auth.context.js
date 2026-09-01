import { createContext } from 'react'

/**
 * Who is signed in, if anyone.
 *
 * In its own module because a context is not a component, and exporting one
 * beside a provider is what breaks fast refresh in development.
 */
export const AuthContext = createContext(null)
