import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { NotFoundPage } from '@/components/NotFoundPage'
import { SettingsContext, useSettingsQuery } from '@/features/settings/useSettings'
import { AuthProvider } from '@/features/account/AuthProvider'
import { HomePage } from '@/features/catalogue/pages/HomePage'
import { ProductListPage } from '@/features/catalogue/pages/ProductListPage'
import { ProductPage } from '@/features/catalogue/pages/ProductPage'
import { CollectionPage } from '@/features/catalogue/pages/CollectionPage'
import { CartPage } from '@/features/cart/pages/CartPage'
import { CheckoutPage } from '@/features/checkout/pages/CheckoutPage'
import { OrderPage } from '@/features/account/pages/OrderPage'
import { MyOrdersPage } from '@/features/account/pages/MyOrdersPage'
import { MyOrderPage } from '@/features/account/pages/MyOrderPage'
import { OrderLookupPage } from '@/features/account/pages/OrderLookupPage'
import { SignInPage } from '@/features/account/pages/SignInPage'
import { AccountLayout } from '@/features/account/components/AccountLayout'
import { AddressesPage } from '@/features/account/pages/AddressesPage'
import { ProfilePage } from '@/features/account/pages/ProfilePage'
import { SecurityPage } from '@/features/account/pages/SecurityPage'
import { ReturnsPage } from '@/features/account/pages/ReturnsPage'
import { NotificationsPage } from '@/features/account/pages/NotificationsPage'
import { ForgotPasswordPage, ResetPasswordPage } from '@/features/account/pages/PasswordPage'

/**
 * One client for the whole shop.
 *
 * `retry: 1` rather than the default three: a shopper waiting on a page does
 * not want four attempts at a request that is going to fail, and a genuine
 * blip is usually gone by the second.
 *
 * A minute of `staleTime` stops the catalogue being refetched every time
 * somebody switches tabs. The cart and the checkout quote override it to zero,
 * because those are the two things that must never be stale.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <StoreSettings>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/products" element={<ProductListPage />} />
                <Route path="/products/:handle" element={<ProductPage />} />
                <Route path="/collections/:handle" element={<CollectionPage />} />

                <Route path="/cart" element={<CartPage />} />
                <Route path="/checkout" element={<CheckoutPage />} />

                {/* `lookup` before `:id` — otherwise it is matched as an
                    order id. By id, not by order number: the store's number
                    prefix defaults to "#", which in a URL is a fragment. */}
                <Route path="/orders/lookup" element={<OrderLookupPage />} />
                <Route path="/orders/:id" element={<OrderPage />} />

                <Route path="/sign-in" element={<SignInPage />} />
                <Route path="/register" element={<SignInPage mode="register" />} />
                <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                <Route path="/reset-password" element={<ResetPasswordPage />} />

                {/* Every account screen shares one guard and one nav, so
                    "restoring" versus "signed out" is decided in exactly one
                    place rather than repeated per page. */}
                <Route path="/account" element={<AccountLayout />}>
                  <Route index element={<MyOrdersPage />} />
                  <Route path="orders" element={<MyOrdersPage />} />
                  <Route path="orders/:id" element={<MyOrderPage />} />
                  <Route path="returns" element={<ReturnsPage />} />
                  <Route path="addresses" element={<AddressesPage />} />
                  <Route path="details" element={<ProfilePage />} />
                  <Route path="security" element={<SecurityPage />} />
                  <Route path="notifications" element={<NotificationsPage />} />
                </Route>

                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </StoreSettings>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

/**
 * The store's name and currency, fetched once and shared.
 *
 * Deliberately does not block rendering. If settings are slow the shop still
 * draws, with a neutral name in the header, rather than showing a shopper a
 * blank page while it waits for a word.
 */
function StoreSettings({ children }) {
  const { data } = useSettingsQuery()
  return <SettingsContext value={data ?? null}>{children}</SettingsContext>
}
