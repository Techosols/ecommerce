/**
 * Public surface of the `users` feature (§2.2).
 *
 * Other features import from here and nowhere else — an ESLint rule turns a
 * deep import into a build failure.
 *
 * Routes are deliberately NOT exported here. `router.ts` is the composition
 * root and mounts route files directly; aggregating them into this file would
 * create a cycle, because the route file imports the very middleware that
 * imports this service.
 */
export { usersService } from './users.service.js'
export type {
  User,
  UserAccess,
  UserCredentials,
  UserStatus,
  Role,
  CreateUserInput,
} from './users.types.js'
