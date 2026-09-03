/**
 * API versioning and surface routing (§7.1).
 *
 *   /api/v1/auth        credentials and sessions
 *   /api/v1/storefront  public catalogue + customer-scoped resources
 *   /api/v1/admin       staff operations
 *   /api/v1/webhooks    provider callbacks (signature auth, no session)
 *
 * Separating the surfaces is not cosmetic: each gets its own middleware stack,
 * rate limits and, later, its own default authorisation posture. It also makes
 * "can a customer reach this endpoint?" answerable from the URL alone.
 *
 * This file is the composition root: it is the one place allowed to reach past
 * a feature's `index.ts` to mount its routes.
 */
import { Router } from 'express'
import { API_BASE_PATH } from './config/index.js'
import { noCors } from './shared/middleware/security.js'
import { rawBodyJson } from './shared/middleware/rawBody.js'
import { authenticate } from './shared/middleware/authenticate.js'
import { requireStaff } from './shared/middleware/authorize.js'
import {
  adminLimiter,
  authLimiter,
  storefrontLimiter,
  webhookLimiter,
} from './shared/middleware/rateLimit.js'
import { authRoutes } from './features/auth/auth.routes.js'
import { usersAdminRoutes } from './features/users/users.admin.routes.js'
import { settingsStorefrontRoutes } from './features/settings/settings.routes.js'
import { settingsAdminRoutes } from './features/settings/settings.admin.routes.js'
import { mediaAdminRoutes } from './features/media/media.admin.routes.js'
import { auditAdminRoutes } from './features/audit/audit.admin.routes.js'
import { catalogueStorefrontRoutes } from './features/catalogue/catalogue.routes.js'
import { catalogueAdminRoutes } from './features/catalogue/catalogue.admin.routes.js'
import { inventoryAdminRoutes } from './features/inventory/inventory.admin.routes.js'
import { customersStorefrontRoutes } from './features/customers/customers.routes.js'
import { customersAdminRoutes } from './features/customers/customers.admin.routes.js'
import { cartsStorefrontRoutes } from './features/carts/carts.routes.js'
import { cartsAdminRoutes } from './features/carts/carts.admin.routes.js'
import { ordersStorefrontRoutes } from './features/orders/orders.routes.js'
import { ordersAdminRoutes } from './features/orders/orders.admin.routes.js'
import { paymentsAdminRoutes } from './features/payments/payments.admin.routes.js'
import { proofsStorefrontRoutes } from './features/payments/proofs.routes.js'
import { returnsStorefrontRoutes } from './features/returns/returns.routes.js'
import { returnsAdminRoutes } from './features/returns/returns.admin.routes.js'
import { shippingStorefrontRoutes } from './features/shipping/shipping.routes.js'
import { shippingAdminRoutes } from './features/shipping/shipping.admin.routes.js'
import { codAdminRoutes } from './features/shipping/cod.admin.routes.js'
import { discountsStorefrontRoutes } from './features/discounts/discounts.routes.js'
import { discountsAdminRoutes } from './features/discounts/discounts.admin.routes.js'
import {
  notificationsAdminRoutes,
  notificationsStorefrontRoutes,
} from './features/notifications/notifications.routes.js'
import { analyticsStorefrontRoutes } from './features/analytics/analytics.routes.js'
import { analyticsAdminRoutes } from './features/analytics/analytics.admin.routes.js'
import { paymentsWebhookRoutes } from './features/payments/payments.webhook.routes.js'
import { shippingWebhookRoutes } from './features/shipping/shipping.webhook.routes.js'

export const authRouter: Router = Router()
authRouter.use(authLimiter)
authRouter.use(authRoutes)

export const storefrontRouter: Router = Router()
storefrontRouter.use(storefrontLimiter)
// Public, unauthenticated: the storefront needs the store's name, currency and
// branding before anyone has signed in. Only the whitelisted public subset is
// exposed (§23.1).
storefrontRouter.use(settingsStorefrontRoutes)
// Public catalogue: only active products published to this channel are visible,
// and the storefront serializers are written separately from the admin ones.
storefrontRouter.use(catalogueStorefrontRoutes)
// Delivery rates for a destination. Public, because a shopper needs to know what
// postage costs before they have an account — but a quote, not the rate card.
storefrontRouter.use(shippingStorefrontRoutes)
// Write-only analytics beacon. Returns 202 and nothing readable.
storefrontRouter.use(analyticsStorefrontRoutes)
// Cart and checkout: `authenticateOptional()` inside, because a guest may shop
// and buy. Identity comes from the session or a hashed guest cookie, never from
// an id in the URL.
storefrontRouter.use(cartsStorefrontRoutes)
storefrontRouter.use(discountsStorefrontRoutes)
storefrontRouter.use(ordersStorefrontRoutes)
storefrontRouter.use(proofsStorefrontRoutes)
storefrontRouter.use(returnsStorefrontRoutes)
// Account, address book and notifications: every route scoped to the Actor, and
// there is deliberately no `/customers/:id` on this surface at all.
storefrontRouter.use(customersStorefrontRoutes)
storefrontRouter.use(notificationsStorefrontRoutes)

export const adminRouter: Router = Router()
adminRouter.use(adminLimiter)
// Default deny, applied before any admin route is mounted: a new admin route is
// authenticated and staff-only the moment it is added, so forgetting the guard
// is not possible (§6.6 layer 1). Individual routes then add their own
// permission (layer 2).
adminRouter.use(authenticate(), requireStaff())
adminRouter.use(usersAdminRoutes)
adminRouter.use(settingsAdminRoutes)
adminRouter.use(mediaAdminRoutes)
adminRouter.use(catalogueAdminRoutes)
adminRouter.use(inventoryAdminRoutes)
adminRouter.use(customersAdminRoutes)
adminRouter.use(ordersAdminRoutes)
adminRouter.use(paymentsAdminRoutes)
adminRouter.use(cartsAdminRoutes)
adminRouter.use(returnsAdminRoutes)
adminRouter.use(shippingAdminRoutes)
adminRouter.use(codAdminRoutes)
adminRouter.use(discountsAdminRoutes)
adminRouter.use(analyticsAdminRoutes)
// Already authenticated by the stack above, so the notifications router is
// mounted in its "authenticated" form and does not verify the token twice.
adminRouter.use(notificationsAdminRoutes)
adminRouter.use(auditAdminRoutes)

export const webhookRouter: Router = Router()
// Raw body first: a signature is computed over the exact bytes sent (§16.6).
webhookRouter.use(noCors(), webhookLimiter, rawBodyJson())
webhookRouter.use(paymentsWebhookRoutes)
webhookRouter.use(shippingWebhookRoutes)

export function buildApiRouter(): Router {
  const router = Router()
  router.use('/auth', authRouter)
  router.use('/storefront', storefrontRouter)
  router.use('/admin', adminRouter)
  router.use('/webhooks', webhookRouter)
  return router
}

export { API_BASE_PATH }
