import { useEffect, useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/components/ui/PageHeader'
import { Switch } from '@/components/ui/Switch'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { useFormState } from '@/lib/useFormState'
import { CollectionProductsCard } from '../components/CollectionProductsCard'
import { SmartRulesCard } from '../components/SmartRulesCard'
import { useCollection, useUpdateCollection } from '../hooks/collections.hooks'
import type { CollectionDetail } from '../types/collections.types'

interface DetailValues extends Record<string, unknown> {
  title: string
  handle: string
  description: string
  isActive: boolean
  seoTitle: string
  seoDescription: string
}

function toValues(collection: CollectionDetail): DetailValues {
  return {
    title: collection.title,
    handle: collection.handle,
    description: collection.description ?? '',
    isActive: collection.isActive,
    seoTitle: collection.seo.title ?? '',
    seoDescription: collection.seo.description ?? '',
  }
}

/**
 * One collection.
 *
 * The page is the same for both kinds except for the middle card, and that is
 * the whole design: a merchant should not have to learn two screens to manage
 * "where products appear". A manual collection gets a list it can arrange; a
 * smart one gets rules and a live count. Neither ever shows the other's
 * controls, because adding a product by hand to a smart collection is not a
 * thing that can be true.
 */
export function CollectionDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { can } = useAuth()

  const query = useCollection(id)
  const collection = query.data

  useDocumentTitle(collection ? collection.title : 'Collection')

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link
          to="/collections"
          className="text-muted hover:text-ink inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-3.5" /> Collections
        </Link>
      </div>

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {collection ? (
          <CollectionDetailView collection={collection} canWrite={can('catalog:write')} />
        ) : null}
      </QueryBoundary>
    </div>
  )
}

function CollectionDetailView({
  collection,
  canWrite,
}: {
  collection: CollectionDetail
  canWrite: boolean
}) {
  const { toast } = useToast()
  const update = useUpdateCollection(collection.id)

  const form = useFormState<DetailValues>(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useMemo(() => toValues(collection), []),
  )

  // Re-baseline when the record is refetched, but never over an unsaved edit.
  useEffect(() => {
    if (!form.isDirty) form.reset(toValues(collection))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection.id, collection.updatedAt])

  function save() {
    if (update.isPending || !form.isDirty) return
    const blank = (value: string) => (value.trim() === '' ? null : value.trim())

    update.mutate(
      {
        title: form.values.title.trim(),
        handle: form.values.handle.trim(),
        description: blank(form.values.description),
        isActive: form.values.isActive,
        seoTitle: blank(form.values.seoTitle),
        seoDescription: blank(form.values.seoDescription),
      },
      {
        onSuccess: (saved) => {
          toast({ tone: 'success', title: 'Collection updated' })
          form.reset(toValues({ ...collection, ...saved }))
        },
        onError: (error) =>
          toast({ tone: 'error', title: 'Could not save', description: messageOf(error) }),
      },
    )
  }

  return (
    <>
      <PageHeader
        title={collection.title}
        backTo="/collections"
        backLabel="All collections"
        badges={
          <>
            {collection.type === 'dynamic' ? (
              <Badge tone="brand">
                <Sparkles className="mr-1 size-3" />
                Smart
              </Badge>
            ) : (
              <Badge>Manual</Badge>
            )}
            {!collection.isActive ? <Badge tone="warning">Hidden</Badge> : null}
          </>
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {collection.type === 'dynamic' ? (
            <SmartRulesCard
              collectionId={collection.id}
              rules={collection.rules}
              canWrite={canWrite}
            />
          ) : (
            <CollectionProductsCard
              collectionId={collection.id}
              productIds={collection.productIds}
              canWrite={canWrite}
            />
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody className="flex flex-col gap-4">
              <Field label="Title">
                <Input
                  value={form.values.title}
                  disabled={!canWrite}
                  onChange={(event) => form.setValue('title', event.target.value)}
                />
              </Field>

              <Field label="Handle" hint="Its address on the storefront.">
                <Input
                  value={form.values.handle}
                  disabled={!canWrite}
                  onChange={(event) => form.setValue('handle', event.target.value)}
                />
              </Field>

              <Field label="Description">
                <Textarea
                  rows={3}
                  maxLength={2000}
                  value={form.values.description}
                  disabled={!canWrite}
                  onChange={(event) => form.setValue('description', event.target.value)}
                />
              </Field>

              <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
                <div>
                  <p className="text-ink text-sm font-medium">Visible</p>
                  <p className="text-muted mt-0.5 text-xs">
                    Switching this off hides the collection without archiving it.
                  </p>
                </div>
                <Switch
                  checked={form.values.isActive}
                  disabled={!canWrite}
                  label="Visible"
                  onCheckedChange={(checked) => form.setValue('isActive', checked)}
                />
              </div>
            </CardBody>

            {canWrite && form.isDirty ? (
              <CardFooter className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => form.reset(toValues(collection))}>
                  Discard
                </Button>
                <Button isLoading={update.isPending} onClick={save}>
                  Save changes
                </Button>
              </CardFooter>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="Search engine listing" />
            <CardBody className="flex flex-col gap-4">
              <Field label="Page title">
                <Input
                  value={form.values.seoTitle}
                  disabled={!canWrite}
                  placeholder={collection.title}
                  onChange={(event) => form.setValue('seoTitle', event.target.value)}
                />
              </Field>
              <Field label="Description">
                <Textarea
                  rows={2}
                  maxLength={400}
                  value={form.values.seoDescription}
                  disabled={!canWrite}
                  onChange={(event) => form.setValue('seoDescription', event.target.value)}
                />
              </Field>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  )
}
