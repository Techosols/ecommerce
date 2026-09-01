import { useState } from 'react'
import { Bell, CheckCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { Pagination } from '@/components/ui/Pagination'
import { Tabs } from '@/components/ui/Tabs'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { NotificationItem } from '@/features/notifications/NotificationItem'
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadCount,
} from '@/features/notifications/notifications.hooks'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

/**
 * The full notification history.
 *
 * Backed by the same `/admin/notifications` endpoints the bell uses, paginated
 * by the server. This is the durable record — realtime only nudges it — so an
 * operator who was offline sees everything they missed here.
 */
export function NotificationsPage() {
  const [tab, setTab] = useState<'all' | 'unread'>('all')
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(20)

  const query = useNotifications({ page, limit, unread: tab === 'unread' })
  const unread = useUnreadCount()
  const markRead = useMarkNotificationRead()
  const markAllRead = useMarkAllNotificationsRead()
  useDocumentTitle('Notifications')

  const unreadCount = unread.data?.count ?? 0

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notifications"
        description="New orders, payments, shipments and stock alerts raised by the server."
        actions={
          unreadCount > 0 ? (
            <Button
              variant="secondary"
              leadingIcon={<CheckCheck className="size-4" />}
              isLoading={markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
            >
              Mark all read
            </Button>
          ) : undefined
        }
      />

      <Card>
        <Tabs
          className="px-2 pt-1"
          value={tab}
          onChange={(next) => {
            setTab(next as 'all' | 'unread')
            setPage(1)
          }}
          items={[
            { id: 'all', label: 'All' },
            { id: 'unread', label: 'Unread', count: unreadCount },
          ]}
        />

        <QueryBoundary
          isLoading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
        >
          {query.data && query.data.items.length > 0 ? (
            <>
              <ul className="divide-line divide-y">
                {query.data.items.map((notification) => (
                  <li key={notification.id}>
                    <NotificationItem
                      notification={notification}
                      onMarkRead={(id) => markRead.mutate(id)}
                      className="px-4 sm:px-5"
                    />
                  </li>
                ))}
              </ul>

              <div className="border-line border-t px-4 py-3 sm:px-5">
                <Pagination
                  pagination={query.data.pagination}
                  onPageChange={setPage}
                  onLimitChange={(next) => {
                    setLimit(next)
                    setPage(1)
                  }}
                />
              </div>
            </>
          ) : (
            <EmptyState
              icon={<Bell className="size-5" />}
              title={tab === 'unread' ? 'Nothing unread' : 'No notifications yet'}
              description={
                tab === 'unread'
                  ? 'You are up to date.'
                  : 'New orders, payments and stock alerts will appear here as they happen.'
              }
            />
          )}
        </QueryBoundary>
      </Card>
    </div>
  )
}
