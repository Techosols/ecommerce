import { cn } from '@/lib/cn'
import { isColourOption, valueStates } from '../variantSelection'

/**
 * One question per axis: colour as circles, everything else as chips.
 *
 * Colours are shown, not named. "Mulberry" and "NBM01 Deep Brown" tell a
 * shopper nothing they can act on, and the whole reason the merchant set a hex
 * in the admin is so this row can paint it. The name still travels — as the
 * accessible label, and as a caption under the row — because a circle is
 * useless to a screen reader and ambiguous to anybody comparing two similar
 * shades.
 *
 * Three states per value, and they are deliberately different:
 *
 *   • **selected** — a ring around it, not merely a border colour, so it reads
 *     at a glance on a row of similar tones.
 *   • **sold out** — visible, marked, and not choosable. Hiding it would leave
 *     somebody wondering whether their size was ever made.
 *   • **not made** — the combination does not exist at all. Struck through
 *     rather than dimmed, because "we never made a thin large" and "the thin
 *     large is out of stock" are different sentences.
 */
export function OptionPicker({ product, option, selection, onChoose }) {
  const states = valueStates(product, option, selection)
  const chosenId = selection[option.name]
  const chosen = option.values.find((value) => value.id === chosenId)
  const colour = isColourOption(option)

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 flex items-baseline gap-2 text-sm">
        <span className="text-ink font-medium">{option.name}</span>
        {/* The name of what is chosen, which the circle cannot say. */}
        {colour && chosen ? <span className="text-muted">{chosen.value}</span> : null}
      </legend>

      <div className={cn('flex flex-wrap', colour ? 'gap-2.5' : 'gap-2')}>
        {option.values.map((value) => {
          const state = states[value.id]
          const isSelected = value.id === chosenId
          const disabled = !state.exists || !state.available

          // Said in full for a screen reader, which gets neither the circle nor
          // the strike-through.
          const label = !state.exists
            ? `${value.value} — not available in this combination`
            : !state.available
              ? `${value.value} — sold out`
              : value.value

          return (
            <label
              key={value.id}
              title={value.value}
              className={cn(
                'relative cursor-pointer transition-transform',
                disabled && 'cursor-not-allowed',
                !disabled && 'hover:scale-105',
              )}
            >
              <input
                type="radio"
                name={option.name}
                value={value.id}
                checked={isSelected}
                disabled={disabled}
                onChange={() => onChoose(option, value.id)}
                aria-label={label}
                className="peer sr-only"
              />

              {colour ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    'block size-9 rounded-full border transition-shadow',
                    // A ring rather than a thicker border: a border grows the
                    // circle and makes a row of swatches jump as you click
                    // along it.
                    isSelected
                      ? 'ring-brand-600 border-black/10 ring-2 ring-offset-2'
                      : 'border-black/15',
                    // Keyboard focus has to be visible too, and the radio it
                    // belongs to is off-screen.
                    'peer-focus-visible:ring-brand-400 peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2',
                    disabled && 'opacity-40',
                  )}
                  style={{ backgroundColor: value.swatchHex ?? 'transparent' }}
                />
              ) : (
                <span
                  className={cn(
                    'block rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
                    isSelected
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-line bg-surface text-ink-soft hover:border-line-strong',
                    'peer-focus-visible:ring-brand-400 peer-focus-visible:ring-2',
                    disabled && 'text-faint opacity-60',
                  )}
                >
                  {value.value}
                </span>
              )}

              {/* One diagonal line for a value that cannot be had. Drawn over
                  both shapes, so a struck circle and a struck chip read the
                  same way. */}
              {disabled ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 flex items-center justify-center"
                >
                  <span className="bg-bad/60 h-px w-[130%] -rotate-45" />
                </span>
              ) : null}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
