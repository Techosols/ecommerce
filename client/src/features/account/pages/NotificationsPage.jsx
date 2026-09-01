import { Bell, BellOff, Check } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { cn } from '@/lib/cn'
import { messageOf } from '@/lib/api'
import { useAuth } from '../useAuth'
import {
  useMarkAllRead,
  useMarkRead,
  useNotifications,
  usePreferences,
  useSetPreference,
} from '../hooks/notifications.hooks'

/**
 * The kinds of message a shop sends, and the channels they can arrive on.
 *
 * Listed here rather than fetched because the server publishes no catalogue of
 * types — `GET /preferences` returns only the *exceptions* somebody has set,
 * since an absent row means enabled. That is a good design (a new type needs no
 * backfill) with one consequence: this screen has to name the types it offers
 * switches for, and a type the shop adds later will not appear until this list
 * does. Better than the alternative, which is a screen that cannot show a
 * switch until somebody has already changed it.
 */
const TYPES = [
  { type: 'order.confirmed', label: 'Order confirmations' },
  { type: 'order.shipped', label: 'Dispatch and tracking' },
  { type: 'order.delivered', label: 'Delivery' },
  { type: 'order.cancelled', label: 'Cancellations' },
  { type: 'return.updated', label: 'Return progress' },
  { type: 'refund.issued', label: 'Refunds' },
]

const CHANNELS = [
  { key: 'in_app', label: 'Here' },
  { key: 'email', label: 'Email' },
]

export function NotificationsPage() {
  const { isSignedIn } = useAuth()
  const list = useNotifications({ page: 1, limit: 20 }, isSignedIn)
  const markAll = useMarkAllRead()

  const items = list.data?.items ?? []
  const anyUnread = items.some((item) => !item.read)

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-xl">Notifications</h2>
            <p className="text-muted text-sm">Messages about your orders and returns.</p>
          </div>
          {anyUnread ? (
            <Button
              size="sm"
              isLoading={markAll.isPending}
              leadingIcon={<Check className="size-3.5" aria-hidden="true" />}
              onClick={() => markAll.mutate()}
            >
              Mark all read
            </Button>
          ) : null}
        </div>

        <QueryBoundary
          isLoading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          fallback={<Skeleton className="h-40 w-full" />}
        >
          {items.length === 0 ? (
            <EmptyState
              icon={<BellOff className="size-6" />}
              title="Nothing yet"
              description="We will let you know here when something happens with an order."
            />
          ) : (
            <ul className="border-line bg-surface rounded-card divide-line divide-y border">
              {items.map((item) => (
                <NotificationRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </QueryBoundary>
      </section>

      <Preferences />
    </div>
  )
}

function NotificationRow({ item }) {
  const markRead = useMarkRead()

  return (
    <li className={cn('flex items-start gap-3 px-5 py-4', !item.read && 'bg-brand-50/40')}>
      <Bell
        className={cn('mt-0.5 size-4 shrink-0', item.read ? 'text-faint' : 'text-brand-600')}
        aria-hidden="true"
      />

      <div className="min-w-0 flex-1">
        <p className={cn('text-sm', item.read ? 'text-ink-soft' : 'text-ink font-medium')}>
          {item.title}
        </p>
        {item.body ? <p className="text-muted text-sm">{item.body}</p> : null}
        <p className="text-faint text-xs">
          {new Date(item.createdAt).toLocaleString(undefined, {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      </div>

      {!item.read ? (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Mark "${item.title}" as read`}
          isLoading={markRead.isPending}
          onClick={() => markRead.mutate(item.id)}
        >
          <Check className="size-3.5" aria-hidden="true" />
        </Button>
      ) : null}
    </li>
  )
}

function Preferences() {
  const { isSignedIn } = useAuth()
  const query = usePreferences(isSignedIn)
  const save = useSetPreference()

  // An absent row means enabled, so the map holds only what somebody has
  // turned off — and anything not in it is on.
  const set = new Map(
    (query.data ?? []).map((row) => [`${row.type}:${row.channel}`, row.enabled]),
  )
  const isOn = (type, channel) => set.get(`${type}:${channel}`) ?? true

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-base font-semibold">What we send you</h3>
        <p className="text-muted text-sm">
          Everything is on unless you turn it off. Order confirmations are always sent.
        </p>
      </div>

      {save.error ? <p className="text-bad text-sm">{messageOf(save.error)}</p> : null}

      <div className="border-line bg-surface rounded-card overflow-x-auto border">
        <table className="w-full min-w-sm text-sm">
          <thead>
            <tr className="border-line border-b">
              <th scope="col" className="text-muted px-5 py-2.5 text-left font-medium">
                Message
              </th>
              {CHANNELS.map((channel) => (
                <th
                  key={channel.key}
                  scope="col"
                  className="text-muted w-20 px-3 py-2.5 text-center font-medium"
                >
                  {channel.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-line divide-y">
            {TYPES.map((entry) => (
              <tr key={entry.type}>
                <th scope="row" className="text-ink px-5 py-2.5 text-left font-normal">
                  {entry.label}
                </th>
                {CHANNELS.map((channel) => (
                  <td key={channel.key} className="px-3 py-2.5 text-center">
                    <input
                      type="checkbox"
                      aria-label={`${entry.label} — ${channel.label}`}
                      checked={isOn(entry.type, channel.key)}
                      disabled={save.isPending || query.isPending}
                      onChange={(event) =>
                        save.mutate({
                          type: entry.type,
                          channel: channel.key,
                          enabled: event.target.checked,
                        })
                      }
                      className="accent-brand-600 size-4"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
