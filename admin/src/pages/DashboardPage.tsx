import { BarChart3, Package, RefreshCw, ShoppingCart, TrendingUp, Users } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatCard } from '@/components/ui/StatCard'
import { DataTable, type Column } from '@/components/ui/Table'
import { EmptyState } from '@/components/states/EmptyState'
import { ErrorState } from '@/components/states/ErrorState'
import { formatDate, formatMoney, formatNumber } from '@/lib/format'
import { useAuth } from '@/features/auth/useAuth'
import {
  useDashboardOverview,
  useDashboardRealtimeSync,
} from '@/features/dashboard/dashboard.hooks'
import { OperationsQueues } from '@/features/dashboard/OperationsQueues'
import { SalesTrend } from '@/features/dashboard/SalesTrend'
import type { TopProduct } from '@/features/dashboard/dashboard.types'
import { DashboardSkeleton } from '@/components/states/LoadingState'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

const topProductColumns: Array<Column<TopProduct>> = [
  {
    id: 'title',
    header: 'Product',
    cell: (row) => (
      <div className="min-w-0">
        <p className="text-ink truncate font-medium">{row.title}</p>
        {row.variantTitle ? (
          <p className="text-muted truncate text-xs">{row.variantTitle}</p>
        ) : null}
      </div>
    ),
  },
  { id: 'units', header: 'Units', align: 'right', cell: (row) => formatNumber(row.unitsSold) },
  {
    id: 'net',
    header: 'Net sales',
    align: 'right',
    cell: (row) => <span className="text-ink font-medium">{formatMoney(row.netSales)}</span>,
  },
]

/**
 * The operations dashboard.
 *
 * Two halves, deliberately separated:
 *
 *   • **Today and the queues** — live, counted from the orders themselves,
 *     visible to every staff account.
 *   • **The last 30 days** — read from `analytics_daily_sales`, which has no
 *     row for today until tonight's rollup runs, so the window ends yesterday
 *     and the card says so. Behind `analytics:read`, which the `staff` role
 *     does not hold.
 *
 * Every figure on this page came from the server. Nothing is fabricated to fill
 * a card: an unavailable number renders as an em dash or an explanation, never
 * as a plausible-looking placeholder.
 */
export function DashboardPage() {
  const { user, can } = useAuth()
  const { data, isPending, isFetching, error, refetch } = useDashboardOverview()
  const canReadAnalytics = can('analytics:read')
  useDashboardRealtimeSync(canReadAnalytics)
  useDocumentTitle('Dashboard')

  const firstName = user?.firstName?.trim()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        // Staff accounts created by invitation often have no name yet, and
        // "Welcome, ops@example.com" reads worse than no greeting at all.
        title={firstName ? `Good to see you, ${firstName}` : 'Dashboard'}
        description="What is waiting for you, and how the store is trading."
        actions={
          canReadAnalytics ? (
            <Button
              variant="secondary"
              onClick={() => void refetch()}
              isLoading={isFetching && !isPending}
              leadingIcon={<RefreshCw className="size-4" />}
            >
              Refresh
            </Button>
          ) : undefined
        }
      />

      {!canReadAnalytics ? (
        <Alert tone="info" title="Trading figures are not shown for your role">
          Sales, revenue and product performance need the <code>analytics:read</code> permission.
          Your operational queues below are unaffected.
        </Alert>
      ) : null}

      {canReadAnalytics && error ? (
        <Card>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Card>
      ) : null}

      <section>
        <h2 className="text-muted mb-3 text-xs font-semibold tracking-wide uppercase">
          Needs attention
        </h2>
        <OperationsQueues counters={data?.counters} isLoading={canReadAnalytics && isPending} />
      </section>

      {canReadAnalytics ? (
        isPending ? (
          <DashboardSkeleton />
        ) : data ? (
          <>
            <section>
              <h2 className="text-muted mb-3 text-xs font-semibold tracking-wide uppercase">
                Today · {formatDate(data.today.date)}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  label="Net sales"
                  value={formatMoney(data.today.netSales)}
                  icon={<TrendingUp className="size-4" />}
                  hint="Gross less discounts and refunds"
                />
                <StatCard
                  label="Orders"
                  value={formatNumber(data.today.ordersCount)}
                  icon={<ShoppingCart className="size-4" />}
                  hint={
                    data.today.cancelledCount > 0
                      ? `${formatNumber(data.today.cancelledCount)} cancelled`
                      : undefined
                  }
                />
                <StatCard
                  label="Average order"
                  value={formatMoney(data.today.averageOrderValue)}
                  icon={<BarChart3 className="size-4" />}
                />
                <StatCard
                  label="New customers"
                  value={formatNumber(data.today.newCustomers)}
                  icon={<Users className="size-4" />}
                  hint={`${formatNumber(data.today.returningCustomers)} returning`}
                />
              </div>
            </section>

            <div className="grid gap-4 xl:grid-cols-3">
              <Card className="xl:col-span-2">
                <CardHeader
                  title="Net sales, last 30 days"
                  description={`Rolled up ${formatDate(data.rolledUpRange.from)} – ${formatDate(data.rolledUpRange.to)}. Today is shown live above.`}
                />
                <CardBody>
                  <SalesTrend series={data.series} />

                  <dl className="border-line mt-5 grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-4">
                    <Figure label="Orders" value={formatNumber(data.summary.ordersCount)} />
                    <Figure label="Units sold" value={formatNumber(data.summary.unitsSold)} />
                    <Figure label="Net sales" value={formatMoney(data.summary.netSales)} />
                    <Figure label="Refunds" value={formatMoney(data.summary.refunds)} />
                  </dl>
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Top products"
                  description={`By net sales, ${formatDate(data.rolledUpRange.from)} – ${formatDate(data.rolledUpRange.to)}`}
                />
                <DataTable
                  columns={topProductColumns}
                  rows={data.topProducts}
                  getRowId={(row) => `${row.productId}:${row.variantId}`}
                  caption="Top products by net sales"
                  emptyState={
                    <EmptyState
                      icon={<Package className="size-5" />}
                      title="No sales in this window"
                      description="Products appear here once orders have been rolled up."
                    />
                  }
                />
              </Card>
            </div>
          </>
        ) : null
      ) : null}
    </div>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted text-xs">{label}</dt>
      <dd className="text-ink tabular mt-0.5 text-lg font-semibold">{value}</dd>
    </div>
  )
}
