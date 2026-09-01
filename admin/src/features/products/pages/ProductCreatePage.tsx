import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { PageHeader } from '@/components/ui/PageHeader'
import { useToast } from '@/components/ui/toast.context'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { slugify, useFormState } from '@/lib/useFormState'
import { useStoreCurrency } from '@/features/settings'
import { ProductInfoCard, ProductOrganizationCard } from '../components/ProductDetailsFields'
import { ProductSeoCard } from '../components/ProductSeoCard'
import { emptyProductDetails, type ProductDetailsValues } from '../components/productDetails'
import { VariantBuilder } from '../components/VariantBuilder'
import {
  MAX_VARIANTS,
  combinationsOf,
  emptyVariantDraft,
  signatureOf,
  toVariantInputs,
  type OptionDraft,
  type VariantDraft,
} from '../components/variantDrafts'
import { useCreateProduct } from '../hooks/products.hooks'

/**
 * Creating a product.
 *
 * One request. `POST /admin/products` takes the product, its options and all of
 * its variants together and writes them in a single transaction, because a
 * product that committed without its variants is unbuyable and looks perfectly
 * healthy in a listing.
 *
 * Images are deliberately not here: `POST /products/:id/media` needs a product
 * id, so the product has to exist first. The operator lands on the edit page
 * afterwards, where the Images tab is waiting.
 */
export function ProductCreatePage() {
  const navigate = useNavigate()
  const { toast } = useToast()
  const currency = useStoreCurrency()
  const create = useCreateProduct()
  useDocumentTitle('New product')

  const form = useFormState<ProductDetailsValues>(emptyProductDetails())
  const [handleTouched, setHandleTouched] = useState(false)

  const [hasOptions, setHasOptions] = useState(false)
  const [options, setOptions] = useState<OptionDraft[]>([{ name: '', values: [] }])
  const [variants, setVariants] = useState<Record<string, VariantDraft>>({})
  const [single, setSingle] = useState<VariantDraft>(emptyVariantDraft())
  const [pricingError, setPricingError] = useState<string | undefined>(undefined)

  // The handle follows the title until somebody edits it, and then it stops —
  // silently rewriting a handle an operator chose would change a live URL.
  function handleTitleChange(title: string) {
    form.setValue('title', title)
    if (!handleTouched) form.setValue('handle', slugify(title))
  }

  function validate(): boolean {
    const errors: Partial<Record<keyof ProductDetailsValues, string>> = {}
    if (!form.values.title.trim()) errors.title = 'A product needs a title.'
    if (form.values.handle && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.values.handle)) {
      errors.handle = 'Lowercase letters, digits and single hyphens only.'
    }
    form.setErrors(errors)

    let pricing: string | undefined
    if (!hasOptions) {
      if (single.priceAmount === null) pricing = 'Give the product a price.'
    } else {
      const combinations = combinationsOf(options)
      if (combinations.length === 0) {
        pricing = 'Name at least one option and give it a value, or untick the variations box.'
      } else if (combinations.length > MAX_VARIANTS) {
        pricing = `That is ${combinations.length} variants; the limit is ${MAX_VARIANTS}.`
      } else if (
        combinations.some((selection) => variants[signatureOf(selection)]?.priceAmount == null)
      ) {
        pricing = 'Every variant needs a price.'
      }
    }
    setPricingError(pricing)

    return Object.keys(errors).length === 0 && !pricing
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (create.isPending) return
    if (!validate()) return

    const { options: optionInputs, variants: variantInputs } = toVariantInputs(
      hasOptions,
      options,
      variants,
      single,
    )
    const values = form.values

    try {
      const product = await create.mutateAsync({
        title: values.title.trim(),
        ...(values.handle.trim() ? { handle: values.handle.trim() } : {}),
        ...(values.subtitle.trim() ? { subtitle: values.subtitle.trim() } : {}),
        ...(values.description.trim() ? { description: values.description } : {}),
        ...(values.categoryId ? { categoryId: values.categoryId } : {}),
        ...(values.productType.trim() ? { productType: values.productType.trim() } : {}),
        ...(values.vendor.trim() ? { vendor: values.vendor.trim() } : {}),
        ...(values.tags.length > 0 ? { tags: values.tags } : {}),
        ...(values.seoTitle.trim() ? { seoTitle: values.seoTitle.trim() } : {}),
        ...(values.seoDescription.trim()
          ? { seoDescription: values.seoDescription.trim() }
          : {}),
        ...(optionInputs.length > 0 ? { options: optionInputs } : {}),
        variants: variantInputs,
      })

      toast({
        tone: 'success',
        title: `${product.title} created`,
        description: 'It is a draft until you activate and publish it.',
      })
      void navigate(`/products/${product.id}`, { replace: true })
    } catch (error) {
      // Field messages land beside their inputs; anything else becomes the
      // banner at the top of the form.
      form.applyServerError(error, 'The product could not be created.')
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-6">
      <PageHeader
        title="Add product"
        backTo="/products"
        backLabel="All products"
        description="It starts as a draft — nothing is visible to customers until you publish it."
        actions={
          <Button type="submit" variant="primary" isLoading={create.isPending}>
            Save
          </Button>
        }
      />

      {form.formError ? <Alert tone="danger">{form.formError}</Alert> : null}

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <ProductInfoCard
            form={form}
            disabled={create.isPending}
            handleHint="Left blank, the server derives one from the title."
            onTitleChange={handleTitleChange}
            onHandleChange={(handle) => {
              setHandleTouched(true)
              form.setValue('handle', handle)
            }}
          />

          <VariantBuilder
            currency={currency}
            hasOptions={hasOptions}
            onHasOptionsChange={setHasOptions}
            options={options}
            onOptionsChange={setOptions}
            variants={variants}
            onVariantsChange={setVariants}
            single={single}
            onSingleChange={setSingle}
            disabled={create.isPending}
            error={pricingError}
          />
        </div>

        <div className="flex flex-col gap-4">
          {/* No Status card here: a new product is always created as a draft,
              and a select offering "Active" would be a control whose value the
              server ignores. It is on the product page, a moment later. */}
          <ProductOrganizationCard form={form} disabled={create.isPending} />
          <ProductSeoCard form={form} disabled={create.isPending} />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button
          disabled={create.isPending}
          onClick={() => void navigate('/products')}
        >
          Cancel
        </Button>
        <Button type="submit" variant="primary" isLoading={create.isPending}>
          Save
        </Button>
      </div>
    </form>
  )
}
