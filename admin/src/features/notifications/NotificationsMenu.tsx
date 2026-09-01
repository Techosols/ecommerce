import { Bell, CheckCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { DropdownMenu } from '@/components/ui/DropdownMenu'
import { useDropdownClose } from '@/components/ui/dropdown.context'
import { EmptyState } from '@/components/states/EmptyState'
import { ErrorState } from '@/components/states/ErrorState'
import { LoadingState } from '@/components/states/LoadingState'
import { NotificationItem } from './NotificationItem'
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadCount,
} from './notifications.hooks'

/**
 * The panel behind the bell.
 *
 * A separate component rather than an inline render function, so that it mounts
 * only when the menu opens — the list request is not made for every operator
 * who never opens it — and so React keeps its state across renders of the
 * header.
 */
function NotificationsPanel({ unreadCount }: { unreadCount: number }) {
  const closeMenu = useDropdownClose()
  const { data, isPending, error, refetch } = useNotifications({ limit: 10 })
  const markRead = useMarkNotificationRead()
  const markAllRead = useMarkAllNotificationsRead()
  const items = data?.items ?? []

  return (
    <div className="flex max-h-[70vh] flex-col">
      <header className="border-line flex items-center justify-between gap-2 border-b px-3 py-2">
        <p className="text-ink text-sm font-semibold">Notifications</p>
        {unreadCount > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            leadingIcon={<CheckCheck className="size-3.5" />}
            isLoading={markAllRead.isPending}
            onClick={() => markAllRead.mutate()}
          >
            Mark all read
          </Button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto">
        {isPending ? (
          <LoadingState label="Loading notifications…" />
        ) : error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Bell className="size-5" />}
            title="Nothing new"
            description="New orders, payments and stock alerts appear here."
          />
        ) : (
          <ul className="divide-line divide-y">
            {items.map((notification) => (
              <li key={notification.id}>
                <NotificationItem
                  notification={notification}
                  onMarkRead={(id) => markRead.mutate(id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="border-line border-t px-3 py-2">
        <Link
          to="/notifications"
          onClick={closeMenu}
          className="text-brand-600 hover:text-brand-700 block text-center text-xs font-medium"
        >
          View all notifications
        </Link>
      </footer>
    </div>
  )
}

/**
 * The bell in the header.
 *
 * The unread count comes from the server's own `unread-count` endpoint rather
 * than being counted from the loaded page, which would be wrong the moment
 * there are more than ten.
 */
export function NotificationsMenu() {
  const unread = useUnreadCount()
  const count = unread.data?.count ?? 0

  return (
    <DropdownMenu
      width="w-[22rem] max-w-[calc(100vw-2rem)]"
      trigger={({ ref, ...props }) => (
        <button
          ref={ref}
          type="button"
          aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
          className="text-muted hover:bg-surface-hover hover:text-ink relative flex size-9 items-center justify-center rounded-lg transition-colors"
          {...props}
        >
          <Bell className="size-4.5" />
          {count > 0 ? (
            <span className="bg-danger tabular absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold text-white">
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </button>
      )}
    >
      <NotificationsPanel unreadCount={count} />
    </DropdownMenu>
  )
}
