/**
 * Public surface of the `audit` feature (§2.2).
 *
 * Routes are mounted by `router.ts` directly, not re-exported here.
 */
export { auditService, diffChanged } from './audit.service.js'
export type { AuditEntry, AuditRecord, AuditFilter } from './audit.types.js'
