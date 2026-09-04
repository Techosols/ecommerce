/**
 * Checking a value against the definition that governs it.
 *
 * ── Why this is not a Zod schema per definition ──────────────────────────────
 *
 * Because the definitions are rows, not code. A schema would have to be built
 * at runtime from a database row on every write, cached, and invalidated when
 * an operator edits a definition — machinery whose only job would be to
 * reproduce the twenty lines below.
 *
 * ── What "valid" means here ──────────────────────────────────────────────────
 *
 * The value is coerced to the definition's type and then bounded. Coercion is
 * deliberately narrow: `"12"` becomes `12` for an integer field because a form
 * posts strings and refusing that would be pedantry, but `"twelve"` is a
 * refusal, and `12.5` is a refusal for an *integer* rather than a silent
 * truncation. Rounding somebody's data because it did not fit is the kind of
 * helpfulness that loses a decimal place in a shelf-life field.
 */
import { ValidationError } from '../../shared/errors/index.js'
import type { MetafieldDefinition, MetafieldType, MetafieldValidations } from './metafields.types.js'

/** Serialised JSON longer than this is a document, not a field. */
const MAX_JSON_BYTES = 64 * 1024
const MAX_TEXT_LENGTH = 65_536
const MAX_URL_LENGTH = 2048

/**
 * The value as it will be stored, or an explanation of why it will not be.
 *
 * `null` is the caller saying "clear this field", and is refused only when the
 * definition says the field is required.
 */
export function coerceValue(definition: MetafieldDefinition, raw: unknown): unknown {
  const label = definition.name

  if (raw === null || raw === undefined || raw === '') {
    if (definition.required) {
      throw new ValidationError(`${label} is required`)
    }
    return null
  }

  const value = coerceByType(definition.type, raw, label)
  applyBounds(definition.type, value, definition.validations, label)
  return value
}

function coerceByType(type: MetafieldType, raw: unknown, label: string): unknown {
  switch (type) {
    case 'single_line_text':
    case 'multi_line_text': {
      if (typeof raw !== 'string') throw new ValidationError(`${label} must be text`)
      // A single-line field that accepted a newline would render as one line
      // in the admin and two everywhere else.
      const value = type === 'single_line_text' ? raw.replace(/[\r\n]+/g, ' ').trim() : raw
      if (value.length > MAX_TEXT_LENGTH) {
        throw new ValidationError(`${label} is longer than this field can hold`)
      }
      return value
    }

    case 'integer': {
      const value = toNumber(raw, label)
      if (!Number.isInteger(value)) {
        throw new ValidationError(`${label} must be a whole number`)
      }
      if (!Number.isSafeInteger(value)) {
        throw new ValidationError(`${label} is too large to store exactly`)
      }
      return value
    }

    case 'decimal':
      return toNumber(raw, label)

    case 'boolean': {
      if (typeof raw === 'boolean') return raw
      // A checkbox posted as a string is the common case and unambiguous.
      if (raw === 'true') return true
      if (raw === 'false') return false
      throw new ValidationError(`${label} must be true or false`)
    }

    case 'date': {
      if (typeof raw !== 'string') throw new ValidationError(`${label} must be a date`)
      // Calendar date, not an instant: a shelf life or a launch day has no
      // timezone, and storing one would move the date for half the world.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        throw new ValidationError(`${label} must be a date in the form YYYY-MM-DD`)
      }
      const parsed = new Date(`${raw}T00:00:00Z`)
      if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(raw)) {
        throw new ValidationError(`${label} is not a real date`)
      }
      return raw
    }

    case 'url':
      return coerceUrl(raw, label)

    case 'json': {
      // Accepts either a parsed object or the text of one, because the admin
      // sends what an operator typed into a textarea.
      const value = typeof raw === 'string' ? parseJson(raw, label) : raw
      const serialised = JSON.stringify(value) ?? ''
      if (Buffer.byteLength(serialised, 'utf8') > MAX_JSON_BYTES) {
        throw new ValidationError(`${label} is larger than 64KB`)
      }
      return value
    }

    default: {
      // The CHECK constraint and the enum agree on the list, so reaching here
      // means a type was added in one place and not the other.
      const exhaustive: never = type
      throw new ValidationError(`Unsupported field type ${String(exhaustive)}`)
    }
  }
}

function toNumber(raw: unknown, label: string): number {
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${label} must be a number`)
  }
  return value
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new ValidationError(`${label} is not valid JSON`)
  }
}

/**
 * A URL that is safe to put in an `href`.
 *
 * Only http and https. A metafield marked storefront-visible is rendered as a
 * link on a public page, and `javascript:alert(1)` in a merchant-editable field
 * is stored cross-site scripting — refused here, at the one place every value
 * passes through, rather than trusted to whichever component renders it.
 */
function coerceUrl(raw: unknown, label: string): string {
  if (typeof raw !== 'string') throw new ValidationError(`${label} must be a link`)
  const trimmed = raw.trim()
  if (trimmed.length > MAX_URL_LENGTH) throw new ValidationError(`${label} is too long for a link`)

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new ValidationError(`${label} must be a full link, including https://`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${label} must be an http or https link`)
  }
  return parsed.toString()
}

/**
 * The definition's own bounds.
 *
 * Only the ones that mean something for the type are consulted, so a `min` left
 * over on a field somebody switched from a number to text is ignored rather
 * than enforced against a string's length by accident.
 */
function applyBounds(
  type: MetafieldType,
  value: unknown,
  validations: MetafieldValidations,
  label: string,
): void {
  if (typeof value === 'string' && (type === 'single_line_text' || type === 'multi_line_text')) {
    if (validations.minLength !== undefined && value.length < validations.minLength) {
      throw new ValidationError(`${label} must be at least ${validations.minLength} characters`)
    }
    if (validations.maxLength !== undefined && value.length > validations.maxLength) {
      throw new ValidationError(`${label} must be ${validations.maxLength} characters or fewer`)
    }
    if (validations.choices?.length && !validations.choices.includes(value)) {
      throw new ValidationError(`${label} must be one of: ${validations.choices.join(', ')}`)
    }
  }

  if (typeof value === 'number') {
    if (validations.min !== undefined && value < validations.min) {
      throw new ValidationError(`${label} must be ${validations.min} or more`)
    }
    if (validations.max !== undefined && value > validations.max) {
      throw new ValidationError(`${label} must be ${validations.max} or less`)
    }
  }
}

/**
 * Refuses a definition whose own bounds contradict each other.
 *
 * Caught when the definition is saved rather than when the first value fails
 * against it, because a field nobody can fill in is a puzzle for whoever tries,
 * and the person who made the mistake is right here.
 */
export function assertValidationsCoherent(
  type: MetafieldType,
  validations: MetafieldValidations,
): void {
  const { minLength, maxLength, min, max, choices } = validations

  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw new ValidationError('The minimum length cannot be greater than the maximum')
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new ValidationError('The minimum cannot be greater than the maximum')
  }
  if (choices?.length) {
    if (type !== 'single_line_text') {
      throw new ValidationError('A list of choices only applies to a single-line text field')
    }
    if (new Set(choices).size !== choices.length) {
      throw new ValidationError('That list of choices repeats a value')
    }
  }
}
