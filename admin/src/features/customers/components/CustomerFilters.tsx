import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Drawer } from '@/components/ui/Drawer'
import { Field } from '@/components/ui/Field'
import { FilterBar } from '@/components/ui/FilterBar'
import { Input } from '@/components/ui/Input'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { MARKETING_LABELS } from './customerLabels'
import { emptyCustomerFilters, type CustomerFiltersValue } from './customerFilters'
import type { CustomerSegment, MarketingState } from '../types/customers.types'

export interface CustomerFiltersProps {
  value: CustomerFiltersValue
  onChange: (value: CustomerFiltersValue) => void
  isFiltered: boolean
  segments: CustomerSegment[]
  isDrawerOpen: boolean
  onDrawerOpenChange: (open: boolean) => void
  trailing?: React.ReactNode
}

/**
 * Search and sort on the bar; everything else behind a drawer.
 *
 * Fifteen filters laid out in a strip is a wall nobody reads. The three that
 * get used every day — search, segment, sort — stay visible; the commercial
 * ones live in a panel that opens when somebody is actually asking a question
 * of the data.
 *
 * Every control writes to the URL through the page, so a narrowed list is a
 * link rather than a state somebody has to rebuild by hand.
 */
export function CustomerFilters({
  value,
  onChange,
  isFiltered,
  segments,
  isDrawerOpen,
  onDrawerOpenChange,
  trailing,
}: CustomerFiltersProps) {
  function set(patch: Partial<CustomerFiltersValue>) {
    onChange({ ...value, ...patch })
  }

  const marketingOptions = (Object.keys(MARKETING_LABELS) as MarketingState[]).map((state) => ({
    value: state,
    label: MARKETING_LABELS[state],
  }))

  return (
    <>
      <FilterBar
        isFiltered={isFiltered}
        onClear={() => onChange(emptyCustomerFilters)}
        search={
          <SearchInput
            size="sm"
            aria-label="Search customers"
            placeholder="Name, email or phone…"
            value={value.q}
            onChange={(event) => set({ q: event.target.value })}
            onClear={() => set({ q: '' })}
          />
        }
        filters={
          <>
            <Select
              size="sm"
              aria-label="Segment"
              value={value.segmentId}
              onChange={(event) => set({ segmentId: event.target.value })}
              placeholder="All customers"
              // Inactive segments stay saved but are not offered here — that is
              // what switching one off is for.
              options={segments
                .filter((segment) => segment.isActive)
                .map((segment) => ({ value: segment.id, label: segment.name }))}
            />
            <Select
              size="sm"
              aria-label="Sort by"
              value={value.sort}
              onChange={(event) => set({ sort: event.target.value })}
              options={[
                { value: '', label: 'Newest first' },
                { value: 'spend', label: 'Total spent' },
                { value: 'orders', label: 'Orders' },
                { value: 'lastOrder', label: 'Last order' },
                { value: 'name', label: 'Name' },
              ]}
            />
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<SlidersHorizontal className="size-3.5" />}
              onClick={() => onDrawerOpenChange(true)}
            >
              More filters
            </Button>
          </>
        }
        {...(trailing ? { trailing } : {})}
      />

      <Drawer
        isOpen={isDrawerOpen}
        onClose={() => onDrawerOpenChange(false)}
        title="Filter customers"
        description="Every filter here runs on the server against the whole shop, not the page on screen."
        footer={
          <div className="flex justify-between gap-2">
            <Button variant="ghost" onClick={() => onChange(emptyCustomerFilters)}>
              Clear all
            </Button>
            <Button onClick={() => onDrawerOpenChange(false)}>Done</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Account status">
            <Select
              value={value.status}
              onChange={(event) =>
                set({ status: event.target.value as CustomerFiltersValue['status'] })
              }
              placeholder="Any"
              options={[
                { value: 'active', label: 'Active' },
                { value: 'disabled', label: 'Disabled' },
                { value: 'locked', label: 'Locked' },
              ]}
            />
          </Field>

          <Field
            label="Email marketing"
            hint="Not subscribed and unsubscribed are different things: only the first may be asked again."
          >
            <Select
              value={value.marketingEmailState}
              onChange={(event) =>
                set({
                  marketingEmailState: event.target
                    .value as CustomerFiltersValue['marketingEmailState'],
                })
              }
              placeholder="Any"
              options={marketingOptions}
            />
          </Field>

          <Field label="Has ordered">
            <Select
              value={value.hasOrders}
              onChange={(event) =>
                set({ hasOrders: event.target.value as CustomerFiltersValue['hasOrders'] })
              }
              placeholder="Any"
              options={[
                { value: 'true', label: 'Has placed an order' },
                { value: 'false', label: 'Has never ordered' },
              ]}
            />
          </Field>

          <Field label="Tax exempt">
            <Select
              value={value.taxExempt}
              onChange={(event) =>
                set({ taxExempt: event.target.value as CustomerFiltersValue['taxExempt'] })
              }
              placeholder="Any"
              options={[
                { value: 'true', label: 'Exempt' },
                { value: 'false', label: 'Not exempt' },
              ]}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Spent at least" hint="In whole units of your currency.">
              <Input
                type="number"
                min={0}
                step="0.01"
                value={value.minSpent}
                onChange={(event) => set({ minSpent: event.target.value })}
              />
            </Field>
            <Field label="Spent at most">
              <Input
                type="number"
                min={0}
                step="0.01"
                value={value.maxSpent}
                onChange={(event) => set({ maxSpent: event.target.value })}
              />
            </Field>
          </div>

          <Field label="At least this many orders">
            <Input
              type="number"
              min={0}
              value={value.minOrders}
              onChange={(event) => set({ minOrders: event.target.value })}
            />
          </Field>

          <Field
            label="Has not ordered since"
            hint="Finds customers who have gone quiet — including those who never ordered at all."
          >
            <Input
              type="date"
              value={value.noOrderSince}
              onChange={(event) => set({ noOrderSince: event.target.value })}
            />
          </Field>

          <Field label="Direction">
            <Select
              value={value.direction}
              onChange={(event) =>
                set({ direction: event.target.value as CustomerFiltersValue['direction'] })
              }
              options={[
                { value: '', label: 'Highest first' },
                { value: 'asc', label: 'Lowest first' },
              ]}
            />
          </Field>
        </div>
      </Drawer>
    </>
  )
}
