import {
  BarChart3,
  BadgePercent,
  Bell,
  Boxes,
  CreditCard,
  FileText,
  FolderTree,
  LayoutGrid,
  LayoutDashboard,
  Package,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Truck,
  Undo2,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { Permission } from '@/features/auth/auth.types'

export interface NavItem {
  /** Route path; also the breadcrumb key. */
  to: string
  label: string
  icon: LucideIcon
  /** Hidden unless the operator holds this. The server enforces it regardless. */
  permission?: Permission
  /** Shown in the sidebar as a count — wired to real data, never invented. */
  badge?: 'pendingOrders' | 'lowStock' | 'unreadNotifications'
}

export interface NavSection {
  id: string
  label: string
  items: NavItem[]
}

/**
 * The sidebar, grouped the way a shop actually runs rather than by API surface.
 *
 * "Sell" is the daily queue — what came in and what has to go out. "Catalogue"
 * is what the shop offers. "Grow" is the discretionary work. "Store" is
 * configuration touched rarely. A flat alphabetical list of thirteen entries
 * makes the two an operator opens every morning as hard to find as the one they
 * open twice a year.
 *
 * Every permission below is the one the corresponding server route actually
 * requires — a staff account, which holds neither `analytics:read` nor
 * `discounts:read` nor `settings:read`, will simply not see those entries.
 */
export const navigation: NavSection[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [{ to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    id: 'sell',
    label: 'Sell',
    items: [
      {
        to: '/orders',
        label: 'Orders',
        icon: ShoppingCart,
        permission: 'orders:read',
        badge: 'pendingOrders',
      },
      { to: '/drafts', label: 'Draft orders', icon: FileText, permission: 'orders:read' },
      { to: '/returns', label: 'Returns', icon: Undo2, permission: 'returns:read' },
      { to: '/checkout', label: 'Checkout', icon: ShoppingBag, permission: 'orders:read' },
      { to: '/shipping', label: 'Shipping', icon: Truck, permission: 'shipping:read' },
      { to: '/payments', label: 'Payments', icon: CreditCard, permission: 'payments:read' },
      { to: '/customers', label: 'Customers', icon: Users, permission: 'customers:read' },
    ],
  },
  {
    id: 'catalogue',
    label: 'Catalogue',
    items: [
      { to: '/products', label: 'Products', icon: Package, permission: 'catalog:read' },
      { to: '/categories', label: 'Categories', icon: FolderTree, permission: 'catalog:read' },
      { to: '/collections', label: 'Collections', icon: LayoutGrid, permission: 'catalog:read' },
      {
        to: '/inventory',
        label: 'Inventory',
        icon: Boxes,
        permission: 'inventory:read',
        badge: 'lowStock',
      },
    ],
  },
  {
    id: 'grow',
    label: 'Grow',
    items: [
      { to: '/discounts', label: 'Discounts', icon: BadgePercent, permission: 'discounts:read' },
      { to: '/analytics', label: 'Analytics', icon: BarChart3, permission: 'analytics:read' },
    ],
  },
  {
    id: 'store',
    label: 'Store',
    items: [
      {
        to: '/notifications',
        label: 'Notifications',
        icon: Bell,
        badge: 'unreadNotifications',
      },
      // No permission: the settings section also holds the operator's own
      // account, and everybody has one of those. Each section inside it is
      // guarded separately, and `/settings` lands on the first one they can
      // open rather than on a refusal.
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
]

/** Flat lookup for breadcrumbs and document titles. */
export const navItemsByPath = new Map<string, NavItem>(
  navigation.flatMap((section) => section.items.map((item) => [item.to, item] as const)),
)
