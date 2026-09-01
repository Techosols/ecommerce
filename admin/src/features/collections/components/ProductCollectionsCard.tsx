import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Sparkles, X } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { messageOf } from '@/lib/api/errors'
import {
  useBulkProductAction,
  useCollections,
  useProductCollections,
} from '../hooks/collections.hooks'

export interface ProductCollectionsCardProps {
  productId: string
  canWrite: boolean
}

/**
 * Where this product appears.
 *
 * Both kinds are listed, and the difference is the point: a hand-picked
 * membership can be removed here, and a smart one cannot — it is there because
 * the rules match, and the honest way to take it out is to change the rules or
 * change the product. Offering a remove button that silently did nothing, or
 * that quietly edited somebody's rules, would be worse than saying so.
 */
export function ProductCollectionsCard({ productId, canWrite }: ProductCollectionsCardProps) {
  const { toast } = useToast()
  const mine = useProductCollections(productId)
  const all = useCollections()
  const bulk = useBulkProductAction()

  const [adding, setAdding] = useState('')

  const inIds = new Set((mine.data ?? []).map((collection) => collection.id))
  // Only manual collections can be joined by hand, and only ones it is not
  // already in.
  const available = (all.data ?? []).filter(
    (collection) => collection.type === 'manual' && !inIds.has(collection.id),
  )

  function change(collectionId: string, action: 'addToCollection' | 'removeFromCollection') {
    bulk.mutate(
      { productIds: [productId], action, collectionId },
      {
        onSuccess: () => {
          toast({
            tone: 'success',
            title: action === 'addToCollection' ? 'Added to collection' : 'Removed from collection',
          })
          setAdding('')
        },
        onError: (error) =>
          toast({ tone: 'error', title: 'Could not save', description: messageOf(error) }),
      },
    )
  }

  return (
    <Card>
      <CardHeader
        title="Collections"
        description="Where this product appears on the storefront."
      />

      <CardBody className="flex flex-col gap-3">
        <QueryBoundary
          isLoading={mine.isPending}
          error={mine.error}
          onRetry={() => void mine.refetch()}
        >
          {mine.data && mine.data.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {mine.data.map((collection) => (
                <li
                  key={collection.id}
                  className="border-line flex items-center gap-2 rounded-md border px-2.5 py-1.5"
                >
                  <Link
                    to={`/collections/${collection.id}`}
                    className="text-ink hover:text-brand-600 min-w-0 flex-1 truncate text-sm"
                  >
                    {collection.title}
                  </Link>

                  {collection.matchedByRules ? (
                    <Badge tone="brand" size="sm">
                      <Sparkles className="mr-1 size-3" />
                      By rule
                    </Badge>
                  ) : canWrite ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      aria-label={`Remove from ${collection.title}`}
                      className="hover:text-danger"
                      disabled={bulk.isPending}
                      onClick={() => change(collection.id, 'removeFromCollection')}
                    >
                      <X className="size-3.5" />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted text-sm">Not in any collection.</p>
          )}
        </QueryBoundary>

        {canWrite && available.length > 0 ? (
          <div className="flex items-center gap-2">
            <Select
              size="sm"
              aria-label="Add to a collection"
              className="flex-1"
              value={adding}
              disabled={bulk.isPending}
              placeholder="Add to a collection…"
              onChange={(event) => setAdding(event.target.value)}
              options={available.map((collection) => ({
                value: collection.id,
                label: collection.title,
              }))}
            />
            <Button
              size="sm"
              variant="secondary"
              iconOnly
              aria-label="Add to this collection"
              disabled={adding === ''}
              isLoading={bulk.isPending}
              onClick={() => change(adding, 'addToCollection')}
            >
              <Plus className="size-4" />
            </Button>
          </div>
        ) : null}

        {/* Said once, plainly, rather than as a disabled button per row. */}
        {(mine.data ?? []).some((collection) => collection.matchedByRules) ? (
          <p className="text-faint text-xs">
            Collections marked “by rule” hold this product because it matches their conditions.
            Change the rules or the product to take it out.
          </p>
        ) : null}
      </CardBody>
    </Card>
  )
}
