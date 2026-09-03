import { useMemo, useState } from 'react'
import { CalendarRange, Package, RefreshCw, ShoppingCart, TrendingUp } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { Select } from '@/components/ui/Select'
import { StatCard } from '@/components/ui/StatCard'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useToast } from '@/components/ui/toast.context'
import { useAuth } from '@/features/auth/useAuth'
import { formatDate, formatMoney, formatNumber } from '@/lib/format'
import { messageOf } from '@/lib/api/errors'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { RankedBars } from '../RankedBars'
import { TimeSeriesChart } from '../TimeSeriesChart'
import {
  useRecomputeRollups,
  useSalesReport,
  useStorefrontEvents,
  useTopProducts,
} from '../analytics.hooks'
import type { DateRange } from '../analytics.types'

/**
 * Sales, products and storefront behaviour over a range.
 *
 * ── The range ends yesterday, and says so ────────────────────────────────────
 *
 * Every figure here reads `analytics_daily_sales`, which tonight's rollup job
 * writes. There is no row for today until that job runs, so a range labelled
 * "…to today" would report a day of zero sales beside a chart that drops off a
 * cliff. Ending yesterday and labelling the window honestly is the fix; today's
 * live figures are on the dashboard, which reads the orders directly.
 *
 * ── Two measures, two charts ─────────────────────────────────────────────────
 *
 * Net sales and order count are drawn separately rather than on shared axes
 * with a second scale. A dual-axis chart can be slid until any two lines appear
 * to move together, and nothing about where they cross is true.
 *
 * ── Nothing is computed here ─────────────────────────────────────────────────
 *
 * The totals, the average order value and the league table all arrive from the
 * server. A browser that added up the days itself would produce a second
 * answer, and a screen with two irreconcilable totals is worse than one with
 * none.
 */

const PERIODS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last 12 months' },
] as const

/** Yesterday, and the day `days` before it — the window the rollups cover. */
function rangeOf(days: number): DateRange {
  const midnight = new Date()
  midnight.setUTCHours(0, 0, 0, 0)
  const to = new Date(midnight.getTime() - 86_400_000)
  const from = new Date(to.getTime() - (days - 1) * 86_400_000)
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

export function AnalyticsPage() {
  useDocumentTitle('Analytics')
  const { can } = useAuth()
  const { toast } = useToast()
  const [period, setPeriod] = useState('30')

  const range = useMemo(() => rangeOf(Number(period)), [period])

  const sales = useSalesReport(range)
  const products = useTopProducts(range, 10)
  const events = useStorefrontEvents(range)
  const recompute = useRecomputeRollups()

  const summary = sales.data?.summary

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Analytics"
        description={`Rolled up nightly. Showing ${formatDate(range.from)} to ${formatDate(range.to)}.`}
        actions={
          <div className="flex items-center gap-2">
            <Select
              aria-label="Period"
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
              className="w-44"
            >
              {PERIODS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>

            {/* Recomputing is a narrower permission than reading: it rewrites
                the table every figure on this page is drawn from. */}
            {can('reports:generate') ? (
              <Button
                variant="secondary"
                leadingIcon={<RefreshCw className="size-4" />}
                isLoading={recompute.isPending}
                onClick={() =>
                  recompute.mutate(range, {
                    onSuccess: (result) =>
                      toast({
                        tone: 'success',
                        title: `Recomputed ${result.recomputed} ${
                          result.recomputed === 1 ? 'day' : 'days'
                        }`,
                      }),
                    onError: (error) =>
                      toast({
                        tone: 'error',
                        title: 'Could not recompute',
                        description: messageOf(error),
                      }),
                  })
                }
              >
                Recompute
              </Button>
            ) : null}
          </div>
        }
      />

      {/* Said once, at the top: it explains why these numbers differ from the
          dashboard's "today" block, which is the first question anybody asks. */}
      <Alert tone="info">
        These figures come from the nightly rollup, so the window ends yesterday. Today&rsquo;s
        live takings are on the dashboard.
      </Alert>

      <QueryBoundary
        isLoading={sales.isPending}
        error={sales.error}
        onRetry={() => void sales.refetch()}
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Net sales"
            value={formatMoney(summary?.netSales)}
            icon={<TrendingUp className="size-4" />}
            hint="After discounts and refunds"
          />
          <StatCard
            label="Orders"
            value={formatNumber(summary?.ordersCount)}
            icon={<ShoppingCart className="size-4" />}
          />
          <StatCard
            label="Average order"
            value={formatMoney(summary?.averageOrderValue)}
            icon={<CalendarRange className="size-4" />}
          />
          <StatCard
            label="Units sold"
            value={formatNumber(summary?.unitsSold)}
            icon={<Package className="size-4" />}
          />
        </div>

        <Card>
          <CardHeader title="Net sales" description="After discounts and refunds, per day." />
          <CardBody>
            <TimeSeriesChart
              label="Net sales"
              points={(sales.data?.series ?? []).map((day) => ({
                date: day.date,
                value: day.netSales.amount,
              }))}
              format={(value) =>
                formatMoney({
                  amount: value,
                  currency: sales.data?.summary.netSales.currency ?? 'USD',
                })
              }
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Orders"
            description="A separate chart on purpose — a count and a currency do not share an axis."
          />
          <CardBody>
            <TimeSeriesChart
              label="Orders"
              height={150}
              points={(sales.data?.series ?? []).map((day) => ({
                date: day.date,
                value: day.ordersCount,
              }))}
              format={(value) => formatNumber(value)}
            />
          </CardBody>
        </Card>
      </QueryBoundary>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Best sellers" description="By net sales over the range." />
          <CardBody>
            <QueryBoundary
              isLoading={products.isPending}
              error={products.error}
              onRetry={() => void products.refetch()}
            >
              <RankedBars
                rows={(products.data ?? []).map((row) => ({
                  id: row.variantId,
                  label: row.title,
                  sublabel: row.variantTitle,
                  value: row.netSales.amount,
                  display: `${formatMoney(row.netSales)} · ${formatNumber(row.unitsSold)} sold`,
                }))}
                empty={
                  <p className="text-muted py-8 text-center text-sm">
                    Nothing sold in this range.
                  </p>
                }
              />
            </QueryBoundary>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="What shoppers did"
            description="Views, baskets and checkouts reported by the storefront."
          />
          <CardBody>
            <QueryBoundary
              isLoading={events.isPending}
              error={events.error}
              onRetry={() => void events.refetch()}
            >
              <RankedBars
                rows={(events.data ?? []).map((row) => ({
                  id: row.name,
                  label: EVENT_LABELS[row.name] ?? row.name,
                  value: row.count,
                  display: formatNumber(row.count),
                }))}
                empty={
                  // Distinguished from "nobody visited": these rows exist only
                  // if the storefront is reporting them.
                  <p className="text-muted py-8 text-center text-sm">
                    No storefront activity recorded in this range.
                  </p>
                }
              />
            </QueryBoundary>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

/** The server's event names, in the words an operator uses. */
const EVENT_LABELS: Record<string, string> = {
  page_viewed: 'Pages viewed',
  product_viewed: 'Products viewed',
  collection_viewed: 'Collections viewed',
  search_performed: 'Searches',
  cart_viewed: 'Baskets viewed',
  cart_item_added: 'Added to basket',
  cart_item_removed: 'Removed from basket',
  checkout_started: 'Checkouts started',
  checkout_completed: 'Checkouts completed',
}
