import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { messageOf } from '@/lib/api/errors'
import { useProducts } from '@/features/products/hooks/products.hooks'
import { ProductStatusBadge } from '@/features/products/components/ProductStatusBadge'
import { ProductPicker } from './ProductPicker'
import { useSetCollectionProducts } from '../hooks/collections.hooks'

export interface CollectionProductsCardProps {
  collectionId: string
  productIds: string[]
  canWrite: boolean
}

/**
 * The hand-picked list, in the order it will appear.
 *
 * The order is editorial content — "Best Sellers" is an arrangement somebody
 * made — so it is saved wholesale, as one array, rather than as a stream of
 * individual moves. Two people reordering at once then produce one arrangement
 * or the other, not an interleaving of both that neither intended.
 *
 * Moving is by button rather than drag: a keyboard user gets the same
 * affordance as everyone else, and a list of forty on a phone stays usable.
 */
export function CollectionProductsCard({
  collectionId,
  productIds,
  canWrite,
}: CollectionProductsCardProps) {
  const { toast } = useToast()
  const save = useSetCollectionProducts(collectionId)

  const [order, setOrder] = useState<string[]>(productIds)
  const [isPickerOpen, setPickerOpen] = useState(false)

  const isDirty = order.join(' ') !== productIds.join(' ')

  // Re-baselined during render rather than in an effect, so a background
  // refetch never wipes an arrangement somebody is halfway through making.
  const [baseline, setBaseline] = useState(productIds)
  if (baseline.join(' ') !== productIds.join(' ')) {
    setBaseline(productIds)
    if (!isDirty) setOrder(productIds)
  }

  // The rows themselves, at the server's maximum page size. A collection with
  // more hand-picked products than that is a smart collection somebody has not
  // written yet; rows past the first page show as a placeholder rather than
  // being silently dropped from the arrangement.
  const products = useProducts({ page: 1, limit: 100, collectionId })
  const byId = new Map((products.data?.items ?? []).map((product) => [product.id, product]))

  function move(index: number, direction: -1 | 1) {
    const next = [...order]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    const moved = next[index]!
    next[index] = next[target]!
    next[target] = moved
    setOrder(next)
  }

  function remove(productId: string) {
    setOrder(order.filter((id) => id !== productId))
  }

  function commit(ids: string[]) {
    save.mutate(ids, {
      onSuccess: () => toast({ tone: 'success', title: 'Collection updated' }),
      onError: (error) =>
        toast({ tone: 'error', title: 'Could not save', description: messageOf(error) }),
    })
  }

  return (
    <Card>
      <CardHeader
        title="Products"
        description="The order here is the order on the storefront."
        actions={
          canWrite ? (
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<Plus className="size-3.5" />}
              onClick={() => setPickerOpen(true)}
            >
              Add products
            </Button>
          ) : undefined
        }
      />

      <CardBody>
        <QueryBoundary
          isLoading={products.isPending}
          error={products.error}
          onRetry={() => void products.refetch()}
        >
          {order.length === 0 ? (
            <p className="text-muted text-sm">
              Nothing in this collection yet. Add products, or arrange them from the product list.
            </p>
          ) : (
            <ol className="divide-line divide-y">
              {order.map((productId, index) => {
                const product = byId.get(productId)
                return (
                  <li key={productId} className="flex items-center gap-3 py-2">
                    <span className="text-faint tabular w-6 shrink-0 text-xs">{index + 1}</span>

                    <span className="min-w-0 flex-1">
                      {product ? (
                        <Link
                          to={`/products/${productId}`}
                          className="text-ink hover:text-brand-600 block truncate text-sm font-medium"
                        >
                          {product.title}
                        </Link>
                      ) : (
                        <span className="text-faint block truncate text-sm">
                          A product not on this page
                        </span>
                      )}
                      {product?.vendor ? (
                        <span className="text-faint block truncate text-xs">{product.vendor}</span>
                      ) : null}
                    </span>

                    {product ? (
                      <ProductStatusBadge status={product.status} />
                    ) : null}

                    {canWrite ? (
                      <span className="flex shrink-0 items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="xs"
                          iconOnly
                          aria-label={`Move ${product?.title ?? 'product'} up`}
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <ArrowUp className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          iconOnly
                          aria-label={`Move ${product?.title ?? 'product'} down`}
                          disabled={index === order.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <ArrowDown className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          iconOnly
                          aria-label={`Remove ${product?.title ?? 'product'}`}
                          className="hover:text-danger"
                          onClick={() => remove(productId)}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </span>
                    ) : null}
                  </li>
                )
              })}
            </ol>
          )}
        </QueryBoundary>
      </CardBody>

      {canWrite && isDirty ? (
        <CardFooter className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOrder(productIds)}>
            Discard
          </Button>
          <Button isLoading={save.isPending} onClick={() => commit(order)}>
            Save order
          </Button>
        </CardFooter>
      ) : null}

      <ProductPicker
        isOpen={isPickerOpen}
        onClose={() => setPickerOpen(false)}
        excludeIds={order}
        onChoose={(ids) => {
          // Appended, not inserted: adding to a list somebody arranged should
          // leave the arrangement alone.
          const next = [...order, ...ids]
          setOrder(next)
          commit(next)
          setPickerOpen(false)
        }}
      />
    </Card>
  )
}
