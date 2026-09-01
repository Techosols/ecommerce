import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import type { FormState } from '@/lib/useFormState'
import type { ProductDetailsValues } from './productDetails'

/** The store's public origin, for the preview line. Cosmetic only. */
const STOREFRONT_ORIGIN = 'https://your-store.example'

export interface ProductSeoCardProps {
  form: FormState<ProductDetailsValues>
  disabled?: boolean
}

/**
 * How the product looks in a search result.
 *
 * The preview is the point. Two text fields labelled "SEO title" and "meta
 * description" are fields nobody fills in; the same two fields under a mock
 * search result are a page somebody wants to make look right.
 *
 * It shows the *fallbacks* when the fields are empty — the storefront serves
 * `seoTitle ?? title` and `seoDescription ?? subtitle`, so an empty form here
 * does not mean an empty search result, and a preview that went blank would say
 * something untrue.
 *
 * The 60/160 character marks are Google's rough truncation points. They are
 * guidance, not validation: the server accepts 200 and 400, and a merchant who
 * wants a longer title is not wrong, just likely to be cut off.
 */
export function ProductSeoCard({ form, disabled = false }: ProductSeoCardProps) {
  const { values, errors, setValue } = form
  const [editing, setEditing] = useState(false)

  const title = values.seoTitle.trim() || values.title.trim() || 'Untitled product'
  const description = values.seoDescription.trim() || values.subtitle.trim()
  const url = `${STOREFRONT_ORIGIN}/products/${values.handle.trim() || 'product-handle'}`

  return (
    <Card>
      <CardHeader
        title="Search engine listing"
        actions={
          <Button size="sm" onClick={() => setEditing((current) => !current)}>
            {editing ? 'Done' : 'Edit'}
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-4">
        {/* Deliberately styled like a result rather than like the rest of the
            admin: it is a picture of somewhere else. */}
        <div className="flex flex-col gap-0.5">
          <p className="text-xs text-[#4d5156] dark:text-neutral-400">{url}</p>
          <p className="truncate text-lg leading-snug text-[#1a0dab] dark:text-[#8ab4f8]">
            {title}
          </p>
          {description ? (
            <p className="line-clamp-2 text-xs text-[#4d5156] dark:text-neutral-400">
              {description}
            </p>
          ) : (
            <p className="text-faint text-xs italic">
              Add a description and search engines will show it here.
            </p>
          )}
        </div>

        {editing ? (
          <div className="border-line flex flex-col gap-4 border-t pt-4">
            <Field
              label="Page title"
              error={errors.seoTitle}
              hint={`${values.seoTitle.length} of 60 characters used. Empty falls back to the product title.`}
            >
              <Input
                value={values.seoTitle}
                maxLength={200}
                disabled={disabled}
                onChange={(event) => setValue('seoTitle', event.target.value)}
              />
            </Field>

            <Field
              label="Meta description"
              error={errors.seoDescription}
              hint={`${values.seoDescription.length} of 160 characters used. Empty falls back to the subtitle.`}
            >
              <Textarea
                rows={3}
                value={values.seoDescription}
                maxLength={400}
                disabled={disabled}
                onChange={(event) => setValue('seoDescription', event.target.value)}
              />
            </Field>

            <Field
              label="URL handle"
              error={errors.handle}
              hint="The address on the storefront. Changing it keeps the old one working."
            >
              <Input
                value={values.handle}
                maxLength={120}
                disabled={disabled}
                onChange={(event) => setValue('handle', event.target.value)}
              />
            </Field>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}
