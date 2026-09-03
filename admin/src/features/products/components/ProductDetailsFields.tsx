import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { TagsInput } from '@/components/ui/TagsInput'
import { RichTextEditor } from '@/components/editor/RichTextEditor'
import { useCategoryTree } from '@/features/categories/hooks/categories.hooks'
import type { FormState } from '@/lib/useFormState'
import type { ProductDetailsValues } from './productDetails'

export type { ProductDetailsValues }

/**
 * Everything a product carries that is not a price.
 *
 * Split into two cards because the page puts them in two different columns:
 * what the product *is* reads down the middle, and how it is *filed* sits in
 * the sidebar beside status. The field set is taken from `createProductSchema`
 * and `updateProductSchema` — every input here maps to a field the server
 * accepts, and nothing the server does not accept is offered. `maxLength` on
 * each input mirrors the schema's limit, so a field cannot compose a request
 * that would come back a 422.
 */
export interface ProductFieldsProps {
  form: FormState<ProductDetailsValues>
  disabled?: boolean
}

export interface ProductInfoCardProps extends ProductFieldsProps {
  /** Shown under the handle on create, where it is still auto-derived. */
  handleHint?: string
  /** Lets the create page derive the handle from the title as it is typed. */
  onTitleChange?: (title: string) => void
  /** Lets the create page notice the handle was chosen by hand and stop deriving. */
  onHandleChange?: (handle: string) => void
}

export function ProductInfoCard({
  form,
  disabled = false,
  handleHint,
  onTitleChange,
  onHandleChange,
}: ProductInfoCardProps) {
  const { values, errors, setValue } = form

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <Field label="Title" error={errors.title} required>
          <Input
            value={values.title}
            maxLength={200}
            disabled={disabled}
            placeholder="Short sleeve t-shirt"
            onChange={(event) =>
              onTitleChange
                ? onTitleChange(event.target.value)
                : setValue('title', event.target.value)
            }
          />
        </Field>

        <Field label="Subtitle" error={errors.subtitle} hint="One line under the title.">
          <Input
            value={values.subtitle}
            maxLength={300}
            disabled={disabled}
            onChange={(event) => setValue('subtitle', event.target.value)}
          />
        </Field>

        <Field label="Description" error={errors.description}>
          {/* HTML in and out, so the column and the API contract are unchanged
              — a textarea was already storing whatever was typed. What is new
              is that the server now sanitises it, because this is rendered as
              markup on the storefront rather than escaped. */}
          <RichTextEditor
            value={values.description}
            disabled={disabled}
            aria-label="Description"
            minHeight="16rem"
            placeholder="What it is, what it is made of, why someone would want it."
            onChange={(html) => setValue('description', html)}
          />
        </Field>

        {/* On the create page only. Once a product exists the handle lives in
            the search-engine card, which is where somebody thinks about a URL —
            and where the consequence of changing one is explained. */}
        {onHandleChange ? (
          <Field
            label="Handle"
            error={errors.handle}
            hint={handleHint ?? 'The URL segment on the storefront. Lowercase, hyphenated.'}
          >
            <Input
              value={values.handle}
              maxLength={120}
              disabled={disabled}
              placeholder="short-sleeve-t-shirt"
              onChange={(event) => onHandleChange(event.target.value)}
            />
          </Field>
        ) : null}
      </CardBody>
    </Card>
  )
}

export function ProductOrganizationCard({ form, disabled = false }: ProductFieldsProps) {
  const { flat, isPending: categoriesLoading } = useCategoryTree()
  const { values, errors, setValue } = form

  return (
    <Card>
      <CardHeader title="Product organization" />
      <CardBody className="flex flex-col gap-4">
        <Field label="Category" error={errors.categoryId}>
          <Select
            value={values.categoryId}
            disabled={disabled || categoriesLoading}
            onChange={(event) => setValue('categoryId', event.target.value)}
            options={[
              { value: '', label: 'No category' },
              ...flat.map((category) => ({
                value: category.id,
                // Two spaces per level: a child reads as a child in a native
                // select, which cannot nest option groups arbitrarily.
                label: `${'  '.repeat(category.depth)}${category.name}`,
                disabled: !category.isActive,
              })),
            ]}
          />
        </Field>

        <Field label="Product type" error={errors.productType} hint="Free text, e.g. “Jacket”.">
          <Input
            value={values.productType}
            maxLength={80}
            disabled={disabled}
            onChange={(event) => setValue('productType', event.target.value)}
          />
        </Field>

        <Field label="Vendor" error={errors.vendor}>
          <Input
            value={values.vendor}
            maxLength={120}
            disabled={disabled}
            onChange={(event) => setValue('vendor', event.target.value)}
          />
        </Field>

        <Field label="Tags" error={errors.tags}>
          <TagsInput
            value={values.tags}
            disabled={disabled}
            onChange={(tags) => setValue('tags', tags)}
          />
        </Field>
      </CardBody>
    </Card>
  )
}
