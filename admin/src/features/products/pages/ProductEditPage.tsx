import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArchiveRestore, ExternalLink, MoreHorizontal, Package, Undo2 } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { DropdownItem, DropdownMenu } from '@/components/ui/DropdownMenu'
import { PageHeader } from '@/components/ui/PageHeader'
import { SaveBar } from '@/components/ui/SaveBar'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useStoreCurrency } from '@/features/settings'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { formatDateTime } from '@/lib/format'
import { useFormState } from '@/lib/useFormState'
import { ProductInfoCard, ProductOrganizationCard } from '../components/ProductDetailsFields'
import { ProductCollectionsCard } from '@/features/collections/components/ProductCollectionsCard'
import { emptyProductDetails, type ProductDetailsValues } from '../components/productDetails'
import { ProductMediaManager } from '../components/ProductMediaManager'
import { ProductOptionsCard } from '../components/ProductOptionsCard'
import { ProductStatusBadge, PublicationBadge } from '../components/ProductStatusBadge'
import { ProductStatusCard } from '../components/ProductStatusCard'
import { ProductSeoCard } from '../components/ProductSeoCard'
import {
  ProductIdentifiersCard,
  ProductInventoryCard,
  ProductPricingCard,
  ProductShippingCard,
} from '../components/SingleVariantCards'
import { VariantsCard } from '../components/VariantsCard'
import {
  toVariantFormValues,
  toVariantPatch,
  type VariantFormValues,
} from '../components/variantForm'
import {
  useProduct,
  useProductLifecycle,
  useProductPublication,
  useUpdateProduct,
  useUpdateVariant,
  type ProductLifecycleAction,
} from '../hooks/products.hooks'
import type { ProductDetail, ProductVariant, UpdateProductInput } from '../types/products.types'

function toFormValues(product: ProductDetail): ProductDetailsValues {
  return {
    title: product.title,
    handle: product.handle,
    subtitle: product.subtitle ?? '',
    description: product.description ?? '',
    categoryId: product.category?.id ?? '',
    productType: product.productType ?? '',
    vendor: product.vendor ?? '',
    tags: product.tags,
    seoTitle: product.seo?.title ?? '',
    seoDescription: product.seo?.description ?? '',
  }
}

/**
 * Turns the form's dirty keys into the PATCH body the server accepts.
 *
 * Two conversions matter. The form holds `''` for every optional text field
 * because an input cannot hold `null`; the API distinguishes them, and `null`
 * is what clears a value. And `categoryId` is a uuid or `null`, never `''`.
 */
function toPatch(dirty: Partial<ProductDetailsValues>): UpdateProductInput {
  const patch: UpdateProductInput = {}
  const blankToNull = (value: string) => (value.trim() === '' ? null : value.trim())

  if (dirty.title !== undefined) patch.title = dirty.title.trim()
  if (dirty.handle !== undefined) patch.handle = dirty.handle.trim()
  if (dirty.subtitle !== undefined) patch.subtitle = blankToNull(dirty.subtitle)
  // Description keeps its whitespace: it is prose, and trimming an author's
  // deliberate blank line is not the form's decision to make.
  if (dirty.description !== undefined) {
    patch.description = dirty.description.trim() === '' ? null : dirty.description
  }
  if (dirty.categoryId !== undefined) patch.categoryId = dirty.categoryId || null
  if (dirty.productType !== undefined) patch.productType = blankToNull(dirty.productType)
  if (dirty.vendor !== undefined) patch.vendor = blankToNull(dirty.vendor)
  if (dirty.tags !== undefined) patch.tags = dirty.tags
  if (dirty.seoTitle !== undefined) patch.seoTitle = blankToNull(dirty.seoTitle)
  if (dirty.seoDescription !== undefined) {
    patch.seoDescription = blankToNull(dirty.seoDescription)
  }
  return patch
}

/**
 * The product with no options has exactly one variant, and the page edits it
 * inline. The server's `variant_combination_is_unique` on the empty signature is
 * what makes "exactly one" true rather than merely usual.
 */
function soleVariantOf(product: ProductDetail): ProductVariant | undefined {
  if (product.options.length > 0) return undefined
  return product.variants.find((variant) => !variant.isArchived) ?? product.variants[0]
}

/** A blank variant baseline, for the render before the product has loaded. */
const emptyVariantValues: VariantFormValues = {
  title: '',
  priceAmount: null,
  compareAtAmount: null,
  sku: '',
  barcode: '',
  weightGrams: '0',
  requiresShipping: true,
  isActive: true,
  mediaId: '',
}

/**
 * Editing one product, on one page.
 *
 * Laid out the way a merchandiser reads it rather than the way the API is
 * partitioned: what the product *is* runs down the middle — title, images,
 * price or variants — and how it is *filed and published* sits in the sidebar.
 *
 * One Save, two requests at most. The product row and its variant are separate
 * resources with separate endpoints, and a product with no options has exactly
 * one variant whose price is, to everyone but the database, the product's price.
 * So the button sends `PATCH /products/:id` and `PATCH /variants/:id` — each
 * carrying only its own dirty fields, neither sent when nothing in it changed.
 *
 * Three things stay outside that Save on purpose, because each is a decision
 * rather than a field: lifecycle (activate, archive, restore) and publication
 * are separate server transitions with their own audit entries; stock moves
 * through the inventory ledger with a reason attached; and images commit as
 * they are uploaded, since the upload has already happened by then.
 */
export function ProductEditPage() {
  const { id } = useParams<{ id: string }>()
  const { toast } = useToast()
  const { can } = useAuth()
  const currency = useStoreCurrency()

  const query = useProduct(id)
  const product = query.data
  const update = useUpdateProduct(id ?? '')
  const updateVariant = useUpdateVariant()
  const lifecycle = useProductLifecycle()
  const publication = useProductPublication()

  const [confirming, setConfirming] = useState<ProductLifecycleAction | null>(null)

  const canWrite = can('catalog:write')
  const canPublish = can('catalog:publish')
  const isArchived = product?.status === 'archived'
  const saving = update.isPending || updateVariant.isPending
  // The server refuses to edit an archived product, so the form is read-only
  // until it is restored rather than failing on save.
  const formDisabled = !canWrite || isArchived || saving

  useDocumentTitle(product?.title ?? 'Product')

  const form = useFormState<ProductDetailsValues>(
    useMemo(
      () => (product ? toFormValues(product) : emptyProductDetails()),
      // Only the first product matters here; later syncing is the effect below.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    ),
  )

  const sole = product ? soleVariantOf(product) : undefined
  const variantForm = useFormState<VariantFormValues>(
    useMemo(
      () => (sole ? toVariantFormValues(sole) : emptyVariantValues),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    ),
  )

  // Re-baseline when the product arrives or is refetched, but never while the
  // operator has unsaved edits — a background refetch must not wipe their work.
  const updatedAt = product?.updatedAt
  useEffect(() => {
    if (!product) return
    if (!form.isDirty) form.reset(toFormValues(product))
    const variant = soleVariantOf(product)
    if (variant && !variantForm.isDirty) variantForm.reset(toVariantFormValues(variant))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatedAt, product?.id, sole?.updatedAt])

  const isDirty = form.isDirty || variantForm.isDirty

  async function handleSave(event: FormEvent) {
    event.preventDefault()
    if (saving || !isDirty) return

    if (!form.values.title.trim()) {
      form.setErrors({ title: 'A product needs a title.' })
      return
    }
    if (sole && variantForm.values.priceAmount === null) {
      variantForm.setErrors({ priceAmount: 'A product needs a price.' })
      return
    }

    // The product row first. If the variant PATCH then fails, the operator sees
    // exactly which half did not land rather than a single opaque failure.
    if (form.isDirty) {
      try {
        const saved = await update.mutateAsync(toPatch(form.dirty))
        form.reset(toFormValues(saved))
      } catch (error) {
        form.applyServerError(error, 'The product could not be saved.')
        return
      }
    }

    if (sole && variantForm.isDirty) {
      const patch = toVariantPatch(variantForm.dirty)
      if (Object.keys(patch).length > 0) {
        try {
          const saved = await updateVariant.mutateAsync({ variantId: sole.id, patch })
          variantForm.reset(toVariantFormValues(saved))
        } catch (error) {
          variantForm.applyServerError(error, 'The price could not be saved.')
          return
        }
      } else {
        variantForm.reset(variantForm.values)
      }
    }

    toast({ tone: 'success', title: 'Product saved' })
  }

  function runLifecycle(action: ProductLifecycleAction) {
    if (!id) return
    lifecycle.mutate(
      { id, action },
      {
        onSuccess: (saved) => {
          setConfirming(null)
          form.reset(toFormValues(saved))
          toast({
            tone: 'success',
            title:
              action === 'archive'
                ? 'Product archived'
                : action === 'activate'
                  ? 'Product is now active'
                  : 'Product restored to draft',
          })
        },
        onError: (error) => {
          setConfirming(null)
          toast({ tone: 'error', title: 'That did not work', description: messageOf(error) })
        },
      },
    )
  }

  function togglePublication(publish: boolean) {
    if (!id) return
    publication.mutate(
      { id, publish },
      {
        onSuccess: () =>
          toast({
            tone: 'success',
            title: publish ? 'Published to the storefront' : 'Unpublished',
          }),
        onError: (error) =>
          toast({
            tone: 'error',
            title: publish ? 'Could not publish' : 'Could not unpublish',
            description: messageOf(error),
          }),
      },
    )
  }

  return (
    <QueryBoundary
      isLoading={query.isPending}
      error={query.error}
      variant="page"
      onRetry={() => void query.refetch()}
    >
      {product ? (
        <div className="flex flex-col gap-4">
          {/* Over the top bar, only once something has been typed. Save lives
              here rather than in the page header, so the page never shows a
              Save button that has nothing to save. */}
          {canWrite && !isArchived ? (
            <SaveBar
              isDirty={isDirty}
              isSaving={saving}
              form="product-form"
              onDiscard={() => {
                form.reset(toFormValues(product))
                const variant = soleVariantOf(product)
                if (variant) variantForm.reset(toVariantFormValues(variant))
              }}
              onSave={() => undefined}
            />
          ) : null}

          <PageHeader
            title={product.title}
            backTo="/products"
            backLabel="All products"
            badges={
              <>
                <ProductStatusBadge status={product.status} />
                <PublicationBadge channels={product.publications.map((entry) => entry.channel)} />
              </>
            }
            actions={
              canWrite && !isArchived ? (
                <DropdownMenu
                  align="end"
                  trigger={(props) => (
                    <Button size="md" iconOnly aria-label="More actions" {...props}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  )}
                >
                  {canPublish && product.status === 'active' ? (
                    product.publications.length === 0 ? (
                      <DropdownItem
                        icon={<ExternalLink className="size-4" />}
                        onSelect={() => togglePublication(true)}
                      >
                        Publish to storefront
                      </DropdownItem>
                    ) : (
                      <DropdownItem onSelect={() => togglePublication(false)}>
                        Unpublish
                      </DropdownItem>
                    )
                  ) : null}
                  <DropdownItem
                    tone="danger"
                    icon={<ArchiveRestore className="size-4" />}
                    onSelect={() => setConfirming('archive')}
                  >
                    Archive product
                  </DropdownItem>
                </DropdownMenu>
              ) : undefined
            }
          />

          {isArchived ? (
            <Alert
              tone="warning"
              title="This product is archived"
              actions={
                canWrite ? (
                  <Button
                    size="sm"
                    leadingIcon={<Undo2 className="size-4" />}
                    isLoading={lifecycle.isPending}
                    onClick={() => runLifecycle('restore')}
                  >
                    Restore to draft
                  </Button>
                ) : undefined
              }
            >
              It is hidden from every channel and cannot be edited. Restoring returns it to draft —
              republishing is a separate decision.
            </Alert>
          ) : null}

          {/*
            Shopify's card order, and it is an order rather than a list: what
            the thing *is*, what it looks like, what it costs, how many there
            are, how it ships, how it varies, and how it is found. Somebody
            filling this in top to bottom is answering those questions in the
            order they can answer them.
          */}
          <form
            id="product-form"
            onSubmit={(event) => void handleSave(event)}
            noValidate
            className="grid items-start gap-4 lg:grid-cols-3"
          >
            <div className="flex flex-col gap-4 lg:col-span-2">
              {form.formError ? <Alert tone="danger">{form.formError}</Alert> : null}
              {variantForm.formError ? <Alert tone="danger">{variantForm.formError}</Alert> : null}

              <ProductInfoCard form={form} disabled={formDisabled} />

              <ProductMediaManager
                productId={product.id}
                media={product.media}
                canEdit={canWrite && !isArchived}
              />

              {sole ? (
                <>
                  <ProductPricingCard
                    form={variantForm}
                    currency={currency || (sole.price?.currency ?? '')}
                    disabled={formDisabled}
                  />
                  <ProductInventoryCard variantId={sole.id} disabled={isArchived} />
                  <ProductIdentifiersCard form={variantForm} disabled={formDisabled} />
                  <ProductShippingCard form={variantForm} disabled={formDisabled} />
                </>
              ) : null}

              <ProductOptionsCard
                productId={product.id}
                options={product.options}
                variants={product.variants}
                canEdit={canWrite && !isArchived}
              />

              {product.options.length > 0 ? (
                <VariantsCard
                  productId={product.id}
                  options={product.options}
                  variants={product.variants}
                  media={product.media}
                  currency={currency || (product.variants[0]?.price?.currency ?? '')}
                  canEdit={canWrite && !isArchived}
                />
              ) : null}

              <ProductSeoCard form={form} disabled={formDisabled} />
            </div>

            <div className="flex flex-col gap-4">
              {/* Saves on change, not with the form: a status transition is
                  validated on its own terms — a product needs a live variant
                  before it can go active — and folding it into Save would mean
                  a title edit failing because a variant is missing. */}
              <ProductStatusCard
                status={product.status}
                disabled={!canWrite}
                isSaving={lifecycle.isPending}
                onChange={(next) => runLifecycle(next === 'active' ? 'activate' : 'restore')}
              />

              <Card>
                <CardHeader title="Publishing" />
                <CardBody className="flex flex-col gap-3">
                  <dl className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted">Sales channels</dt>
                      <dd>
                        <PublicationBadge
                          channels={product.publications.map((entry) => entry.channel)}
                        />
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted">Created</dt>
                      <dd className="text-ink-soft text-xs">{formatDateTime(product.createdAt)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted">Updated</dt>
                      <dd className="text-ink-soft text-xs">{formatDateTime(product.updatedAt)}</dd>
                    </div>
                  </dl>

                  {canPublish && canWrite && !isArchived && product.status === 'active' ? (
                    product.publications.length === 0 ? (
                      <Button
                        fullWidth
                        leadingIcon={<ExternalLink className="size-4" />}
                        isLoading={publication.isPending}
                        onClick={() => togglePublication(true)}
                      >
                        Publish to storefront
                      </Button>
                    ) : (
                      <Button
                        fullWidth
                        isLoading={publication.isPending}
                        onClick={() => togglePublication(false)}
                      >
                        Unpublish
                      </Button>
                    )
                  ) : null}

                  {!canPublish && product.status === 'active' ? (
                    <p className="text-muted text-xs">
                      Publishing needs the <code>catalog:publish</code> permission.
                    </p>
                  ) : null}

                  {product.status === 'draft' ? (
                    <p className="text-muted text-xs">
                      A draft cannot be published. Set the status to Active first.
                    </p>
                  ) : null}
                </CardBody>
              </Card>

              <ProductOrganizationCard form={form} disabled={formDisabled} />

              {/* Outside the form: collection membership saves on its own, not
                  with the product's fields, because adding to a collection is a
                  different operation from editing a title. */}
              <ProductCollectionsCard productId={product.id} canWrite={canWrite} />
            </div>
          </form>

          <ConfirmDialog
            isOpen={confirming === 'archive'}
            onCancel={() => setConfirming(null)}
            onConfirm={() => runLifecycle('archive')}
            title={`Archive “${product.title}”?`}
            confirmLabel="Archive product"
            tone="danger"
            isLoading={lifecycle.isPending}
          >
            It is unpublished from every channel and hidden from the storefront. Nothing is deleted
            — orders that reference it keep working, and you can restore it to draft at any time.
          </ConfirmDialog>
        </div>
      ) : (
        <Card>
          <CardBody>
            <p className="text-muted text-sm">
              <Package className="mr-2 inline size-4" />
              That product could not be found.{' '}
              <Link to="/products" className="text-brand-600">
                Back to products
              </Link>
            </p>
          </CardBody>
        </Card>
      )}
    </QueryBoundary>
  )
}
