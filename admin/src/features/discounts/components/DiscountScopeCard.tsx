import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { Field } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useCategories } from '@/features/categories/hooks/categories.hooks'
import { useProducts } from '@/features/products/hooks/products.hooks'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { messageOf } from '@/lib/api/errors'
import { useUpdateDiscount } from '../hooks/discounts.hooks'
import { APPLIES_TO_LABELS } from './discountLabels'
import type { DiscountAppliesTo, DiscountDetail } from '../types/discounts.types'

export interface DiscountScopeCardProps {
  discount: DiscountDetail
  canWrite: boolean
}

/**
 * What the discount actually comes off.
 *
 * This is the difference between "10% off coffee" and "10% off the shop", and
 * until now it was invisible: the scope was accepted when the code was created
 * and never shown again. A promotion pointed at the wrong category is a
 * mistake somebody has to be able to see before it has run for a week.
 *
 * Saved on its own rather than with the rest of the page. Picking products is
 * a deliberate act with its own dialog, and holding the result behind a form's
 * Save button would mean choosing forty products and losing them to a reload.
 */
export function DiscountScopeCard({ discount, canWrite }: DiscountScopeCardProps) {
  const { toast } = useToast()
  const update = useUpdateDiscount(discount.id)
  const [picking, setPicking] = useState(false)

  const categories = useCategories()
  // Only what is on the discount: a page showing forty chosen products needs
  // their titles, and the list endpoint is the only thing that has them.
  const chosenProducts = useProducts({ page: 1, limit: 100 })

  const productTitles = new Map(
    (chosenProducts.data?.items ?? []).map((product) => [product.id, product.title]),
  )
  const categoryNames = new Map(
    (categories.data ?? []).map((category) => [category.id, category.name]),
  )

  function save(patch: {
    appliesTo?: DiscountAppliesTo
    productIds?: string[]
    categoryIds?: string[]
  }) {
    update.mutate(patch, {
      onSuccess: () => toast({ tone: 'success', title: 'Scope updated' }),
      onError: (error) =>
        toast({ tone: 'error', title: 'Could not save the scope', description: messageOf(error) }),
    })
  }

  const ids = discount.appliesTo === 'products' ? discount.productIds : discount.categoryIds
  const nameOf = (id: string) =>
    discount.appliesTo === 'products'
      ? (productTitles.get(id) ?? 'A product')
      : (categoryNames.get(id) ?? 'A category')

  return (
    <Card>
      <CardHeader title="What it applies to" description="The part of a basket this comes off." />
      <CardBody className="flex flex-col gap-4">
        <Field label="Applies to">
          <Select
            disabled={!canWrite || update.isPending}
            value={discount.appliesTo}
            onChange={(event) => save({ appliesTo: event.target.value as DiscountAppliesTo })}
            options={(['order', 'products', 'categories'] as const).map((value) => ({
              value,
              label: APPLIES_TO_LABELS[value],
            }))}
          />
        </Field>

        {discount.appliesTo === 'order' ? (
          <p className="text-muted text-sm">
            Every line in the basket. The whole subtotal is discounted.
          </p>
        ) : (
          <>
            {ids.length === 0 ? (
              <Alert tone="warning">
                {/* The server refuses the code outright in this state, so it is
                    said here in the same terms rather than left to be
                    discovered by a customer at checkout. */}
                Nothing is chosen, so this code applies to nothing and every customer who types it
                is told it does not apply to their basket.
              </Alert>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {ids.map((id) => (
                  <li key={id}>
                    <Badge tone="neutral">
                      {nameOf(id)}
                      {canWrite ? (
                        <button
                          type="button"
                          aria-label={`Remove ${nameOf(id)}`}
                          className="hover:text-danger ml-1"
                          onClick={() =>
                            save(
                              discount.appliesTo === 'products'
                                ? { productIds: discount.productIds.filter((one) => one !== id) }
                                : { categoryIds: discount.categoryIds.filter((one) => one !== id) },
                            )
                          }
                        >
                          <X className="size-3" />
                        </button>
                      ) : null}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}

            {canWrite ? (
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<Plus className="size-3.5" />}
                  onClick={() => setPicking(true)}
                >
                  {discount.appliesTo === 'products' ? 'Choose products' : 'Choose categories'}
                </Button>
              </div>
            ) : null}

            {discount.appliesTo === 'categories' ? (
              <p className="text-muted text-xs">
                A category scope reaches products through their category, so adding a product to one
                of these puts it in the promotion without touching this discount.
              </p>
            ) : null}
          </>
        )}
      </CardBody>

      {picking ? (
        <ScopePicker
          discount={discount}
          isPending={update.isPending}
          onClose={() => setPicking(false)}
          onSave={(next) => {
            save(next)
            setPicking(false)
          }}
        />
      ) : null}
    </Card>
  )
}

function ScopePicker({
  discount,
  isPending,
  onClose,
  onSave,
}: {
  discount: DiscountDetail
  isPending: boolean
  onClose: () => void
  onSave: (patch: { productIds?: string[]; categoryIds?: string[] }) => void
}) {
  const isProducts = discount.appliesTo === 'products'
  const [selected, setSelected] = useState<string[]>(
    isProducts ? discount.productIds : discount.categoryIds,
  )
  const [search, setSearch] = useState('')
  const debounced = useDebouncedValue(search, 300)

  const products = useProducts({ page: 1, limit: 50, ...(debounced ? { q: debounced } : {}) })
  const categories = useCategories()

  const rows = isProducts
    ? (products.data?.items ?? []).map((product) => ({ id: product.id, label: product.title }))
    : (categories.data ?? [])
        .filter((category) =>
          debounced ? category.name.toLowerCase().includes(debounced.toLowerCase()) : true,
        )
        .map((category) => ({ id: category.id, label: category.name }))

  function toggle(id: string, checked: boolean) {
    setSelected((current) =>
      checked ? [...new Set([...current, id])] : current.filter((one) => one !== id),
    )
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isProducts ? 'Choose products' : 'Choose categories'}
      description="Only these will be discounted."
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted text-sm">{selected.length} chosen</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              isLoading={isPending}
              onClick={() =>
                onSave(isProducts ? { productIds: selected } : { categoryIds: selected })
              }
            >
              Save
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <SearchInput
          aria-label={isProducts ? 'Search products' : 'Search categories'}
          placeholder="Search…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onClear={() => setSearch('')}
        />

        <QueryBoundary
          isLoading={isProducts ? products.isPending : categories.isPending}
          error={isProducts ? products.error : categories.error}
          onRetry={() => void (isProducts ? products.refetch() : categories.refetch())}
        >
          {rows.length === 0 ? (
            <p className="text-muted text-sm">Nothing matches that.</p>
          ) : (
            <ul className="divide-line max-h-80 divide-y overflow-y-auto">
              {rows.map((row) => (
                <li key={row.id}>
                  <label className="hover:bg-surface-hover flex cursor-pointer items-center gap-3 px-1 py-2">
                    <Checkbox
                      checked={selected.includes(row.id)}
                      onChange={(event) => toggle(row.id, event.target.checked)}
                    />
                    <span className="text-ink truncate text-sm">{row.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>

        {/* Chosen items that this page of results does not contain are still
            selected — the count in the footer is the whole selection, not what
            is visible. */}
        <p className="text-faint text-xs">Searching does not clear what you have already chosen.</p>
      </div>
    </Modal>
  )
}
