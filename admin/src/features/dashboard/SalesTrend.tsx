import { useId } from 'react'
import { formatDate, formatMoney } from '@/lib/format'
import type { DailyFigures } from './dashboard.types'

/**
 * Thirty days of net sales, drawn as an inline SVG.
 *
 * A charting library is a real dependency with a real bundle cost, and this
 * phase needs exactly one sparkline. When the Analytics feature lands with
 * multiple chart types, axes and tooltips, that is the moment to add one —
 * adding it now would be paying for it before knowing which one fits.
 *
 * The only arithmetic here is scaling values into pixel space. No total,
 * average or growth figure is computed in the browser: those come from the
 * server's `summary`.
 */
export function SalesTrend({ series }: { series: DailyFigures[] }) {
  const gradientId = useId()

  if (series.length < 2) {
    return (
      <p className="text-muted py-10 text-center text-sm">
        Not enough rolled-up days yet to draw a trend.
      </p>
    )
  }

  const width = 720
  const height = 180
  const padding = 4

  const values = series.map((day) => day.netSales.amount)
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const span = max - min || 1

  const points = series.map((day, index) => {
    const x = (index / (series.length - 1)) * (width - padding * 2) + padding
    const y = height - padding - ((day.netSales.amount - min) / span) * (height - padding * 2)
    return { x, y, day }
  })

  const line = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`)
    .join(' ')
  const area = `${line} L${points[points.length - 1]!.x},${height} L${points[0]!.x},${height} Z`

  const peak = points.reduce((best, point) =>
    point.day.netSales.amount > best.day.netSales.amount ? point : best,
  )

  return (
    <figure className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Net sales from ${formatDate(series[0]!.date)} to ${formatDate(series[series.length - 1]!.date)}. Highest day ${formatDate(peak.day.date)} at ${formatMoney(peak.day.netSales)}.`}
        className="h-44 w-full"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-brand-500)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--color-brand-500)" stopOpacity="0" />
          </linearGradient>
        </defs>

        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={line}
          fill="none"
          stroke="var(--color-brand-600)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={peak.x}
          cy={peak.y}
          r="3"
          fill="var(--color-brand-600)"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <figcaption className="text-faint mt-2 flex justify-between text-xs">
        <span>{formatDate(series[0]!.date)}</span>
        <span className="text-muted">
          Peak {formatMoney(peak.day.netSales)} on {formatDate(peak.day.date)}
        </span>
        <span>{formatDate(series[series.length - 1]!.date)}</span>
      </figcaption>
    </figure>
  )
}
