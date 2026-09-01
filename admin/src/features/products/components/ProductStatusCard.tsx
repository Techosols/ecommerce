import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Field'
import { Select } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import type { ProductStatus } from '../types/products.types'

export interface ProductStatusCardProps {
  status: ProductStatus
  disabled?: boolean
  isSaving?: boolean
  onChange: (status: ProductStatus) => void
}

/**
 * Lifecycle as a select, not as buttons.
 *
 * "Make active" / "Archive product" as two differently-coloured buttons in a
 * sidebar reads as two unrelated actions with unrelated consequences. A select
 * says what it actually is: one field with three values, whose current value is
 * visible without reading the buttons to work out which one is *not* offered.
 *
 * It saves on change rather than with the form. Status is not an edit to a
 * field — it is a transition the server validates on its own terms (a product
 * needs a live variant before it can go active), and folding it into Save would
 * mean a title change failing because a variant is missing.
 *
 * Archive is missing from the options deliberately: it unpublishes from every
 * channel, and a destructive transition should not be one keystroke away in a
 * dropdown. It lives in the header's More actions, behind a confirmation.
 */
export function ProductStatusCard({
  status,
  disabled = false,
  isSaving = false,
  onChange,
}: ProductStatusCardProps) {
  const archived = status === 'archived'

  return (
    <Card>
      <CardHeader
        title="Status"
        actions={isSaving ? <Spinner size="sm" label="Saving" /> : undefined}
      />
      <CardBody>
        {archived ? (
          <Field label="Status" hint="Restore it to draft before editing.">
            <Select value="archived" disabled options={[{ value: 'archived', label: 'Archived' }]} />
          </Field>
        ) : (
          <Field
            label="Status"
            hint={
              status === 'active'
                ? 'Visible wherever it is published.'
                : 'Hidden from every channel until it is active.'
            }
          >
            <Select
              value={status}
              disabled={disabled || isSaving}
              onChange={(event) => onChange(event.target.value as ProductStatus)}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'draft', label: 'Draft' },
              ]}
            />
          </Field>
        )}
      </CardBody>
    </Card>
  )
}
