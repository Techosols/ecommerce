import { Alert } from '@/components/ui/Alert'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Switch } from '@/components/ui/Switch'
import { TagsInput } from '@/components/ui/TagsInput'
import { formatMoney } from '@/lib/format'

export interface CodValues {
  codEnabled: boolean
  codMinSubtotalCents: number
  codMaxSubtotalCents: number | null
  codFeeCents: number
  codCountryCodes: string[]
  codRequiresAccount: boolean
  codMaxOpenOrders: number | null
}

export interface CashOnDeliveryCardProps {
  values: CodValues
  currency: string
  disabled: boolean
  onChange: (patch: Partial<CodValues>) => void
}

/**
 * Cash on delivery, and the five ways it loses money.
 *
 * Every control here is a limit rather than a feature: an unpaid order is stock
 * off the shelf and a courier already paid, so the floor stops the store
 * shipping a £2 order it loses money on, the ceiling caps a single unpaid
 * exposure, the whitelist keeps it to countries where refusal-at-the-door is
 * survivable, and the open-order cap is what stops one person holding fifteen
 * of them at once. They are grouped and worded as limits for that reason.
 *
 * The server enforces every one of these at checkout. Nothing here decides
 * whether an order may be placed; it decides what the rule is.
 */
export function CashOnDeliveryCard({
  values,
  currency,
  disabled,
  onChange,
}: CashOnDeliveryCardProps) {
  const money = (amount: number) => formatMoney({ amount, currency: currency || 'GBP' })
  const rangeIsBackwards =
    values.codMaxSubtotalCents !== null && values.codMaxSubtotalCents < values.codMinSubtotalCents

  return (
    <Card>
      <CardHeader
        title="Cash on delivery"
        description="Taking payment at the door, and the limits that make it survivable."
        actions={
          <Switch
            checked={values.codEnabled}
            disabled={disabled}
            label="Offer cash on delivery"
            onCheckedChange={(checked) => onChange({ codEnabled: checked })}
          />
        }
      />

      {values.codEnabled ? (
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Smallest order"
              hint="Below this, the courier costs more than the order is worth."
            >
              <MoneyInput
                currency={currency}
                disabled={disabled}
                value={values.codMinSubtotalCents}
                onValueChange={(amount) => onChange({ codMinSubtotalCents: amount ?? 0 })}
              />
            </Field>

            <Field
              label="Largest order"
              hint="Blank means no ceiling — one refusal can be any size."
              error={rangeIsBackwards ? 'The ceiling is below the floor.' : undefined}
            >
              <MoneyInput
                currency={currency}
                disabled={disabled}
                value={values.codMaxSubtotalCents}
                onValueChange={(amount) => onChange({ codMaxSubtotalCents: amount })}
              />
            </Field>

            <Field label="Handling fee" hint="Added to the order total, and shown to the shopper.">
              <MoneyInput
                currency={currency}
                disabled={disabled}
                value={values.codFeeCents}
                onValueChange={(amount) => onChange({ codFeeCents: amount ?? 0 })}
              />
            </Field>

            <Field
              label="Unpaid orders per customer"
              hint="Blank means no cap."
            >
              <Input
                type="number"
                min={1}
                max={1000}
                step={1}
                disabled={disabled}
                value={values.codMaxOpenOrders === null ? '' : String(values.codMaxOpenOrders)}
                placeholder="No cap"
                onChange={(event) =>
                  onChange({
                    codMaxOpenOrders:
                      event.target.value === '' ? null : Number(event.target.value),
                  })
                }
              />
            </Field>
          </div>

          <Field
            label="Countries"
            hint="Two-letter codes. Leave empty to offer it everywhere the store ships."
          >
            <TagsInput
              disabled={disabled}
              value={values.codCountryCodes}
              maxLength={2}
              placeholder="GB, IE…"
              onChange={(codes) =>
                onChange({
                  codCountryCodes: [
                    ...new Set(
                      codes
                        .map((code) => code.trim().toUpperCase())
                        .filter((code) => /^[A-Z]{2}$/.test(code)),
                    ),
                  ],
                })
              }
            />
          </Field>

          <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
            <div>
              <p className="text-ink text-sm font-medium">Account holders only</p>
              <p className="text-muted mt-0.5 text-xs">
                A guest leaves nothing behind but an address. Requiring an account is what makes
                the open-order cap mean anything.
              </p>
            </div>
            <Switch
              checked={values.codRequiresAccount}
              disabled={disabled}
              label="Account holders only"
              onCheckedChange={(checked) => onChange({ codRequiresAccount: checked })}
            />
          </div>

          <Alert tone="info">
            An order between {money(values.codMinSubtotalCents)} and{' '}
            {values.codMaxSubtotalCents === null
              ? 'any amount'
              : money(values.codMaxSubtotalCents)}{' '}
            can be paid at the door
            {values.codFeeCents > 0 ? `, for a ${money(values.codFeeCents)} handling fee` : ''}
            {values.codCountryCodes.length > 0
              ? `, in ${values.codCountryCodes.join(', ')}`
              : ', anywhere the store ships'}
            .
          </Alert>
        </CardBody>
      ) : (
        <CardBody>
          <p className="text-muted text-sm">
            Off. Every order is paid before it ships, and the limits below are kept in case it is
            turned back on.
          </p>
        </CardBody>
      )}
    </Card>
  )
}
