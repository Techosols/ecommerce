import type { ReactNode } from 'react'
import { Construction } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatePanel } from '@/components/states/StatePanel'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

export interface PlaceholderPageProps {
  title: string
  description: string
  /** What this page will do, in the operator's words. */
  planned: string[]
  /** The server endpoints it will consume, so the next phase has a starting point. */
  endpoints: string[]
  actions?: ReactNode
}

/**
 * A route that exists, is protected, and is honest about being empty.
 *
 * Every management page is a placeholder in this phase. Rather than mock a
 * table of invented orders — which is how a demo gets mistaken for a working
 * feature, and how a screenshot of fake revenue ends up in a stakeholder deck —
 * each one states what it will do and which real endpoints it will use.
 */
export function PlaceholderPage({
  title,
  description,
  planned,
  endpoints,
  actions,
}: PlaceholderPageProps) {
  useDocumentTitle(title)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} description={description} {...(actions ? { actions } : {})} />

      <Card>
        <StatePanel
          tone="info"
          icon={<Construction className="size-5" />}
          title="Not built yet"
          description="The admin foundation is in place — navigation, authentication, permissions and realtime. This area arrives in a later phase."
        />

        <div className="border-line grid gap-px border-t md:grid-cols-2">
          <div className="bg-surface p-5">
            <h3 className="text-ink text-xs font-semibold tracking-wide uppercase">
              What this page will do
            </h3>
            <ul className="text-muted mt-3 space-y-1.5 text-sm">
              {planned.map((item) => (
                <li key={item} className="flex gap-2">
                  <span
                    aria-hidden="true"
                    className="bg-line-strong mt-2 size-1 shrink-0 rounded-full"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-surface-sunken p-5">
            <h3 className="text-ink text-xs font-semibold tracking-wide uppercase">
              Backend endpoints it will use
            </h3>
            <ul className="mt-3 space-y-1.5">
              {endpoints.map((endpoint) => (
                <li key={endpoint} className="text-ink-soft font-mono text-xs break-all">
                  {endpoint}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>
    </div>
  )
}
