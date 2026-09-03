import type { ReactNode } from 'react'

export interface RankedBar {
  id: string
  label: string
  sublabel?: string | null
  value: number
  /** Already formatted: money, a count. Nothing here does arithmetic. */
  display: string
}

export interface RankedBarsProps {
  rows: RankedBar[]
  empty: ReactNode
}

/**
 * A ranked list, drawn as horizontal bars.
 *
 * ── Why horizontal ───────────────────────────────────────────────────────────
 *
 * The labels are product names and event names — long, and of wildly different
 * lengths. Vertical bars would give each one a rotated label nobody can read;
 * horizontal bars give the label a whole line at a comfortable reading angle
 * and the length still encodes the magnitude.
 *
 * ── One colour, not a ramp ───────────────────────────────────────────────────
 *
 * Every bar is the same brand step. Shading them dark-to-light by rank is a
 * common instinct and is wrong twice over: the colour would carry no
 * information the length does not already carry, and it would mean a bar
 * changes colour when a date filter reorders the list — the same product,
 * repainted, which reads as a different thing.
 *
 * Values are labelled directly at the end of each row rather than on an axis:
 * there are ten of them, they are the point of the chart, and an axis would
 * make the reader measure.
 */
export function RankedBars({ rows, empty }: RankedBarsProps) {
  if (rows.length === 0) return <>{empty}</>

  const max = Math.max(...rows.map((row) => row.value), 1)

  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((row) => (
        <li key={row.id} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0">
              <span className="text-ink block truncate text-sm" title={row.label}>
                {row.label}
              </span>
              {row.sublabel ? (
                <span className="text-faint block truncate text-xs">{row.sublabel}</span>
              ) : null}
            </span>
            <span className="text-ink shrink-0 text-sm font-medium tabular-nums">
              {row.display}
            </span>
          </div>

          {/* The track is the full width, so a short bar reads as "little of
              the maximum" rather than as a rendering that failed. */}
          <div className="bg-surface-sunken h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="bg-brand-600 h-full rounded-full"
              // Percentages of the largest row, which is what a ranked list is
              // read against. `aria-hidden` because the figure beside it is
              // already announced.
              style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }}
              aria-hidden="true"
            />
          </div>
        </li>
      ))}
    </ul>
  )
}
