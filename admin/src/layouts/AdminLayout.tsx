import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@/components/states/ErrorBoundary'
import { useDisclosure } from '@/hooks/useDisclosure'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { useToast } from '@/components/ui/toast.context'
import { useAuth } from '@/features/auth/useAuth'
import { useDashboardOverview } from '@/features/dashboard/dashboard.hooks'
import {
  useNotificationRealtimeSync,
  useUnreadCount,
} from '@/features/notifications/notifications.hooks'
import { usePendingProofCount } from '@/features/payments'
import { navItemsByPath } from '@/routes/navigation'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'

/**
 * The shell every signed-in page renders inside.
 *
 * It owns three things and no page logic: the navigation drawer's state, the
 * live counts the sidebar badges show, and the application-wide realtime
 * subscriptions — the ones that must run whichever page is open, so that a new
 * order raises a toast while the operator is looking at Inventory.
 */
export function AdminLayout() {
  const { pathname } = useLocation()
  const { can } = useAuth()
  const { toast } = useToast()
  const drawer = useDisclosure()
  const isDesktop = useIsDesktop()

  useDocumentTitle(navItemsByPath.get(pathname)?.label)

  // Every destination in the sidebar is an index; everything else is reached
  // *from* one and is a detail page. That is the same split Shopify draws, and
  // it needs no per-page opt-in to stay right as pages are added.
  const isIndex = navItemsByPath.has(pathname)

  // A route change on a phone must close the drawer, or the new page renders
  // hidden behind it.
  useEffect(() => drawer.close(), [pathname, drawer])

  // At `lg` the sidebar is permanent, so a drawer left open would keep its
  // scrim over an otherwise usable page after a resize.
  useEffect(() => {
    if (isDesktop) drawer.close()
  }, [isDesktop, drawer])

  const unread = useUnreadCount()
  const overview = useDashboardOverview()

  // The server's own count of receipts awaiting review, for the badge.
  const proofsToReview = usePendingProofCount()

  // Every page gets the notification toast, not just the dashboard.
  useNotificationRealtimeSync((payload) => {
    toast({
      tone: 'info',
      title: payload.title,
      ...(payload.body ? { description: payload.body } : {}),
    })
  })

  const counters = overview.data?.counters
  const counts = {
    ...(counters ? { pendingOrders: counters.awaitingFulfillment } : {}),
    ...(counters ? { lowStock: counters.lowStock + counters.outOfStock } : {}),
    ...(unread.data ? { unreadNotifications: unread.data.count } : {}),
    ...(proofsToReview === undefined ? {} : { paymentsToReview: proofsToReview }),
  }

  return (
    // The top bar spans the full width *above* the navigation, rather than
    // sitting beside it. That is what makes the admin read as one product with
    // a search box, instead of a sidebar next to an unrelated page.
    <div className="bg-canvas flex min-h-screen flex-col">
      <Topbar onOpenNav={drawer.open} />

      <div className="flex min-h-0 flex-1">
        <Sidebar counts={counts} isOpen={drawer.isOpen} onClose={drawer.close} />

        <main className="min-w-0 flex-1">
          {/* Keyed on the path so a crash on one page clears when the operator
              navigates away, instead of following them around the admin. */}
          <ErrorBoundary resetKey={pathname}>
            {/* Two widths, the way Shopify has them. A detail page is a column
                of cards and a form: capped at ~1000px, because a label 1600px
                from its field is a worse form. An index page is a table with
                six columns: capped at the same width it loses the last two off
                the right edge, so it gets the window. */}
            <div
              className={
                isIndex
                  ? 'mx-auto w-full max-w-[100rem] px-4 py-5 sm:px-6'
                  : 'mx-auto w-full max-w-[62rem] px-4 py-5 sm:px-6'
              }
            >
              <Outlet context={{ canReadAnalytics: can('analytics:read') }} />
            </div>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
