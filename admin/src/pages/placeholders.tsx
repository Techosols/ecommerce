import { PlaceholderPage } from './PlaceholderPage'

/**
 * The management areas, routed and protected but not yet implemented.
 *
 * Each lists the real endpoints from the matching
 * `server/src/features/<feature>/<feature>.admin.routes.ts` that it will
 * consume, so the next phase starts from the contract rather than from a guess.
 */

export function CustomersPage() {
  return (
    <PlaceholderPage
      title="Customers"
      description="Accounts, order history and lifetime value for everyone who has shopped here."
      planned={[
        'Search and filter the customer list',
        'Open a customer to see their orders, addresses and lifetime figures',
        'Enable or disable an account',
      ]}
      endpoints={[
        'GET /admin/customers',
        'GET /admin/customers/:id',
        'PATCH /admin/customers/:id/status',
      ]}
    />
  )
}

export function InventoryPage() {
  return (
    <PlaceholderPage
      title="Inventory"
      description="Stock on hand, what is reserved against open orders, and what needs reordering."
      planned={[
        'Stock levels per variant and location, with low and out-of-stock filters',
        'Adjustments, stocktakes and transfers between locations',
        'The movement history behind any number on screen',
        'Manage stock locations',
      ]}
      endpoints={[
        'GET /admin/inventory',
        'GET /admin/inventory/items/:id',
        'GET /admin/inventory/items/:id/history',
        'POST /admin/inventory/adjustments',
        'POST /admin/inventory/stocktake',
        'POST /admin/inventory/transfers',
        'GET /admin/locations',
      ]}
    />
  )
}

export function PaymentsPage() {
  return (
    <PlaceholderPage
      title="Payments"
      description="Money taken and money returned, per order. Cash on delivery today; more methods later."
      planned={[
        'See the payments recorded against an order',
        'Record a payment taken outside the storefront',
        'Issue full and partial refunds, with or without restocking',
      ]}
      endpoints={[
        'GET /admin/orders/:id/payments',
        'POST /admin/orders/:id/payments',
        'POST /admin/orders/:id/refunds',
      ]}
    />
  )
}

export function AnalyticsPage() {
  return (
    <PlaceholderPage
      title="Analytics"
      description="Sales, orders, customers and products over a range you choose."
      planned={[
        'Sales and order trends over an arbitrary date range',
        'Top products by units and by net sales',
        'New against returning customers',
        'Re-run a rollup for a range that was corrected after the fact',
      ]}
      endpoints={[
        'GET /admin/analytics/sales?from&to',
        'GET /admin/analytics/products?from&to&limit',
        'GET /admin/analytics/events?from&to',
        'POST /admin/analytics/rollups',
      ]}
    />
  )
}
