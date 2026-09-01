import { useState } from 'react'
import { Minus, Plus, Search, Trash2, X } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { SearchInput } from '@/components/ui/SearchInput'
import { Spinner } from '@/components/ui/Spinner'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { formatMoney } from '@/lib/format'
import { useVariantSearch } from '../hooks/drafts.hooks'
import type { DraftDetail, DraftLineInput, VariantMatch } from '../types/drafts.types'

/**
 * The lines, and the search that adds to them.
 *
 * Every edit sends the whole list. The screen is holding it, and a diff
 * computed here against a copy that has gone stale is how a line quietly
 * disappears — so "add one" is "here is the list with one more on it".
 *
 * Prices are shown, never computed. Each line's total came from the server,
 * resolved against the catalogue on that request, which is why a line whose
 * product was archived this morning appears here marked unbuyable rather than
 * silently priced from a stale copy.
 */
export function DraftLinesCard({
  draft,
  onChange,
  isSaving,
  readOnly,
}: {
  draft: DraftDetail
  onChange: (lines: DraftLineInput[]) => void
  isSaving: boolean
  readOnly: boolean
}) {
  const [isAdding, setIsAdding] = useState(false)

  const current: DraftLineInput[] = draft.lines.map((line) => ({
    variantId: line.variantId,
    quantity: line.quantity,
  }))

  function setQuantity(variantId: string, quantity: number) {
    if (quantity < 1) return
    onChange(current.map((line) => (line.variantId === variantId ? { ...line, quantity } : line)))
  }

  function remove(variantId: string) {
    onChange(current.filter((line) => line.variantId !== variantId))
  }

  function add(match: VariantMatch) {
    const existing = current.find((line) => line.variantId === match.variantId)
    onChange(
      existing
        ? current.map((line) =>
            line.variantId === match.variantId ? { ...line, quantity: line.quantity + 1 } : line,
          )
        : [...current, { variantId: match.variantId, quantity: 1 }],
    )
    setIsAdding(false)
  }

  const unbuyable = draft.lines.filter((line) => !line.purchasable)

  return (
    <Card>
      <CardHeader
        title="What they are buying"
        description="Priced from the catalogue on every read, so a quote reopened tomorrow is worth what it would cost tomorrow."
        actions={
          readOnly ? null : isAdding ? (
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<X className="size-4" />}
              onClick={() => setIsAdding(false)}
            >
              Close
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              leadingIcon={<Plus className="size-4" />}
              onClick={() => setIsAdding(true)}
            >
              Add a product
            </Button>
          )
        }
      />

      <CardBody className="flex flex-col gap-4">
        {isAdding ? <VariantPicker onPick={add} /> : null}

        {unbuyable.length > 0 ? (
          <Alert tone="warning">
            {unbuyable.length === 1
              ? 'One line cannot be bought right now. It has to be fixed or removed before this can be placed.'
              : `${unbuyable.length} lines cannot be bought right now. They have to be fixed or removed before this can be placed.`}
          </Alert>
        ) : null}

        {draft.lines.length === 0 ? (
          <p className="text-muted py-6 text-center text-sm">
            Nothing on it yet. Add a product to start quoting.
          </p>
        ) : (
          <ul className="divide-line divide-y">
            {draft.lines.map((line) => (
              <li key={line.variantId} className="flex items-start gap-3 py-3 first:pt-0">
                <div className="min-w-0 flex-1">
                  <span className="text-ink block truncate text-sm font-medium">
                    {line.productTitle}
                  </span>
                  <span className="text-faint block truncate text-xs">
                    {[line.variantTitle, line.sku].filter(Boolean).join(' · ') || '—'}
                  </span>
                  {line.problem ? (
                    <span className="text-danger mt-1 block text-xs font-medium">
                      {line.problem}
                    </span>
                  ) : null}
                </div>

                {/* On a placed draft the quantity is a fact, not a control:
                    disabled steppers would be furniture for an action that no
                    longer exists. */}
                {readOnly ? (
                  <span className="text-muted tabular w-16 text-right text-sm">
                    × {line.quantity}
                  </span>
                ) : (
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      aria-label={`One fewer ${line.productTitle}`}
                      disabled={isSaving || line.quantity <= 1}
                      onClick={() => setQuantity(line.variantId, line.quantity - 1)}
                    >
                      <Minus className="size-3.5" />
                    </Button>
                    <span className="text-ink tabular w-8 text-center text-sm">
                      {line.quantity}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      aria-label={`One more ${line.productTitle}`}
                      disabled={isSaving}
                      onClick={() => setQuantity(line.variantId, line.quantity + 1)}
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  </div>
                )}

                <div className="w-24 shrink-0 text-right">
                  <span className="text-ink tabular block text-sm font-medium">
                    {formatMoney(line.lineTotal)}
                  </span>
                  <span className="text-faint tabular block text-xs">
                    {formatMoney(line.unitPrice)} each
                  </span>
                </div>

                {readOnly ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    aria-label={`Remove ${line.productTitle}`}
                    disabled={isSaving}
                    onClick={() => remove(line.variantId)}
                  >
                    <Trash2 className="text-danger size-3.5" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

/** Search the catalogue for something to put on the draft. */
function VariantPicker({ onPick }: { onPick: (match: VariantMatch) => void }) {
  const [term, setTerm] = useState('')
  const debounced = useDebouncedValue(term, 250)
  const query = useVariantSearch(debounced)
  const matches = query.data ?? []

  return (
    <div className="border-line bg-subtle flex flex-col gap-2 rounded-lg border p-3">
      <SearchInput
        size="sm"
        autoFocus
        aria-label="Search products"
        placeholder="Product name or SKU…"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        onClear={() => setTerm('')}
      />

      {debounced.trim().length === 0 ? (
        <p className="text-faint flex items-center gap-1.5 px-1 py-2 text-xs">
          <Search className="size-3.5" /> Type to search the catalogue.
        </p>
      ) : query.isFetching && matches.length === 0 ? (
        <div className="flex justify-center py-3">
          <Spinner size="sm" />
        </div>
      ) : matches.length === 0 ? (
        <p className="text-muted px-1 py-2 text-xs">
          Nothing matches. Only active, unarchived products can be sold.
        </p>
      ) : (
        <ul className="max-h-64 overflow-y-auto">
          {matches.map((match) => (
            <li key={match.variantId}>
              <button
                type="button"
                onClick={() => onPick(match)}
                className="hover:bg-raised focus-visible:ring-brand-500 flex w-full items-center gap-3 rounded-md px-2 py-2 text-left focus-visible:ring-2 focus-visible:outline-none"
              >
                <div className="min-w-0 flex-1">
                  <span className="text-ink block truncate text-sm">{match.productTitle}</span>
                  <span className="text-faint block truncate text-xs">
                    {[match.variantTitle, match.sku].filter(Boolean).join(' · ') || '—'}
                  </span>
                </div>
                <span className="text-muted tabular shrink-0 text-sm">
                  {formatMoney(match.price)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
