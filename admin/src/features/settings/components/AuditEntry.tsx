import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { describeAction, toneOf } from './auditLabels'
import { formatDateTime } from '@/lib/format'
import type { AuditRecord } from '../types/settings.types'

export interface AuditEntryProps {
  record: AuditRecord
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function render(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value === '' ? '(empty)' : value
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return String(value)
  return JSON.stringify(value)
}

/**
 * One recorded change.
 *
 * The row is the summary; the diff is behind a disclosure, because most of the
 * time the question is "who and when" and the payload is noise. When it is
 * opened, the two halves are shown **field by field** rather than as two JSON
 * blobs: the server records only what changed, so the useful reading is
 * `price: 1200 → 1500` and not two objects to compare by eye.
 */
export function AuditEntry({ record }: AuditEntryProps) {
  const [open, setOpen] = useState(false)

  const before = isObject(record.before) ? record.before : null
  const after = isObject(record.after) ? record.after : null
  const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
  const hasDetail = fields.length > 0

  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Badge size="sm" tone={toneOf(record.action)}>
          {describeAction(record.action)}
        </Badge>

        <span className="text-ink min-w-0 text-sm">
          {record.actor.email ?? 'The system'}
          {record.actor.roles.length > 0 ? (
            <span className="text-faint text-xs"> · {record.actor.roles.join(', ')}</span>
          ) : null}
        </span>

        <span className="text-muted truncate text-xs">
          {record.resourceType}
          {record.resourceId ? ` ${record.resourceId.slice(0, 8)}` : ''}
        </span>

        <span className="text-faint ml-auto text-xs">{formatDateTime(record.createdAt)}</span>
      </div>

      {hasDetail ? (
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="text-muted hover:text-ink mt-1 inline-flex items-center gap-1 text-xs"
          aria-expanded={open}
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {fields.length} {fields.length === 1 ? 'field' : 'fields'} changed
        </button>
      ) : null}

      {open && hasDetail ? (
        <dl className="border-line mt-2 grid gap-x-4 gap-y-1 border-l pl-3 text-xs sm:grid-cols-[10rem_1fr]">
          {fields.map((field) => (
            <div key={field} className="contents">
              <dt className="text-muted truncate">{field}</dt>
              <dd className="text-ink flex flex-wrap items-center gap-2">
                {before ? (
                  <>
                    <span className="text-faint line-through">{render(before[field])}</span>
                    <span className="text-faint">→</span>
                  </>
                ) : null}
                <span>{render(after ? after[field] : undefined)}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {open && record.requestId ? (
        <p className="text-faint mt-2 text-xs">Request {record.requestId}</p>
      ) : null}
    </li>
  )
}
