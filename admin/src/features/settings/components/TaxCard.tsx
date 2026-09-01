import { Alert } from '@/components/ui/Alert'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { formatMoney } from '@/lib/format'
import { bpsToPercent, percentToBps, taxOn } from './taxMath'

export interface TaxCardProps {
  taxRateBps: number
  pricesIncludeTax: boolean
  currency: string
  disabled: boolean
  onChange: (patch: { taxRateBps?: number; pricesIncludeTax?: boolean }) => void
}

/**
 * How much tax, and whether the price already contains it.
 *
 * The worked example is the point of the card. `pricesIncludeTax` is one
 * checkbox that changes what every price in the catalogue *means* — the same
 * £10.00 is either £12.00 at the till or £10.00 with £1.67 of it being tax —
 * and there is no way to see which reading is in force except by working an
 * example. So the card works one, in the store's own currency, at the store's
 * own rate, and updates as the rate is typed.
 */
export function TaxCard({
  taxRateBps,
  pricesIncludeTax,
  currency,
  disabled,
  onChange,
}: TaxCardProps) {
  // £10, or 1000 of whatever the minor unit is. A round number so the
  // arithmetic is checkable at a glance.
  const sample = 1000
  const tax = taxOn(sample, taxRateBps, pricesIncludeTax)
  const money = (amount: number) => formatMoney({ amount, currency: currency || 'GBP' })

  return (
    <Card>
      <CardHeader
        title="Tax"
        description="One rate, applied to every order. Change it and past orders keep the rate they were placed at."
      />
      <CardBody className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Rate"
            hint="Two decimal places, so 8.75% is exact."
            className="max-w-40"
          >
            <div className="relative">
              <Input
                type="number"
                min={0}
                max={100}
                step={0.01}
                disabled={disabled}
                value={bpsToPercent(taxRateBps)}
                onChange={(event) => onChange({ taxRateBps: percentToBps(event.target.value) })}
                className="pr-7"
              />
              <span className="text-faint pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm">
                %
              </span>
            </div>
          </Field>

          <Field label="Catalogue prices">
            <Select
              disabled={disabled}
              value={pricesIncludeTax ? 'inclusive' : 'exclusive'}
              onChange={(event) =>
                onChange({ pricesIncludeTax: event.target.value === 'inclusive' })
              }
              options={[
                { value: 'exclusive', label: 'Exclude tax — it is added at checkout' },
                { value: 'inclusive', label: 'Include tax — the price is what is paid' },
              ]}
            />
          </Field>
        </div>

        <Alert tone="info" title="What that means for a price of 10">
          {taxRateBps === 0 ? (
            <>No tax is charged at all. Every order totals its subtotal plus delivery.</>
          ) : pricesIncludeTax ? (
            <>
              A product priced {money(sample)} is charged {money(sample)}, of which{' '}
              <strong>{money(tax)}</strong> is tax. The shopper pays what the price says.
            </>
          ) : (
            <>
              A product priced {money(sample)} is charged{' '}
              <strong>{money(sample + tax)}</strong> — {money(sample)} plus {money(tax)} of tax
              added at checkout.
            </>
          )}
        </Alert>
      </CardBody>
    </Card>
  )
}
