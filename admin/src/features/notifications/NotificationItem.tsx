import {
  AlertTriangle,
  Boxes,
  CreditCard,
  ServerCog,
  ShoppingCart,
  Truck,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatRelativeTime } from '@/lib/format'
import { groupOf, type NotificationDto, type NotificationGroup } from './notifications.types'

const groupStyles: Record<NotificationGroup, { icon: LucideIcon; className: string }> = {
  orders: {
    icon: ShoppingCart,
    className: 'bg-brand-50 text-brand-600 dark:bg-brand-900/50 dark:text-brand-300',
  },
  payments: { icon: CreditCard, className: 'bg-positive-soft text-positive' },
  shipping: { icon: Truck, className: 'bg-info-soft text-info' },
  inventory: { icon: Boxes, className: 'bg-warning-soft text-warning' },
  system: { icon: ServerCog, className: 'bg-surface-sunken text-muted' },
}

/** Types that mean something is wrong, rather than something happened. */
const ALERT_TYPES = new Set(['inventory.out_of_stock', 'job.dead_lettered'])

export interface NotificationItemProps {
  notification: NotificationDto
  onMarkRead?: (id: string) => void
  className?: string
}

export function NotificationItem({ notification, onMarkRead, className }: NotificationItemProps) {
  const group = groupOf(notification.type)
  const isAlert = ALERT_TYPES.has(notification.type)
  const { icon: Icon, className: iconClass } = isAlert
    ? { icon: AlertTriangle, className: 'bg-danger-soft text-danger' }
    : groupStyles[group]

  return (
    <article
      className={cn(
        'flex gap-3 px-3 py-3 transition-colors',
        !notification.read && 'bg-brand-50/60 dark:bg-brand-900/15',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', iconClass)}
      >
        <Icon className="size-4" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-ink text-sm leading-snug font-medium">{notification.title}</p>
        {notification.body ? (
          <p className="text-muted mt-0.5 text-xs leading-relaxed">{notification.body}</p>
        ) : null}
        <time
          dateTime={notification.createdAt}
          title={new Date(notification.createdAt).toLocaleString()}
          className="text-faint mt-1 block text-[0.6875rem]"
        >
          {formatRelativeTime(notification.createdAt)}
        </time>
      </div>

      {!notification.read && onMarkRead ? (
        <button
          type="button"
          onClick={() => onMarkRead(notification.id)}
          aria-label={`Mark "${notification.title}" as read`}
          className="text-brand-600 hover:bg-brand-100 dark:hover:bg-brand-900 h-fit shrink-0 rounded-md px-1.5 py-1 text-[0.6875rem] font-medium transition-colors"
        >
          Mark read
        </button>
      ) : null}
    </article>
  )
}
