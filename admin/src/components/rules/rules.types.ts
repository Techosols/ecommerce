/**
 * The rule vocabulary, mirrored from `server/src/features/customers/segments.rules.ts`.
 *
 * Nothing here decides what a field means or which operators it has: the
 * catalogue is fetched from the server, because the compiler that turns a rule
 * into SQL is the only thing that knows, and a second copy of that table in the
 * browser would be free to disagree with it — offering an operator the server
 * refuses, or hiding one it accepts.
 *
 * Kept in `components/` rather than in the customers feature because smart
 * collections use the same shape against a different catalogue.
 */

export type RuleFieldType = 'text' | 'number' | 'money' | 'boolean' | 'date' | 'enum' | 'array'

export interface RuleField {
  key: string
  label: string
  type: RuleFieldType
  /** Every operator the server will accept for this field, in its own order. */
  operators: string[]
  /** For `enum`, the only values the server accepts. */
  options?: string[]
  hint?: string
}

export interface RuleCondition {
  field: string
  operator: string
  value?: unknown
}

export interface RuleSet {
  match: 'all' | 'any'
  conditions: RuleCondition[]
}

export const EMPTY_RULES: RuleSet = { match: 'all', conditions: [] }

/** Operators that take no value at all — the row hides its input. */
export const VALUELESS_OPERATORS = new Set(['is_set', 'is_not_set'])

/** Operators whose value is a list, typed as comma-separated text. */
export const LIST_OPERATORS = new Set(['in', 'not_in'])

export const OPERATOR_LABELS: Record<string, string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  before: 'is before',
  after: 'is after',
  in: 'is one of',
  not_in: 'is none of',
  is_set: 'has a value',
  is_not_set: 'has no value',
}

export function operatorLabel(operator: string): string {
  return OPERATOR_LABELS[operator] ?? operator.replace(/_/g, ' ')
}

/**
 * A rule value as text for an input.
 *
 * `value` is `unknown` on purpose — what it may be depends on the field, and
 * only the server's compiler knows — so anything that is not already a
 * primitive becomes an empty field rather than "[object Object]".
 */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(valueText).join(', ')
  return ''
}

/**
 * Whether a condition is complete enough to send.
 *
 * An incomplete row is not an error to shout about — it is a row somebody is
 * still typing — so it is dropped on the way out rather than blocking the save.
 */
export function isComplete(condition: RuleCondition): boolean {
  if (!condition.field || !condition.operator) return false
  if (VALUELESS_OPERATORS.has(condition.operator)) return true
  return condition.value !== undefined && condition.value !== null && condition.value !== ''
}

export function completeRules(rules: RuleSet): RuleSet {
  return { match: rules.match, conditions: rules.conditions.filter(isComplete) }
}
