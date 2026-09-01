import { FilterBar } from '@/components/ui/FilterBar'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { emptyOrderFilters, type OrderFiltersValue } from './orderFilters'
import type { FulfillmentStatus, OrderStatus, PaymentStatus } from '../types/orders.types'

export type { OrderFiltersValue }

export interface OrderFiltersProps {
  value: OrderFiltersValue
  onChange: (value: OrderFiltersValue) => void
}

/**
 * Search and the three status filters, which is exactly what
 * `orderListQuery` accepts.
 *
 * Three separate selects rather than one "status" dropdown, because the three
 * machines are independent: "paid and unfulfilled" is the morning's picking
 * list and cannot be expressed as a single value. The search matches the order
 * number or the email — the two things a customer gives on the phone.
 */
export function OrderFilters({ value, onChange }: OrderFiltersProps) {
  const isFiltered =
    value.q !== '' ||
    value.status !== '' ||
    value.paymentStatus !== '' ||
    value.fulfillmentStatus !== ''

  function set(patch: Partial<OrderFiltersValue>) {
    onChange({ ...value, ...patch })
  }

  return (
    <FilterBar
      isFiltered={isFiltered}
      onClear={() => onChange(emptyOrderFilters)}
      search={
        <SearchInput
          size="sm"
          aria-label="Search orders"
          placeholder="Order number or email…"
          value={value.q}
          onChange={(event) => set({ q: event.target.value })}
          onClear={() => set({ q: '' })}
        />
      }
      filters={
        <>
          <Select
            size="sm"
            aria-label="Filter by order status"
            className="w-36"
            value={value.status}
            onChange={(event) => set({ status: event.target.value as OrderStatus | '' })}
            options={[
              { value: '', label: 'Any status' },
              { value: 'pending', label: 'Pending' },
              { value: 'confirmed', label: 'Confirmed' },
              { value: 'processing', label: 'Processing' },
              { value: 'completed', label: 'Completed' },
              { value: 'cancelled', label: 'Cancelled' },
            ]}
          />

          <Select
            size="sm"
            aria-label="Filter by payment status"
            className="w-40"
            value={value.paymentStatus}
            onChange={(event) => set({ paymentStatus: event.target.value as PaymentStatus | '' })}
            options={[
              { value: '', label: 'Any payment' },
              { value: 'pending', label: 'Unpaid' },
              { value: 'authorized', label: 'Authorised' },
              { value: 'paid', label: 'Paid' },
              { value: 'partially_refunded', label: 'Part refunded' },
              { value: 'refunded', label: 'Refunded' },
              { value: 'failed', label: 'Payment failed' },
            ]}
          />

          <Select
            size="sm"
            aria-label="Filter by fulfilment status"
            className="w-40"
            value={value.fulfillmentStatus}
            onChange={(event) =>
              set({ fulfillmentStatus: event.target.value as FulfillmentStatus | '' })
            }
            options={[
              { value: '', label: 'Any fulfilment' },
              { value: 'unfulfilled', label: 'Unfulfilled' },
              { value: 'partially_fulfilled', label: 'Part shipped' },
              { value: 'fulfilled', label: 'Shipped' },
              { value: 'delivered', label: 'Delivered' },
              { value: 'returned', label: 'Returned' },
            ]}
          />
        </>
      }
    />
  )
}
