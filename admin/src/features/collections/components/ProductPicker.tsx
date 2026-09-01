import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Drawer } from '@/components/ui/Drawer'
import { SearchInput } from '@/components/ui/SearchInput'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useProducts } from '@/features/products/hooks/products.hooks'
import { ProductStatusBadge } from '@/features/products/components/ProductStatusBadge'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'

export interface ProductPickerProps {
  isOpen: boolean
  onClose: () => void
  /** Already in the collection: shown ticked and disabled rather than hidden. */
  excludeIds: string[]
  onChoose: (productIds: string[]) => void
}

/**
 * Choosing products to add.
 *
 * Search runs on the server like every other product list — a picker that
 * filtered a page it had already loaded would quietly only search the first
 * twenty products, which is exactly the case where somebody needs search.
 *
 * Products already in the collection stay visible, ticked and disabled. Hiding
 * them makes the picker look like it cannot find something the merchant knows
 * is there.
 */
export function ProductPicker({ isOpen, onClose, excludeIds, onChoose }: ProductPickerProps) {
  const [search, setSearch] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const debounced = useDebouncedValue(search, 300)

  const products = useProducts({
    page: 1,
    limit: 25,
    ...(debounced ? { q: debounced } : {}),
  })

  const alreadyIn = new Set(excludeIds)

  function close() {
    setSearch('')
    setChosen([])
    onClose()
  }

  function toggle(productId: string) {
    setChosen((current) =>
      current.includes(productId)
        ? current.filter((id) => id !== productId)
        : [...current, productId],
    )
  }

  return (
    <Drawer
      isOpen={isOpen}
      onClose={close}
      title="Add products"
      description="Search the whole catalogue, not just this page."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button disabled={chosen.length === 0} onClick={() => onChoose(chosen)}>
            Add {chosen.length > 0 ? chosen.length : ''}{' '}
            {chosen.length === 1 ? 'product' : 'products'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <SearchInput
          aria-label="Search products"
          placeholder="Title, SKU or vendor…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onClear={() => setSearch('')}
        />

        <QueryBoundary
          isLoading={products.isPending}
          error={products.error}
          onRetry={() => void products.refetch()}
        >
          {products.data && products.data.items.length > 0 ? (
            <ul className="divide-line divide-y">
              {products.data.items.map((product) => {
                const isIn = alreadyIn.has(product.id)
                return (
                  <li key={product.id} className="flex items-center gap-3 py-2">
                    <Checkbox
                      checked={isIn || chosen.includes(product.id)}
                      disabled={isIn}
                      aria-label={`Add ${product.title}`}
                      onChange={() => toggle(product.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-ink block truncate text-sm font-medium">
                        {product.title}
                      </span>
                      <span className="text-faint block truncate text-xs">
                        {isIn ? 'Already in this collection' : (product.vendor ?? `/${product.handle}`)}
                      </span>
                    </span>
                    <ProductStatusBadge status={product.status} />
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-muted text-sm">
              {debounced ? 'No products match that.' : 'No products yet.'}
            </p>
          )}
        </QueryBoundary>
      </div>
    </Drawer>
  )
}
