import { Navigate, Route, Routes } from 'react-router-dom'
import { AdminLayout } from '@/layouts/AdminLayout'
import { AuthLayout } from '@/layouts/AuthLayout'
import { DashboardPage } from '@/pages/DashboardPage'
import { LoginPage } from '@/pages/LoginPage'
import { AcceptInvitationPage } from '@/pages/AcceptInvitationPage'
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage'
import { ResetPasswordPage } from '@/pages/ResetPasswordPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { NotificationsPage } from '@/pages/NotificationsPage'
import { AnalyticsPage } from '@/features/analytics/pages/AnalyticsPage'
import { PaymentsPage } from '@/features/payments'
import { CartDetailPage } from '@/features/checkout/pages/CartDetailPage'
import { CartListPage } from '@/features/checkout/pages/CartListPage'
import { CheckoutAttemptsPage } from '@/features/checkout/pages/CheckoutAttemptsPage'
import { CheckoutLayout } from '@/features/checkout/pages/CheckoutLayout'
import { DiscountDetailPage } from '@/features/discounts/pages/DiscountDetailPage'
import { DiscountListPage } from '@/features/discounts/pages/DiscountListPage'
import { AccountPage } from '@/features/settings/pages/AccountPage'
import { AuditLogPage } from '@/features/settings/pages/AuditLogPage'
import { EmailsPage } from '@/features/settings/pages/EmailsPage'
import { SettingsLayout } from '@/features/settings/pages/SettingsLayout'
import { StaffPage } from '@/features/settings/pages/StaffPage'
import { StoreSettingsPage } from '@/features/settings/pages/StoreSettingsPage'
import { ShippingPage } from '@/features/shipping/pages/ShippingPage'
import { CodReconciliationPage } from '@/features/shipping/pages/CodReconciliationPage'
import { InventoryItemPage } from '@/features/inventory/pages/InventoryItemPage'
import { InventoryListPage } from '@/features/inventory/pages/InventoryListPage'
import { LocationsPage } from '@/features/inventory/pages/LocationsPage'
import { CustomerDetailPage } from '@/features/customers/pages/CustomerDetailPage'
import { CustomerListPage } from '@/features/customers/pages/CustomerListPage'
import { SegmentsPage } from '@/features/customers/pages/SegmentsPage'
import { DraftBuilderPage } from '@/features/drafts/pages/DraftBuilderPage'
import { DraftListPage } from '@/features/drafts/pages/DraftListPage'
import { OrderDetailPage } from '@/features/orders/pages/OrderDetailPage'
import { OrderListPage } from '@/features/orders/pages/OrderListPage'
import { ReturnDetailPage } from '@/features/returns/pages/ReturnDetailPage'
import { ReturnListPage } from '@/features/returns/pages/ReturnListPage'
import { ProductCreatePage } from '@/features/products/pages/ProductCreatePage'
import { ProductEditPage } from '@/features/products/pages/ProductEditPage'
import { ProductListPage } from '@/features/products/pages/ProductListPage'
import { CategoryListPage } from '@/features/categories/pages/CategoryListPage'
import { CollectionDetailPage } from '@/features/collections/pages/CollectionDetailPage'
import { CollectionListPage } from '@/features/collections/pages/CollectionListPage'
import { ProtectedRoute, PublicOnlyRoute } from './ProtectedRoute'

/**
 * The route table.
 *
 * Declared as elements rather than a data router because every route in this
 * application is guarded by the same three pieces of state and none of them
 * needs a loader: data fetching belongs to the pages, through React Query,
 * where it can be refetched and invalidated by realtime events.
 *
 * The `permission` on each protected route is the one the corresponding server
 * route requires. It hides a page an operator could not use — the server
 * refuses the underlying request either way.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicOnlyRoute />}>
        <Route element={<AuthLayout />}>
          <Route path="/login" element={<LoginPage />} />
          {/* Reached from a link in an email, by somebody who is not signed in
              and — in the invitation's case — has no password to sign in with.
              `PublicOnlyRoute` is right for all three: an operator who is
              already signed in has no business on any of them. */}
          <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Route>
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route element={<AdminLayout />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />

          <Route element={<ProtectedRoute permission="orders:read" />}>
            <Route path="/orders" element={<OrderListPage />} />
            <Route path="/orders/:id" element={<OrderDetailPage />} />
            {/* Drafts are orders that have not been placed, so they share the
                orders permission: seeing one is seeing a sale that may happen.
                Building one needs `orders:write`, which the server enforces
                and the screen reflects. */}
            <Route path="/drafts" element={<DraftListPage />} />
            <Route path="/drafts/:id" element={<DraftBuilderPage />} />
          </Route>
          <Route element={<ProtectedRoute permission="orders:read" />}>
            {/* A basket and a refused checkout are both sales that did not
                happen, so they share a frame. `carts/:id` sits outside the
                tabbed layout because it is a page of its own. */}
            <Route element={<CheckoutLayout />}>
              <Route path="/checkout" element={<CartListPage />} />
              <Route path="/checkout/attempts" element={<CheckoutAttemptsPage />} />
            </Route>
            <Route path="/checkout/carts/:id" element={<CartDetailPage />} />
          </Route>
          <Route element={<ProtectedRoute permission="returns:read" />}>
            <Route path="/returns" element={<ReturnListPage />} />
            <Route path="/returns/:id" element={<ReturnDetailPage />} />
          </Route>
          <Route element={<ProtectedRoute permission="shipping:read" />}>
            <Route path="/shipping" element={<ShippingPage />} />
          </Route>
          <Route element={<ProtectedRoute permission="payments:read" />}>
            <Route path="/payments" element={<PaymentsPage />} />
            {/* Courier statements are money, so they sit behind the payments
                permission rather than the shipping one — the operator who
                reconciles cash is not always the one who prices delivery. */}
            <Route path="/payments/cod" element={<CodReconciliationPage />} />
          </Route>
          <Route element={<ProtectedRoute permission="customers:read" />}>
            <Route path="/customers" element={<CustomerListPage />} />
            {/* `segments` before `:id` — otherwise it is matched as a customer id. */}
            <Route path="/customers/segments" element={<SegmentsPage />} />
            <Route path="/customers/:id" element={<CustomerDetailPage />} />
          </Route>
          <Route element={<ProtectedRoute permission="catalog:read" />}>
            <Route path="/products" element={<ProductListPage />} />
            {/* `new` before `:id` — otherwise "new" is matched as a product id. */}
            <Route element={<ProtectedRoute permission="catalog:write" />}>
              <Route path="/products/new" element={<ProductCreatePage />} />
            </Route>
            <Route path="/products/:id" element={<ProductEditPage />} />
            <Route path="/categories" element={<CategoryListPage />} />
            <Route path="/collections" element={<CollectionListPage />} />
            <Route path="/collections/:id" element={<CollectionDetailPage />} />
          </Route>
          <Route element={<ProtectedRoute permission="inventory:read" />}>
            <Route path="/inventory" element={<InventoryListPage />} />
            {/* `locations` before `:id` — otherwise it is matched as an item id. */}
            <Route path="/inventory/locations" element={<LocationsPage />} />
            <Route path="/inventory/:id" element={<InventoryItemPage />} />
          </Route>
          <Route element={<ProtectedRoute permission="discounts:read" />}>
            <Route path="/discounts" element={<DiscountListPage />} />
            <Route path="/discounts/:id" element={<DiscountDetailPage />} />
          </Route>
          <Route element={<ProtectedRoute permission="analytics:read" />}>
            <Route path="/analytics" element={<AnalyticsPage />} />
          </Route>
          {/* One frame, four sections, four different permissions. `/settings`
              itself is not guarded: an operator who may administer nothing at
              all can still reach their own account. */}
          <Route element={<SettingsLayout />}>
            <Route element={<ProtectedRoute permission="settings:read" />}>
              <Route path="/settings" element={<StoreSettingsPage />} />
              <Route path="/settings/emails" element={<EmailsPage />} />
            </Route>
            <Route element={<ProtectedRoute permission="staff:read" />}>
              <Route path="/settings/staff" element={<StaffPage />} />
            </Route>
            <Route element={<ProtectedRoute permission="audit:read" />}>
              <Route path="/settings/audit" element={<AuditLogPage />} />
            </Route>
            <Route path="/settings/account" element={<AccountPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}
