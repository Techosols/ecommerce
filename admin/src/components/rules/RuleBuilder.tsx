import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Select } from '@/components/ui/Select'
import {
  LIST_OPERATORS,
  VALUELESS_OPERATORS,
  operatorLabel,
  valueText,
  type RuleCondition,
  type RuleField,
  type RuleSet,
} from './rules.types'

export interface RuleBuilderProps {
  value: RuleSet
  onChange: (rules: RuleSet) => void
  /** The server's own field table, fetched — never a copy written here. */
  fields: RuleField[]
  currency?: string
  disabled?: boolean
  /**
   * What the rules select. The builder is shared, so it cannot assume: a
   * customer segment matches "Customers", a smart collection matches
   * "Products", and a sentence that says the wrong one is worse than no
   * sentence at all.
   */
  subject?: string
}

/**
 * Builds a rule set out of the server's field catalogue.
 *
 * Two rules keep this honest. Every field, operator and enum value offered
 * comes from `fields`, which the server publishes — so the builder can never
 * compose a rule the compiler will refuse. And the value control is chosen by
 * the field's *type*, so money is typed in pounds and stored in pence, a date
 * gets a date picker, and a boolean gets yes/no rather than a text box somebody
 * can put "yes please" into.
 *
 * Shared rather than owned by customers: smart collections use the same shape
 * against the product catalogue, and a second builder would drift from this one
 * the first time an operator was added.
 */
export function RuleBuilder({
  value,
  onChange,
  fields,
  currency = 'GBP',
  disabled = false,
  subject = 'Records',
}: RuleBuilderProps) {
  const fieldsByKey = new Map(fields.map((field) => [field.key, field]))

  function update(index: number, patch: Partial<RuleCondition>) {
    onChange({
      ...value,
      conditions: value.conditions.map((condition, position) =>
        position === index ? { ...condition, ...patch } : condition,
      ),
    })
  }

  /**
   * Changing the field resets the operator and the value.
   *
   * Keeping them would leave "Total spent contains vip" on screen — a row that
   * looks like a rule and is refused on save.
   */
  function changeField(index: number, key: string) {
    const field = fieldsByKey.get(key)
    onChange({
      ...value,
      conditions: value.conditions.map((condition, position) =>
        position === index
          ? { field: key, operator: field?.operators[0] ?? 'equals', value: '' }
          : condition,
      ),
    })
  }

  function addCondition() {
    const first = fields[0]
    if (!first) return
    onChange({
      ...value,
      conditions: [
        ...value.conditions,
        { field: first.key, operator: first.operators[0] ?? 'equals', value: '' },
      ],
    })
  }

  function removeCondition(index: number) {
    onChange({
      ...value,
      conditions: value.conditions.filter((_, position) => position !== index),
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">{subject} matching</span>
        <Select
          size="sm"
          aria-label="How the conditions combine"
          value={value.match}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, match: event.target.value === 'any' ? 'any' : 'all' })
          }
          options={[
            { value: 'all', label: 'all conditions' },
            { value: 'any', label: 'any condition' },
          ]}
        />
      </div>

      {value.conditions.length === 0 ? (
        <p className="text-faint border-line rounded-md border border-dashed px-3 py-4 text-sm">
          No conditions yet — everything matches.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {value.conditions.map((condition, index) => {
            const field = fieldsByKey.get(condition.field)
            return (
              <li
                key={index}
                className="border-line bg-surface-subtle flex flex-wrap items-start gap-2 rounded-md border p-2"
              >
                <Select
                  size="sm"
                  aria-label={`Condition ${index + 1} field`}
                  className="min-w-40"
                  value={condition.field}
                  disabled={disabled}
                  onChange={(event) => changeField(index, event.target.value)}
                  options={fields.map((entry) => ({ value: entry.key, label: entry.label }))}
                />

                <Select
                  size="sm"
                  aria-label={`Condition ${index + 1} operator`}
                  className="min-w-36"
                  value={condition.operator}
                  disabled={disabled}
                  onChange={(event) => update(index, { operator: event.target.value })}
                  options={(field?.operators ?? []).map((operator) => ({
                    value: operator,
                    label: operatorLabel(operator),
                  }))}
                />

                <ConditionValue
                  condition={condition}
                  field={field}
                  currency={currency}
                  disabled={disabled}
                  index={index}
                  onChange={(next) => update(index, { value: next })}
                />

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Remove condition ${index + 1}`}
                  disabled={disabled}
                  onClick={() => removeCondition(index)}
                >
                  <Trash2 className="size-4" />
                </Button>

                {field?.hint ? (
                  <p className="text-faint basis-full text-xs">{field.hint}</p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      <div>
        <Button type="button" variant="secondary" size="sm" disabled={disabled} onClick={addCondition}>
          <Plus className="size-4" /> Add condition
        </Button>
      </div>
    </div>
  )
}

interface ConditionValueProps {
  condition: RuleCondition
  field: RuleField | undefined
  currency: string
  disabled: boolean
  index: number
  onChange: (value: unknown) => void
}

/** The value control, chosen by the field's type rather than by guesswork. */
function ConditionValue({
  condition,
  field,
  currency,
  disabled,
  index,
  onChange,
}: ConditionValueProps) {
  const label = `Condition ${index + 1} value`

  if (VALUELESS_OPERATORS.has(condition.operator)) return null

  if (LIST_OPERATORS.has(condition.operator)) {
    return (
      <Input
        size="sm"
        className="min-w-44 flex-1"
        aria-label={label}
        placeholder="Comma separated"
        disabled={disabled}
        value={valueText(condition.value)}
        onChange={(event) =>
          onChange(
            event.target.value
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean),
          )
        }
      />
    )
  }

  switch (field?.type) {
    case 'money':
      return (
        <MoneyInput
          size="sm"
          className="min-w-32 flex-1"
          aria-label={label}
          currency={currency}
          disabled={disabled}
          value={typeof condition.value === 'number' ? condition.value : null}
          onValueChange={(minorUnits) => onChange(minorUnits)}
        />
      )

    case 'number':
      return (
        <Input
          size="sm"
          type="number"
          className="min-w-28 flex-1"
          aria-label={label}
          disabled={disabled}
          value={valueText(condition.value)}
          onChange={(event) =>
            onChange(event.target.value === '' ? '' : Number(event.target.value))
          }
        />
      )

    case 'boolean':
      return (
        <Select
          size="sm"
          className="min-w-28"
          aria-label={label}
          disabled={disabled}
          value={condition.value === true || condition.value === 'true' ? 'true' : 'false'}
          onChange={(event) => onChange(event.target.value === 'true')}
          options={[
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]}
        />
      )

    case 'date':
      return (
        <Input
          size="sm"
          type="date"
          className="min-w-40 flex-1"
          aria-label={label}
          disabled={disabled}
          value={typeof condition.value === 'string' ? condition.value.slice(0, 10) : ''}
          // Sent as an instant, because the server compares against timestamps.
          onChange={(event) =>
            onChange(event.target.value ? new Date(`${event.target.value}T00:00:00Z`).toISOString() : '')
          }
        />
      )

    case 'enum':
      return (
        <Select
          size="sm"
          className="min-w-40 flex-1"
          aria-label={label}
          disabled={disabled}
          value={valueText(condition.value)}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Choose one"
          options={(field.options ?? []).map((option) => ({
            value: option,
            label: option.replace(/_/g, ' '),
          }))}
        />
      )

    default:
      return (
        <Input
          size="sm"
          className="min-w-44 flex-1"
          aria-label={label}
          disabled={disabled}
          value={valueText(condition.value)}
          onChange={(event) => onChange(event.target.value)}
        />
      )
  }
}
