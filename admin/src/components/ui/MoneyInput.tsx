import { useState } from 'react'
import { cn } from '@/lib/cn'
import { Input, type InputProps } from './Input'

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF'])

function decimalsFor(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2
}

export interface MoneyInputProps extends Omit<
  InputProps,
  'value' | 'onChange' | 'type' | 'inputMode'
> {
  /** Integer minor units, exactly as the API carries money. `null` is empty. */
  value: number | null
  onValueChange: (minorUnits: number | null) => void
  currency: string
}

/**
 * A price field that speaks minor units to the API and major units to a person.
 *
 * The server refuses anything but an integer of minor units — `12.99` is a 422,
 * `1299` is a price — so the conversion has to happen somewhere. Here is the
 * only place in the admin it does, and it happens on the way in and out of one
 * input rather than being scattered through every form.
 *
 * The typed text is kept as state rather than being derived from the number on
 * every render: deriving it means "1.50" becomes "1.5" the moment a keystroke
 * round-trips, and the cursor jumps.
 */
export function MoneyInput({
  value,
  onValueChange,
  currency,
  className,
  ...props
}: MoneyInputProps) {
  const decimals = decimalsFor(currency)
  const factor = 10 ** decimals

  const [text, setText] = useState(() => (value === null ? '' : (value / factor).toFixed(decimals)))
  const [lastValue, setLastValue] = useState(value)

  // Re-sync when the value changes from *outside* — a form reset, or a loaded
  // product arriving — but not while the field is being typed into.
  //
  // Adjusting state during render rather than in an effect: React sanctions
  // this for props-derived state, and it re-renders before painting, so the
  // input never shows the stale number for a frame.
  if (value !== lastValue) {
    setLastValue(value)
    const typed = text.trim() === '' ? null : Math.round(Number(text.replace(',', '.')) * factor)
    // Only overwrite when the field does not already say this number, so a
    // round-tripped keystroke cannot rewrite "1.50" as "1.5" under the cursor.
    if (typed !== value) setText(value === null ? '' : (value / factor).toFixed(decimals))
  }

  function handleChange(next: string) {
    // Digits and at most one separator. Rejecting the keystroke rather than
    // accepting and sanitising later is what stops "1..5" ever existing.
    if (next !== '' && !new RegExp(`^\\d*([.,]\\d{0,${decimals}})?$`).test(next)) return
    setText(next)

    const normalised = next.replace(',', '.').trim()
    if (normalised === '' || normalised === '.') {
      onValueChange(null)
      return
    }
    const parsed = Number(normalised)
    // Rounding rather than truncating: 0.1 * 100 is 10.000000000000002 in
    // floating point, and Math.trunc would make that 10 pence into 9.
    onValueChange(Number.isNaN(parsed) ? null : Math.round(parsed * factor))
  }

  return (
    <Input
      {...props}
      type="text"
      inputMode="decimal"
      value={text}
      onChange={(event) => handleChange(event.target.value)}
      onBlur={(event) => {
        if (text.trim() !== '') setText((Number(text.replace(',', '.')) || 0).toFixed(decimals))
        props.onBlur?.(event)
      }}
      leadingIcon={<span className="text-faint text-xs font-medium">{currency.toUpperCase()}</span>}
      className={cn('pl-12', className)}
    />
  )
}
