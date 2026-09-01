/**
 * Public surface of the `auth` feature (§2.2).
 *
 * Routes are mounted by `router.ts` directly, not re-exported here — see the
 * note in `features/users/index.ts` for why.
 */
export { authService } from './auth.service.js'
export type {
  IssuedTokens,
  SessionRecord,
  SessionRevokeReason,
  AuthTokenPurpose,
} from './auth.types.js'
