import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, Plus, Sparkles, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { PageHeader } from '@/components/ui/PageHeader'
import { useToast } from '@/components/ui/toast.context'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { formatNumber } from '@/lib/format'
import { CollectionFormDialog } from '../components/CollectionFormDialog'
import { useArchiveCollection, useCollections } from '../hooks/collections.hooks'
import type { CollectionSummary } from '../types/collections.types'

/**
 * The shop's merchandising groupings.
 *
 * Both kinds sit in one list because they are one idea to a merchant — "a place
 * products appear" — and the difference shows in the badge and in the count's
 * subtitle rather than in two separate screens they would have to choose
 * between before knowing which they wanted.
 *
 * Every count here is a live query. A smart collection has no stored number:
 * its membership is whatever the rules match at the moment you ask.
 */
export function CollectionListPage() {
  const navigate = useNavigate()
  const { can } = useAuth()
  const { toast } = useToast()
  useDocumentTitle('Collections')

  const canWrite = can('catalog:write')
  const collections = useCollections()
  const archive = useArchiveCollection()

  const [isCreateOpen, setCreateOpen] = useState(false)
  const [archiving, setArchiving] = useState<CollectionSummary | null>(null)

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Collections"
        actions={
          canWrite ? (
            <Button
              variant="primary"
              leadingIcon={<Plus className="size-4" />}
              onClick={() => setCreateOpen(true)}
            >
              Create collection
            </Button>
          ) : undefined
        }
      />

      <QueryBoundary
        isLoading={collections.isPending}
        error={collections.error}
        onRetry={() => void collections.refetch()}
      >
        {collections.data && collections.data.length > 0 ? (
          <ul className="grid gap-4 sm:grid-cols-2">
            {collections.data.map((collection) => (
              <li key={collection.id}>
                <Card className="flex h-full flex-col">
                  <CardHeader
                    title={
                      <span className="flex flex-wrap items-center gap-2">
                        {collection.title}
                        {collection.type === 'dynamic' ? (
                          <Badge tone="brand" size="sm">
                            <Sparkles className="mr-1 size-3" />
                            Smart
                          </Badge>
                        ) : null}
                        {!collection.isActive ? (
                          <Badge tone="neutral" size="sm">
                            Hidden
                          </Badge>
                        ) : null}
                      </span>
                    }
                    description={
                      collection.type === 'dynamic'
                        ? (collection.summary ?? 'Every product')
                        : (collection.description ?? `/${collection.handle}`)
                    }
                  />

                  <CardBody className="mt-auto flex flex-col gap-4">
                    <p className="text-ink tabular text-2xl font-semibold">
                      {formatNumber(collection.productCount)}
                      <span className="text-muted ml-1.5 text-sm font-normal">
                        {collection.productCount === 1 ? 'product' : 'products'}
                      </span>
                    </p>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void navigate(`/collections/${collection.id}`)}
                      >
                        Open
                      </Button>
                      {canWrite ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="hover:text-danger"
                          leadingIcon={<Trash2 className="size-3.5" />}
                          onClick={() => setArchiving(collection)}
                        >
                          Archive
                        </Button>
                      ) : null}
                    </div>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <Card>
            <EmptyState
              icon={<LayoutGrid className="size-5" />}
              title="No collections yet"
              description="A collection groups products for the storefront — a hand-picked list like Best Sellers, or a rule like everything under £50."
              actions={
                canWrite ? (
                  <Button onClick={() => setCreateOpen(true)}>Create a collection</Button>
                ) : undefined
              }
            />
          </Card>
        )}
      </QueryBoundary>

      <CollectionFormDialog
        isOpen={isCreateOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => void navigate(`/collections/${id}`)}
      />

      <ConfirmDialog
        isOpen={archiving !== null}
        onCancel={() => setArchiving(null)}
        onConfirm={() => {
          if (!archiving) return
          archive.mutate(archiving.id, {
            onSuccess: () => {
              toast({ tone: 'success', title: 'Collection archived' })
              setArchiving(null)
            },
            onError: (error) => {
              toast({ tone: 'error', title: 'Could not archive', description: messageOf(error) })
              setArchiving(null)
            },
          })
        }}
        title={`Archive "${archiving?.title ?? ''}"?`}
        confirmLabel="Archive collection"
        tone="danger"
        isLoading={archive.isPending}
      >
        It disappears from the storefront. No product is changed, and the membership is kept —
        restoring the collection restores the list.
      </ConfirmDialog>
    </div>
  )
}
