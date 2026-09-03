import { useId, useState } from 'react'
import { formatDate } from '@/lib/format'

export interface TimeSeriesPoint {
  date: string
  value: number
}

export interface TimeSeriesChartProps {
  points: TimeSeriesPoint[]
  /** Turns a raw value into what a person reads: money, a count. */
  format: (value: number) => string
  /** Names the single series, so no legend is needed. */
  label: string
  height?: number
}

/**
 * One measure over time, as an inline SVG.
 *
 * ── Why one series, and never two ────────────────────────────────────────────
 *
 * The obvious next move on a sales chart is to draw orders on the same axes
 * with a second scale on the right. That chart is unreadable: two y-scales can
 * be slid against each other until any two lines appear to correlate, and the
 * crossing points mean nothing at all. Money and counts are different measures,
 * so they get their own charts stacked as small multiples — same x-axis, same
 * width, read down the page.
 *
 * That is also why there is no legend. A single series is named by the chart's
 * own title; a legend box for one line is furniture.
 *
 * ── Why no charting library ──────────────────────────────────────────────────
 *
 * Two chart shapes across two screens, drawn from server-computed numbers. The
 * arithmetic below is scaling into pixel space and nothing else — no total,
 * average or growth figure is worked out in the browser, because every one of
 * those already arrives from the server's `summary` and a second computation
 * would be a second answer.
 *
 * ── The hover layer ──────────────────────────────────────────────────────────
 *
 * A chart on a screen is asked "what was that day?", so a crosshair and a
 * readout are part of the chart rather than an enhancement. The pointer is
 * tracked against one full-height rectangle rather than per-point hit areas: at
 * a year's width the points are two pixels apart and per-point targets would be
 * unhittable.
 */
export function TimeSeriesChart({ points, format, label, height = 200 }: TimeSeriesChartProps) {
  const gradientId = useId()
  const [active, setActive] = useState<number | null>(null)

  if (points.length < 2) {
    return (
      <p className="text-muted py-12 text-center text-sm">
        Not enough days in this range to draw a trend.
      </p>
    )
  }

  const width = 760
  const padding = { top: 10, right: 8, bottom: 22, left: 8 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom

  const values = points.map((point) => point.value)
  // The baseline is zero unless the data goes below it. A sales chart whose
  // y-axis starts at the minimum exaggerates every wobble into a cliff.
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const span = max - min || 1

  const xOf = (index: number) => padding.left + (index / (points.length - 1)) * plotWidth
  const yOf = (value: number) => padding.top + plotHeight - ((value - min) / span) * plotHeight

  const line = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(index)},${yOf(point.value)}`)
    .join(' ')
  const area = `${line} L${xOf(points.length - 1)},${padding.top + plotHeight} L${xOf(0)},${
    padding.top + plotHeight
  } Z`

  const peakIndex = values.reduce((best, value, index) => (value > values[best]! ? index : best), 0)
  const shown = active ?? peakIndex
  const shownPoint = points[shown]!

  return (
    <figure className="w-full">
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${label} from ${formatDate(points[0]!.date)} to ${formatDate(
            points[points.length - 1]!.date,
          )}. Highest ${formatDate(points[peakIndex]!.date)} at ${format(values[peakIndex]!)}.`}
          className="w-full"
          style={{ height }}
          onMouseLeave={() => setActive(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            const ratio = (event.clientX - box.left) / box.width
            const index = Math.round(ratio * (points.length - 1))
            setActive(Math.min(points.length - 1, Math.max(0, index)))
          }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-brand-500)" stopOpacity="0.24" />
              <stop offset="100%" stopColor="var(--color-brand-500)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Recessive: the grid is a reference, not part of the data. */}
          {[0, 0.5, 1].map((fraction) => {
            const y = padding.top + plotHeight * fraction
            return (
              <line
                key={fraction}
                x1={padding.left}
                x2={width - padding.right}
                y1={y}
                y2={y}
                stroke="var(--color-line)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            )
          })}

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

          {/* The crosshair, only while a pointer is over the plot. */}
          {active !== null ? (
            <line
              x1={xOf(active)}
              x2={xOf(active)}
              y1={padding.top}
              y2={padding.top + plotHeight}
              stroke="var(--color-line-strong)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {/* A ring in the surface colour, so the marker reads against the
              line it sits on. */}
          <circle
            cx={xOf(shown)}
            cy={yOf(shownPoint.value)}
            r="4"
            fill="var(--color-brand-600)"
            stroke="var(--color-surface)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>

      <figcaption className="text-faint mt-1.5 flex items-baseline justify-between gap-3 text-xs">
        <span>{formatDate(points[0]!.date)}</span>
        {/* The readout wears text tokens, never the series colour — the mark
            beside it is what carries identity. */}
        <span className="text-muted tabular-nums">
          <span className="text-ink font-medium">{format(shownPoint.value)}</span>{' '}
          <span aria-hidden="true">·</span> {formatDate(shownPoint.date)}
          {active === null ? ' (peak)' : ''}
        </span>
        <span>{formatDate(points[points.length - 1]!.date)}</span>
      </figcaption>
    </figure>
  )
}
