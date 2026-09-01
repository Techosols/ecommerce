import { useState } from 'react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Spinner } from '@/components/ui/Spinner'
import { useStoreCurrency } from '@/features/settings/store.hooks'
import { formatMoney } from '@/lib/format'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useRateQuote } from '../hooks/shipping.hooks'

/**
 * What a shopper would actually be offered.
 *
 * This calls the **public** quote endpoint — the same one the storefront calls
 * — rather than working the rate card out in the browser. A preview that
 * reimplemented the pricing would eventually disagree with checkout, and the
 * preview is the one people would trust.
 *
 * It is also the only way to see the rules interact: a weight band silently
 * withdrawing a method, a free-over threshold beating a per-kilogram price, a
 * country covered by no zone at all. Reading those off the rate card requires
 * holding four fields in your head; typing a country and a basket does not.
 */
export function RatePreview() {
  const currency = useStoreCurrency()
  const [country, setCountry] = useState('GB')
  const [subtotal, setSubtotal] = useState<number | null>(5000)
  const [weight, setWeight] = useState('1')

  const params = {
    countryCode: country.trim().toUpperCase(),
    subtotalCents: subtotal ?? 0,
    weightGrams: Math.round((Number(weight) || 0) * 1000),
  }
  const debounced = useDebouncedValue(params, 400)
  const quote = useRateQuote(debounced)

  return (
    <Card>
      <CardHeader
        title="What a shopper sees"
        description="The real checkout quote, for a destination and a basket you choose."
      />
      <CardBody className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Ships to" hint="Two-letter country code.">
            <Input
              maxLength={2}
              value={country}
              placeholder="GB"
              onChange={(event) => setCountry(event.target.value.toUpperCase())}
            />
          </Field>

          <Field label="Basket total">
            <MoneyInput currency={currency} value={subtotal} onValueChange={setSubtotal} />
          </Field>

          <Field label="Weight" hint="Kilograms.">
            <Input
              type="number"
              min={0}
              step={0.1}
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
            />
          </Field>
        </div>

        {!/^[A-Z]{2}$/.test(params.countryCode) ? (
          <p className="text-muted text-sm">Type a country code to see the quote.</p>
        ) : quote.isPending ? (
          <span className="text-muted flex items-center gap-2 text-sm">
            <Spinner size="sm" /> Asking the server…
          </span>
        ) : quote.data && quote.data.length > 0 ? (
          <ul className="divide-line divide-y">
            {quote.data.map((rate) => (
              <li key={rate.id} className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="text-ink block truncate text-sm font-medium">{rate.name}</span>
                  <span className="text-faint block truncate text-xs">
                    {rate.description ??
                      (rate.estimatedDaysMin !== null
                        ? `${rate.estimatedDaysMin}–${rate.estimatedDaysMax ?? rate.estimatedDaysMin} days`
                        : 'No estimate given')}
                  </span>
                </span>
                <span className="text-ink tabular shrink-0 text-sm font-medium">
                  {rate.price.amount === 0 ? 'Free' : formatMoney(rate.price)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-warning text-sm">
            Nothing is offered to {params.countryCode} for that basket. A shopper there is told the
            store does not deliver to them.
          </p>
        )}
      </CardBody>
    </Card>
  )
}
