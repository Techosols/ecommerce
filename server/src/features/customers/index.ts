/**
 * Public surface of the `customers` feature (§2.2).
 *
 * A customer is a `users` row; this feature owns their commercial identity —
 * address book, marketing consent, lifetime figures — while `users` owns the
 * account itself and `auth` owns the credentials.
 *
 * Routes are mounted by `router.ts` directly, not re-exported here.
 */
export { customersService } from './customers.service.js'
export { segmentsService } from './segments.service.js'
export type { CustomerSegment } from './segments.service.js'
export { CUSTOMER_RULE_FIELDS, describeRules, ruleFieldCatalogue } from './segments.rules.js'
export type { RuleSet, RuleCondition } from './segments.rules.js'
export type {
  Address,
  AddressInput,
  AddressSnapshot,
  CustomerEvent,
  CustomerListFilter,
  CustomerSummary,
  MarketingState,
  OptInLevel,
} from './customers.types.js'
