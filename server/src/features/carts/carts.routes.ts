/**
 * Cart (§7.1, CLAUDE.md §2 `client/`).
 *
 * There is one cart route shape — `/cart` — and never `/carts/:id`. The caller
 * is identified by their session or by a guest cookie, so a cart id in a URL is
 * not a way to reach somebody else's basket.
 *
 * The guest cookie is httpOnly and holds a random 32-byte token whose hash is
 * what the database stores, exactly like a refresh token (§6.2).
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { created, ok } from '../../shared/http/respond.js'
import { validate } from '../../shared/middleware/validate.js'
import { authenticateOptional } from '../../shared/middleware/authenticate.js'
import { env, isProduction } from '../../config/index.js'
import { cartsService } from './carts.service.js'
import { cartDto } from './carts.mapper.js'
import { addItemSchema, setQuantitySchema, variantParam } from './carts.validators.js'

export const CART_COOKIE_NAME = 'cart_token'
const CART_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function setCartCookie(res: Response, token: string): void {
  res.cookie(CART_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: env.AUTH_COOKIE_SAMESITE,
    path: '/',
    maxAge: CART_COOKIE_MAX_AGE_MS,
  })
}

/**
 * Resolves the caller's cart, creating one on first touch and setting the
 * guest cookie if they are not signed in.
 *
 * `authenticateOptional()` runs ahead of these routes, so a signed-in customer
 * gets their own cart and everyone else gets a guest one.
 */
async function currentCart(req: Request, res: Response) {
  const customerId = req.actor?.userId ?? null
  const anonymousToken = (req.cookies?.[CART_COOKIE_NAME] as string | undefined) ?? null

  // Signing in claims whatever was in the guest basket, so nothing is lost at
  // the moment someone logs in to check out.
  if (customerId && anonymousToken) {
    const cart = await cartsService.claimForCustomer(anonymousToken, customerId)
    res.clearCookie(CART_COOKIE_NAME, { path: '/' })
    return cart
  }

  const handle = await cartsService.resolveOrCreate({ customerId, anonymousToken })
  if (handle.anonymousToken) setCartCookie(res, handle.anonymousToken)
  return handle.cart
}

export const cartsStorefrontRoutes: ExpressRouter = Router()

// Optional authentication: a cart works signed in or not.
cartsStorefrontRoutes.use('/cart', authenticateOptional())

cartsStorefrontRoutes.get('/cart', async (req: Request, res: Response) => {
  const cart = await currentCart(req, res)
  return ok(res, cartDto(await cartsService.resolve(cart.id)))
})

cartsStorefrontRoutes.post(
  '/cart/items',
  validate({ body: addItemSchema }),
  async (req: Request, res: Response) => {
    const cart = await currentCart(req, res)
    const { variantId, quantity } = req.body as z.infer<typeof addItemSchema>
    const resolved = await cartsService.addItem(cart.id, variantId, quantity)
    return created(res, cartDto(resolved))
  },
)

cartsStorefrontRoutes.patch(
  '/cart/items/:variantId',
  validate({ params: variantParam, body: setQuantitySchema }),
  async (req: Request, res: Response) => {
    const cart = await currentCart(req, res)
    const { quantity } = req.body as z.infer<typeof setQuantitySchema>
    const resolved = await cartsService.setItemQuantity(
      cart.id,
      req.params.variantId as string,
      quantity,
    )
    return ok(res, cartDto(resolved))
  },
)

cartsStorefrontRoutes.delete(
  '/cart/items/:variantId',
  validate({ params: variantParam }),
  async (req: Request, res: Response) => {
    const cart = await currentCart(req, res)
    const resolved = await cartsService.removeItem(cart.id, req.params.variantId as string)
    return ok(res, cartDto(resolved))
  },
)

cartsStorefrontRoutes.delete('/cart', async (req: Request, res: Response) => {
  const cart = await currentCart(req, res)
  return ok(res, cartDto(await cartsService.clear(cart.id)))
})
