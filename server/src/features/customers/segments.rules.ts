/**
 * The customer field catalogue (§12).
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 *
 *   { match: 'all' | 'any', conditions: [{ field, operator, value }] }
 *
 * The same shape smart collections use, so one rule builder in the admin serves
 * both and one set of operators has to be understood once. The compiler, the
 * operator table and the coercion live in `shared/rules` — this file is only
 * the vocabulary: which fields a customer segment may be built from, and the
 * SQL each one stands for.
 *
 * ── Why this is safe ────────────────────────────────────────────────────────
 *
 * The table below is an allowlist. A field name arriving in a request is a *key
 * into it*, never a column name; the operator is matched against a fixed list;
 * every value is bound as a parameter. Together those mean a segment is data,
 * not code, however hostile the JSON.
 *
 * ── Why evaluation is live ──────────────────────────────────────────────────
 *
 * A materialised membership is correct until the next order and then it is a
 * list of customers who *used to* match. Compiling to a WHERE clause and
 * running it costs a query and cannot go stale.
 */
import { createRuleEngine, type RuleFieldMeta } from '../../shared/rules/index.js'

export type {
  CompiledRules,
  RuleCondition,
  RuleFieldMeta,
  RuleFieldType,
  RuleSet,
} from '../../shared/rules/index.js'
export {
  LIST_OPERATORS,
  OPERATORS_BY_TYPE,
  VALUELESS_OPERATORS,
  parseRules,
} from '../../shared/rules/index.js'

export const CUSTOMER_RULE_FIELDS: readonly RuleFieldMeta[] = [
  { key: 'email', label: 'Email', type: 'text', sql: 'u.email' },
  { key: 'firstName', label: 'First name', type: 'text', sql: "coalesce(u.first_name, '')" },
  { key: 'lastName', label: 'Last name', type: 'text', sql: "coalesce(u.last_name, '')" },
  { key: 'phone', label: 'Phone', type: 'text', sql: "coalesce(u.phone, '')" },
  { key: 'tags', label: 'Tags', type: 'array', sql: 'u.tags' },
  {
    key: 'totalSpent',
    label: 'Total spent',
    type: 'money',
    sql: 'u.total_spent_cents',
    hint: 'In minor units — 5000 is £50.',
  },
  { key: 'ordersCount', label: 'Number of orders', type: 'number', sql: 'u.orders_count' },
  {
    key: 'status',
    label: 'Account status',
    type: 'enum',
    sql: 'u.status',
    options: ['active', 'disabled', 'locked'],
  },
  {
    key: 'marketingEmail',
    label: 'Email marketing',
    type: 'enum',
    sql: 'u.marketing_email_state',
    options: ['not_subscribed', 'pending', 'subscribed', 'unsubscribed'],
  },
  { key: 'taxExempt', label: 'Tax exempt', type: 'boolean', sql: 'u.tax_exempt' },
  { key: 'emailVerified', label: 'Email verified', type: 'boolean', sql: '(u.email_verified_at IS NOT NULL)' },
  { key: 'createdAt', label: 'Account created', type: 'date', sql: 'u.created_at' },
  { key: 'firstOrderAt', label: 'First order', type: 'date', sql: 'u.first_order_at' },
  { key: 'lastOrderAt', label: 'Last order', type: 'date', sql: 'u.last_order_at' },
  {
    key: 'daysSinceLastOrder',
    label: 'Days since last order',
    type: 'number',
    // Derived, because "quiet for 90 days" is the question people ask, and a
    // stored answer is wrong by tomorrow morning.
    sql: "extract(day from (now() - u.last_order_at))",
    hint: 'Only matches customers who have ordered at least once.',
  },
] as const

/**
 * Customers compile against `users u`.
 *
 * The engine is shared; only the vocabulary above and the word for "no
 * conditions" are ours.
 */
const engine = createRuleEngine(CUSTOMER_RULE_FIELDS, { everything: 'Everyone' })

export const compileRules = engine.compileRules
export const describeRules = engine.describeRules

/** The metadata the admin's rule builder is generated from. */
export const ruleFieldCatalogue = engine.catalogue
