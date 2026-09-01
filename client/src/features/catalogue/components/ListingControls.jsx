import { useState } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'
import { useStoreSettings } from '@/features/settings/useSettings'
import { SORTS, fromMinorUnits, toMinorUnits } from '../listingFilters'

/**
 * Sorting and filtering a listing.
 *
 * Every control here maps to a query parameter the server actually implements —
 * `sort`, `minPrice`, `maxPrice`, `inStock`. That is the whole design rule: a
 * control that reordered or filtered only the twelve products already on screen
 * would be a lie about what it did, and it is exactly the lie a listing makes
 * most easily.
 *
 * The URL stays the state, so a filtered listing can be sent to somebody, and
 * the back button undoes a filter rather than leaving the page.
 */

export function ListingControls({ params, onChange, total }) {
  const settings = useStoreSettings()
  const [open, setOpen] = useState(false)

  const sort = params.get('sort') ?? ''
  const inStock = params.get('inStock') === 'true'
  const [minText, setMinText] = useState(fromMinorUnits(params.get('minPrice')))
  const [maxText, setMaxText] = useState(fromMinorUnits(params.get('maxPrice')))

  const activeCount =
    (inStock ? 1 : 0) + (params.get('minPrice') ? 1 : 0) + (params.get('maxPrice') ? 1 : 0)

  /** Every change resets to page 1: page 4 of a narrower result may not exist. */
  function update(changes) {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key)
      else next.set(key, String(value))
    }
    next.delete('page')
    onChange(next)
  }

  function applyPrice() {
    update({ minPrice: toMinorUnits(minText), maxPrice: toMinorUnits(maxText) })
  }

  function clearAll() {
    setMinText('')
    setMaxText('')
    update({ minPrice: null, maxPrice: null, inStock: null })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted text-sm">
          {total === null || total === undefined
            ? ' '
            : total === 0
              ? 'Nothing matched'
              : `${total} ${total === 1 ? 'product' : 'products'}`}
        </p>

        <div className="flex items-center gap-2">
          <Button
            variant={activeCount > 0 ? 'primary' : 'secondary'}
            size="sm"
            aria-expanded={open}
            leadingIcon={<SlidersHorizontal className="size-3.5" aria-hidden="true" />}
            onClick={() => setOpen((current) => !current)}
          >
            Filter{activeCount > 0 ? ` (${activeCount})` : ''}
          </Button>

          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Sort</span>
            <select
              aria-label="Sort products"
              value={sort}
              onChange={(event) => update({ sort: event.target.value })}
              className="border-line bg-surface text-ink focus:border-brand-500 h-9 rounded-lg border px-2 text-sm focus:outline-none"
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {open ? (
        <div className="border-line bg-surface rounded-card flex flex-wrap items-end gap-4 border p-4">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-ink mb-1 text-sm font-medium">
              Price{settings?.currency ? ` (${settings.currency})` : ''}
            </legend>
            <div className="flex items-center gap-2">
              <input
                aria-label="Lowest price"
                inputMode="decimal"
                placeholder="Min"
                value={minText}
                onChange={(event) => setMinText(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && applyPrice()}
                className={priceInput}
              />
              <span className="text-faint">–</span>
              <input
                aria-label="Highest price"
                inputMode="decimal"
                placeholder="Max"
                value={maxText}
                onChange={(event) => setMaxText(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && applyPrice()}
                className={priceInput}
              />
              <Button size="sm" onClick={applyPrice}>
                Apply
              </Button>
            </div>
          </fieldset>

          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={inStock}
              onChange={(event) => update({ inStock: event.target.checked ? 'true' : null })}
              className="accent-brand-600 size-4"
            />
            <span className="text-ink">In stock only</span>
          </label>

          {activeCount > 0 ? (
            <button
              type="button"
              onClick={clearAll}
              className="text-muted hover:text-ink ml-auto flex items-center gap-1 text-sm"
            >
              <X className="size-3.5" aria-hidden="true" />
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const priceInput = cn(
  'border-line bg-surface text-ink placeholder:text-faint focus:border-brand-500',
  'h-9 w-24 rounded-lg border px-3 text-sm focus:outline-none',
)
