import { useState } from 'react'
import { Check, Loader2, ShoppingBag, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { messageOf } from '@/lib/api'
import { formatMoney } from '@/lib/format'
import { useAddToCart } from '@/features/cart/hooks/cart.hooks'
import { useProduct } from '../hooks/catalogue.hooks'
import { OptionPicker } from './OptionPicker'
import { chooseValue, initialVariant, selectionOf, variantFor } from '../variantSelection'

/**
 * Adding something to the basket without leaving the grid.
 *
 * The card DTO carries no variants — deliberately, since a listing of twelve
 * products would otherwise ship twelve full variant tables — so the panel
 * fetches the product the moment somebody opens it, and not before. One
 * request, made only when asked for, against an endpoint already cached by
 * React Query for anybody who then opens the product page.
 *
 * A product with one variant skips the picker entirely and adds on the first
 * click, which is the case this feature is really for.
 */
export function QuickAdd({ handle, title, onClose }) {
  const query = useProduct(handle)
  const add = useAddToCart()
  const [selection, setSelection] = useState(null)
  const [added, setAdded] = useState(false)

  const product = query.data
  // `selection` is null until the product lands, then seeded from the first
  // buyable variant — the same starting point the product page uses, so the two
  // screens never disagree about what "the default" is.
  const active = selection ?? (product ? selectionOf(initialVariant(product)) : {})
  const selected = product ? (variantFor(product, active) ?? initialVariant(product)) : null

  return (
    <div
      role="dialog"
      aria-label={`Add ${title} to your basket`}
      className="border-line bg-surface shadow-lift absolute inset-x-0 bottom-0 z-20 flex flex-col gap-3 rounded-t-xl border-t p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-ink text-sm font-semibold">{title}</p>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="text-faint hover:text-ink -mt-1 -mr-1 rounded p-1"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {query.isPending ? (
        <p className="text-muted flex items-center gap-2 py-4 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading the options…
        </p>
      ) : query.error ? (
        <p className="text-bad text-sm">{messageOf(query.error)}</p>
      ) : (
        <>
          {product.variants.length > 1
            ? product.options.map((option) => (
                <OptionPicker
                  key={option.id}
                  product={product}
                  option={option}
                  selection={active}
                  onChoose={(chosenOption, valueId) =>
                    setSelection(chooseValue(product, active, chosenOption, valueId))
                  }
                />
              ))
            : null}

          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="text-ink tabular font-medium">{formatMoney(selected?.price)}</span>

            <Button
              variant={added ? 'copper' : 'primary'}
              size="sm"
              isLoading={add.isPending}
              disabled={!selected?.available}
              leadingIcon={
                added ? (
                  <Check className="size-3.5" aria-hidden="true" />
                ) : (
                  <ShoppingBag className="size-3.5" aria-hidden="true" />
                )
              }
              onClick={() =>
                add.mutate(
                  { variantId: selected.id, quantity: 1 },
                  {
                    onSuccess: () => {
                      setAdded(true)
                      // Long enough to read, short enough that the card is not
                      // stuck open behind a panel nobody is using.
                      window.setTimeout(onClose, 1200)
                    },
                  },
                )
              }
            >
              {added ? 'Added' : selected?.available ? 'Add to basket' : 'Sold out'}
            </Button>
          </div>

          {add.error ? <p className="text-bad text-xs">{messageOf(add.error)}</p> : null}
        </>
      )}
    </div>
  )
}
