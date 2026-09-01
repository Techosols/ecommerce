/**
 * The rule engine (§12, §4.3).
 *
 * A rule set is `{ match: 'all' | 'any', conditions: [{ field, operator, value }] }`
 * and this turns one into a parameterised SQL fragment. It is written once and
 * given a *field catalogue* per domain: customer segments compile against
 * `users u`, smart collections against `products p`, and both get the same
 * operators, the same coercion, the same error messages and the same English
 * summary. Two compilers would be two chances to disagree about what
 * `not_equals` means, and the admin's one rule builder would then be right for
 * only one of them.
 *
 * ## The security property
 *
 * Nothing from a rule reaches the query as text. The field name is looked up in
 * the catalogue — an allowlist mapping public keys to SQL expressions written
 * here — the operator is matched against a fixed list, and every value is bound
 * as a parameter. Rules are admin-submitted data arriving over HTTP with a
 * builder on top; treating any part of one as SQL would be an injection hole
 * with a UI attached.
 */
import { ValidationError } from '../errors/index.js'
import { formatMoney } from '../format/money.js'

export type RuleFieldType = 'text' | 'number' | 'money' | 'boolean' | 'date' | 'enum' | 'array'

export interface RuleFieldMeta {
  /** The key a client sends, and the key the admin's builder renders. */
  key: string
  label: string
  type: RuleFieldType
  /** The SQL expression it stands for. Written here, never received. */
  sql: string
  /** For `enum`, the values the builder offers and the compiler accepts. */
  options?: readonly string[]
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

export interface CompiledRules {
  /** A SQL fragment using `$n` placeholders, or `null` when nothing narrows. */
  where: string | null
  params: unknown[]
}

/** Operators that take no value at all. */
export const VALUELESS_OPERATORS = ['is_set', 'is_not_set'] as const
/** Operators whose value is a list. */
export const LIST_OPERATORS = ['in', 'not_in'] as const

export const OPERATORS_BY_TYPE: Record<RuleFieldType, readonly string[]> = {
  text: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'is_set', 'is_not_set'],
  number: ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'is_set', 'is_not_set'],
  money: ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte'],
  boolean: ['equals'],
  date: ['before', 'after', 'is_set', 'is_not_set'],
  enum: ['equals', 'not_equals', 'in', 'not_in'],
  array: ['contains', 'not_contains', 'is_set', 'is_not_set'],
}

/** Parses whatever is in a `rules` column into a rule set, or throws. */
export function parseRules(raw: unknown): RuleSet {
  if (raw === null || typeof raw !== 'object') {
    throw new ValidationError('Rules must be an object')
  }
  const value = raw as { match?: unknown; conditions?: unknown }
  const match = value.match === 'any' ? 'any' : 'all'
  const conditions = Array.isArray(value.conditions) ? value.conditions : []

  return {
    match,
    conditions: conditions.map((entry, index) => {
      if (entry === null || typeof entry !== 'object') {
        throw new ValidationError(`Condition ${index + 1} is not an object`)
      }
      const condition = entry as RuleCondition
      if (typeof condition.field !== 'string' || typeof condition.operator !== 'string') {
        throw new ValidationError(`Condition ${index + 1} needs a field and an operator`)
      }
      return condition
    }),
  }
}

function coerce(field: RuleFieldMeta, value: unknown, position: number): unknown {
  switch (field.type) {
    case 'number':
    case 'money': {
      const number = typeof value === 'string' ? Number(value) : value
      if (typeof number !== 'number' || !Number.isFinite(number)) {
        throw new ValidationError(`Condition ${position} on ${field.label} needs a number`)
      }
      return number
    }
    case 'boolean':
      if (typeof value === 'boolean') return value
      if (value === 'true') return true
      if (value === 'false') return false
      throw new ValidationError(`Condition ${position} on ${field.label} needs true or false`)
    case 'date': {
      const date = typeof value === 'string' || value instanceof Date ? new Date(value) : null
      if (!date || Number.isNaN(date.getTime())) {
        throw new ValidationError(`Condition ${position} on ${field.label} needs a date`)
      }
      return date.toISOString()
    }
    case 'enum': {
      if (typeof value !== 'string' || !(field.options ?? []).includes(value)) {
        throw new ValidationError(
          `Condition ${position} on ${field.label} must be one of ${(field.options ?? []).join(', ')}`,
        )
      }
      return value
    }
    default:
      if (typeof value !== 'string') {
        throw new ValidationError(`Condition ${position} on ${field.label} needs text`)
      }
      return value
  }
}

/**
 * Turns one condition into a SQL fragment plus bound parameters.
 *
 * The `push` closure owns the placeholder numbering, so a fragment can never
 * disagree with the params array it was built alongside.
 */
function compileCondition(
  fieldsByKey: Map<string, RuleFieldMeta>,
  condition: RuleCondition,
  position: number,
  push: (value: unknown) => string,
): string {
  const field = fieldsByKey.get(condition.field)
  if (!field) {
    // A field the catalogue does not know is refused outright. This is the line
    // that stops a caller naming a column.
    throw new ValidationError(`Unknown field "${condition.field}"`)
  }

  const allowed = OPERATORS_BY_TYPE[field.type]
  if (!allowed.includes(condition.operator)) {
    throw new ValidationError(
      `"${condition.operator}" cannot be used on ${field.label}; try ${allowed.join(', ')}`,
    )
  }

  const sql = field.sql

  // Valueless first: these are the only operators that read nothing from the
  // request beyond the field itself.
  if (condition.operator === 'is_set') {
    return field.type === 'array' ? `array_length(${sql}, 1) > 0` : `${sql} IS NOT NULL`
  }
  if (condition.operator === 'is_not_set') {
    return field.type === 'array'
      ? `coalesce(array_length(${sql}, 1), 0) = 0`
      : `${sql} IS NULL`
  }

  if ((LIST_OPERATORS as readonly string[]).includes(condition.operator)) {
    const list = Array.isArray(condition.value) ? condition.value : [condition.value]
    if (list.length === 0) throw new ValidationError(`Condition ${position} needs at least one value`)
    const values = list.map((entry) => coerce(field, entry, position))
    const placeholder = push(values)
    return condition.operator === 'in'
      ? `${sql} = ANY(${placeholder})`
      : `NOT (${sql} = ANY(${placeholder}))`
  }

  // Arrays compare by membership rather than equality.
  if (field.type === 'array') {
    const placeholder = push([coerce(field, condition.value, position)])
    return condition.operator === 'contains'
      ? `${sql} && ${placeholder}`
      : `NOT (${sql} && ${placeholder})`
  }

  const value = coerce(field, condition.value, position)

  switch (condition.operator) {
    case 'equals':
      return `${sql} = ${push(value)}`
    case 'not_equals':
      // `IS DISTINCT FROM` rather than `<>`: a NULL column is not equal to
      // anything, so `<>` would silently exclude every row with no value at
      // all — which is not what "is not X" means to a person.
      return `${sql} IS DISTINCT FROM ${push(value)}`
    case 'contains':
      return `${sql} ILIKE ${push(`%${String(value)}%`)}`
    case 'not_contains':
      return `${sql} NOT ILIKE ${push(`%${String(value)}%`)}`
    case 'starts_with':
      return `${sql} ILIKE ${push(`${String(value)}%`)}`
    case 'gt':
      return `${sql} > ${push(value)}`
    case 'gte':
      return `${sql} >= ${push(value)}`
    case 'lt':
      return `${sql} < ${push(value)}`
    case 'lte':
      return `${sql} <= ${push(value)}`
    case 'before':
      return `${sql} < ${push(value)}`
    case 'after':
      return `${sql} > ${push(value)}`
    default:
      throw new ValidationError(`Unsupported operator "${condition.operator}"`)
  }
}

function phraseFor(
  field: RuleFieldMeta | undefined,
  condition: RuleCondition,
  currency: string | undefined,
): string {
  const label = field?.label ?? condition.field

  // Money is stored and compared in minor units, and a summary that says
  // "less than 5000" for a £50 rule is a sentence nobody can check. Rendered
  // as money when the caller knows the currency, and left as the raw number
  // when it does not, which is at least unambiguous.
  const render = (entry: unknown): string =>
    field?.type === 'money' && currency && typeof entry === 'number'
      ? formatMoney(entry, currency)
      : String(entry ?? '')

  const value = Array.isArray(condition.value)
    ? condition.value.map(render).join(', ')
    : render(condition.value)

  switch (condition.operator) {
    case 'is_set':
      return `${label} is set`
    case 'is_not_set':
      return `${label} is not set`
    case 'equals':
      return `${label} is ${value}`
    case 'not_equals':
      return `${label} is not ${value}`
    case 'contains':
      return `${label} contains ${value}`
    case 'not_contains':
      return `${label} does not contain ${value}`
    case 'starts_with':
      return `${label} starts with ${value}`
    case 'gt':
      return `${label} is more than ${value}`
    case 'gte':
      return `${label} is at least ${value}`
    case 'lt':
      return `${label} is less than ${value}`
    case 'lte':
      return `${label} is at most ${value}`
    case 'before':
      return `${label} is before ${value}`
    case 'after':
      return `${label} is after ${value}`
    case 'in':
      return `${label} is any of ${value}`
    case 'not_in':
      return `${label} is none of ${value}`
    default:
      return `${label} ${condition.operator} ${value}`
  }
}

export interface RuleEngine {
  fields: readonly RuleFieldMeta[]
  parseRules: (raw: unknown) => RuleSet
  /**
   * Compiles a rule set into a WHERE fragment and its parameters. `startAt` is
   * the number of parameters the caller has already bound, so the fragment can
   * be spliced into a larger query without renumbering.
   */
  compileRules: (rules: RuleSet, startAt?: number) => CompiledRules
  /**
   * The rule set in English, for a card that must say what it means.
   *
   * `currency` is passed rather than looked up so the engine stays free of the
   * settings service — the same reason the mappers take it.
   */
  describeRules: (rules: RuleSet, options?: { currency?: string }) => string
  /** The metadata the admin's rule builder is generated from. */
  catalogue: () => Array<{
    key: string
    label: string
    type: RuleFieldType
    operators: readonly string[]
    options?: readonly string[]
    hint?: string
  }>
}

/**
 * Binds the engine to one domain's field catalogue.
 *
 * `everything` is what the summary says when there are no conditions at all —
 * "Everyone" for customers, "Every product" for a collection — which is the
 * only sentence the two domains do not share.
 */
export function createRuleEngine(
  fields: readonly RuleFieldMeta[],
  options: { everything: string },
): RuleEngine {
  const fieldsByKey = new Map(fields.map((field) => [field.key, field]))

  return {
    fields,
    parseRules,

    compileRules(rules, startAt = 0) {
      if (rules.conditions.length === 0) return { where: null, params: [] }

      const params: unknown[] = []
      const push = (value: unknown): string => {
        params.push(value)
        return `$${startAt + params.length}`
      }

      const fragments = rules.conditions.map((condition, index) =>
        compileCondition(fieldsByKey, condition, index + 1, push),
      )

      const joiner = rules.match === 'any' ? ' OR ' : ' AND '
      return { where: `(${fragments.join(joiner)})`, params }
    },

    describeRules(rules, describeOptions) {
      if (rules.conditions.length === 0) return options.everything
      // Built from the same table the compiler uses, so the sentence and the
      // query cannot describe different things.
      const phrases = rules.conditions.map((condition) =>
        phraseFor(fieldsByKey.get(condition.field), condition, describeOptions?.currency),
      )
      return phrases.join(rules.match === 'any' ? ' or ' : ' and ')
    },

    catalogue() {
      return fields.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        operators: OPERATORS_BY_TYPE[field.type],
        ...(field.options ? { options: field.options } : {}),
        ...(field.hint ? { hint: field.hint } : {}),
      }))
    },
  }
}
