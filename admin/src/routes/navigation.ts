import {
  BarChart3,
  BadgePercent,
  Bell,
  CreditCard,
  LayoutDashboard,
  Package,
  Settings,
  ShoppingCart,
  Truck,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { Permission } from '@/features/auth/auth.types'

export type NavBadge = 'pendingOrders' | 'lowStock' | 'unreadNotifications' | 'paymentsToReview'

export interface NavChild {
  /** Route path; also the breadcrumb key. */
  to: string
  label: string
  /** Hidden unless the operator holds this. The server enforces it regardless. */
  permission?: Permission
  /** Shown in the sidebar as a count — wired to real data, never invented. */
  badge?: NavBadge
}

export interface NavItem extends NavChild {
  icon: LucideIcon
  /**
   * Revealed under the parent while that section is open.
   *
   * Only ever one level. Two levels of nesting in a sidebar means an item whose
   * address is three clicks and a memory, and Shopify — which has far more
   * surface than this — never goes past one either.
   */
  children?: NavChild[]
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
        // The three things that are all "an order at some stage of its life".
        // They were four siblings of Orders before, which made the list they
        // belong to invisible and pushed Products off the first screen.
        children: [
          { to: '/drafts', label: 'Draft orders', permission: 'orders:read' },
          { to: '/returns', label: 'Returns', permission: 'returns:read' },
          { to: '/checkout', label: 'Abandoned checkouts', permission: 'orders:read' },
        ],
      },
      {
        to: '/products',
        label: 'Products',
        icon: Package,
        permission: 'catalog:read',
        // How the catalogue is organised, under the thing being organised.
        children: [
          { to: '/categories', label: 'Categories', permission: 'catalog:read' },
          { to: '/collections', label: 'Collections', permission: 'catalog:read' },
          { to: '/inventory', label: 'Inventory', permission: 'inventory:read', badge: 'lowStock' },
        ],
      },
      { to: '/customers', label: 'Customers', icon: Users, permission: 'customers:read' },
      {
        to: '/payments',
        label: 'Payments',
        icon: CreditCard,
        permission: 'payments:read',
        // Receipts a customer sent that nobody has decided about. The one
        // number on this page that means somebody is waiting on the shop.
        badge: 'paymentsToReview',
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
      // Shipping sits here rather than under Sell: it is a set of zones and
      // rates configured once and revisited rarely, which is what everything
      // else in this group has in common.
      { to: '/shipping', label: 'Shipping', icon: Truck, permission: 'shipping:read' },
      // No permission: the settings section also holds the operator's own
      // account, and everybody has one of those. Each section inside it is
      // guarded separately, and `/settings` lands on the first one they can
      // open rather than on a refusal.
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
]

/** Flat lookup for breadcrumbs and document titles. */
export const navItemsByPath = new Map<string, NavChild>(
  navigation.flatMap((section) =>
    section.items.flatMap((item) => [
      [item.to, item] as const,
      ...(item.children ?? []).map((child) => [child.to, child] as const),
    ]),
  ),
)

/**
 * The parent an address belongs under, for deciding which group opens.
 *
 * A child route is not a prefix of its parent — `/returns` says nothing about
 * `/orders` — so the relationship has to be looked up rather than derived.
 */
export const navParentByPath = new Map<string, NavItem>(
  navigation.flatMap((section) =>
    section.items.flatMap((item) =>
      (item.children ?? []).map((child) => [child.to, item] as const),
    ),
  ),
)
