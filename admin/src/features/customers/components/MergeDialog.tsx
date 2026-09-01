import { useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { SearchInput } from '@/components/ui/SearchInput'
import { useToast } from '@/components/ui/toast.context'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { messageOf } from '@/lib/api/errors'
import { formatMoney } from '@/lib/format'
import { useCustomers, useMergeCustomers } from '../hooks/customers.hooks'
import { customerName } from './customerLabels'
import type { CustomerSummary } from '../types/customers.types'

export interface MergeDialogProps {
  survivor: CustomerSummary
  isOpen: boolean
  onClose: () => void
}

/**
 * Folding a duplicate record into this one.
 *
 * The only destructive operation in the customer surface, so it is deliberately
 * two steps: find the duplicate, then confirm what will happen to it in a
 * sentence naming the record that disappears. There is no one-click merge from
 * a list row.
 *
 * The wording is careful about the figures. The survivor's lifetime totals are
 * **recomputed from the orders**, not added together — adding would double
 * anything already counted on both sides, with no way to tell afterwards.
 */
export function MergeDialog({ survivor, isOpen, onClose }: MergeDialogProps) {
  const { toast } = useToast()
  const merge = useMergeCustomers(survivor.id)

  const [search, setSearch] = useState('')
  const [chosen, setChosen] = useState<CustomerSummary | null>(null)
  const debounced = useDebouncedValue(search, 300)

  const candidates = useCustomers({
    page: 1,
    limit: 5,
    ...(debounced ? { q: debounced } : {}),
  })

  const results = (candidates.data?.items ?? []).filter((row) => row.id !== survivor.id)

  function close() {
    setSearch('')
    setChosen(null)
    onClose()
  }

  function submit() {
    if (!chosen || merge.isPending) return
    merge.mutate(chosen.id, {
      onSuccess: () => {
        toast({
          tone: 'success',
          title: 'Customers merged',
          description: `${chosen.email} was folded into this record.`,
        })
        close()
      },
      onError: (error) =>
        toast({ tone: 'error', title: 'Could not merge', description: messageOf(error) }),
    })
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title="Merge a duplicate"
      description={`Orders, addresses and history move to ${survivor.email}.`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!chosen}
            isLoading={merge.isPending}
            onClick={submit}
          >
            Merge and delete
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Duplicate record" hint="Search by name, email or phone.">
          <SearchInput
            aria-label="Search for the duplicate customer"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setChosen(null)
            }}
            onClear={() => {
              setSearch('')
              setChosen(null)
            }}
          />
        </Field>

        {debounced && results.length > 0 ? (
          <ul className="border-line divide-line max-h-60 divide-y overflow-y-auto rounded-md border">
            {results.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setChosen(row)}
                  aria-pressed={chosen?.id === row.id}
                  className={`hover:bg-surface-hover flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ${
                    chosen?.id === row.id ? 'bg-brand-50 dark:bg-brand-950' : ''
                  }`}
                >
                  <span className="min-w-0">
                    <span className="text-ink block truncate font-medium">
                      {customerName(row)}
                    </span>
                    <span className="text-faint block truncate text-xs">{row.email}</span>
                  </span>
                  <span className="text-muted tabular shrink-0 text-xs">
                    {row.ordersCount} orders · {formatMoney(row.totalSpent)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : debounced && !candidates.isFetching ? (
          <p className="text-muted text-sm">No other customer matches that.</p>
        ) : null}

        {chosen ? (
          <Alert tone="danger" title="This cannot be undone">
            <strong>{chosen.email}</strong> will be deleted. Its {chosen.ordersCount}{' '}
            {chosen.ordersCount === 1 ? 'order' : 'orders'}, addresses, tags and timeline move to{' '}
            <strong>{survivor.email}</strong>, whose lifetime figures are then recalculated from
            the orders themselves.
          </Alert>
        ) : null}
      </div>
    </Modal>
  )
}
