/**
 * Cart API (§9.3, docs/cart.md).
 *
 * Public, storefront routes for managing carts.
 * Both guest and authenticated access are supported.
 *
 * Guest access uses an opaque token passed in Authorization header.
 * Authenticated access uses JWT (extracted by middleware).
 */

import { Router, type Request, type Response } from 'express'
import type { z } from 'zod'
import { ok, created } from '../../shared/http/respond.js'
import { validate } from '../../shared/middleware/validate.js'
import { NotFoundError, AuthorizationError } from '../../shared/errors/index.js'
import { cartService } from './cart.service.js'
import { storefrontCartDto } from './cart.mapper.js'
import { addToCartSchema, updateCartItemSchema, cartItemIdParam } from './cart.validators.js'

export const cartRoutes = Router()

/**
 * Extract cart authorization context from the request.
 * Returns { guestToken } or { customerId } or null if unauthorized.
 */
function getCartContext(req: Request): { guestToken?: string; customerId?: string } | null {
  // For authenticated users, use their userId
  if (req.actor) {
    return { customerId: req.actor.userId }
  }

  // For guests, extract the guest token from the Authorization header
  // Format: "Bearer <guest-token>"
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    if (token) {
      return { guestToken: token }
    }
  }

  return null
}

/**
 * GET /cart
 *
 * Retrieve the current cart. Works for both guest and authenticated users.
 * For guests, requires the guest token in the Authorization header.
 */
cartRoutes.get('/cart', async (req: Request, res: Response) => {
  const context = getCartContext(req)
  if (!context) {
    throw new AuthorizationError('Invalid or missing authorization')
  }

  // For guests, the cartId is not yet known; we need to fetch it from a cookie or local storage
  // For now, we'll require it to be passed in a header or cookie
  const cartId = (req.headers['x-cart-id'] as string) || req.cookies?.['cart_id']
  if (!cartId) {
    throw new NotFoundError('No cart found')
  }

  const cart = await cartService.getCart({ cartId, ...context })
  if (!cart) {
    throw new NotFoundError('Cart not found or unauthorized')
  }

  return ok(res, storefrontCartDto(cart))
})

/**
 * POST /cart
 *
 * Create a new cart.
 * For guests: creates a guest cart and returns the guest token.
 * For authenticated users: creates or returns their customer cart.
 */
cartRoutes.post('/cart', async (req: Request, res: Response) => {
  let cart
  let guestToken: string | undefined

  if (req.actor) {
    // Create/fetch customer cart
    const record = await cartService.ensureCustomerCart(req.actor.userId)
    cart = await cartService.getCart({ cartId: record.id, customerId: req.actor.userId })
  } else {
    // Create guest cart
    const newCart = await cartService.createGuestCart()
    guestToken = newCart.guestToken
    cart = await cartService.getCart({ cartId: newCart.id, guestToken })
  }

  if (!cart) {
    throw new Error('Failed to fetch cart after creation')
  }

  const response = storefrontCartDto(cart)
  if (guestToken) {
    return created(res, { ...response, guestToken }, '/api/v1/cart')
  }
  return created(res, response, '/api/v1/cart')
})

/**
 * POST /cart/items
 *
 * Add an item to the cart (or merge quantity if it already exists).
 */
cartRoutes.post(
  '/cart/items',
  validate({ body: addToCartSchema }),
  async (req: Request, res: Response) => {
    const context = getCartContext(req)
    if (!context) {
      throw new AuthorizationError('Invalid or missing authorization')
    }

    const cartId = (req.headers['x-cart-id'] as string) || req.cookies?.['cart_id']
    if (!cartId) {
      throw new NotFoundError('No cart found')
    }

    const cart = await cartService.addToCart({
      cartId,
      item: req.body as z.infer<typeof addToCartSchema>,
      ...context,
    })

    if (!cart) {
      throw new NotFoundError('Cart not found or unauthorized')
    }

    return ok(res, storefrontCartDto(cart))
  },
)

/**
 * PATCH /cart/items/:id
 *
 * Update a cart item's quantity.
 */
cartRoutes.patch(
  '/cart/items/:id',
  validate({ params: cartItemIdParam, body: updateCartItemSchema }),
  async (req: Request, res: Response) => {
    const context = getCartContext(req)
    if (!context) {
      throw new AuthorizationError('Invalid or missing authorization')
    }

    const cartId = (req.headers['x-cart-id'] as string) || req.cookies?.['cart_id']
    if (!cartId) {
      throw new NotFoundError('No cart found')
    }

    const itemId = req.params.id as string
    if (!itemId) {
      throw new NotFoundError('Item ID is required')
    }

    const cart = await cartService.updateCartItem({
      cartId,
      itemId,
      quantity: (req.body as z.infer<typeof updateCartItemSchema>).quantity,
      ...context,
    })

    if (!cart) {
      throw new NotFoundError('Cart not found or unauthorized')
    }

    return ok(res, storefrontCartDto(cart))
  },
)

/**
 * DELETE /cart/items/:id
 *
 * Remove an item from the cart.
 */
cartRoutes.delete(
  '/cart/items/:id',
  validate({ params: cartItemIdParam }),
  async (req: Request, res: Response) => {
    const context = getCartContext(req)
    if (!context) {
      throw new AuthorizationError('Invalid or missing authorization')
    }

    const cartId = (req.headers['x-cart-id'] as string) || req.cookies?.['cart_id']
    if (!cartId) {
      throw new NotFoundError('No cart found')
    }

    const itemId = req.params.id as string
    if (!itemId) {
      throw new NotFoundError('Item ID is required')
    }

    const cart = await cartService.removeFromCart({
      cartId,
      itemId,
      ...context,
    })

    if (!cart) {
      throw new NotFoundError('Cart not found or unauthorized')
    }

    return ok(res, storefrontCartDto(cart))
  },
)

/**
 * DELETE /cart
 *
 * Clear all items from the cart.
 */
cartRoutes.delete('/cart', async (req: Request, res: Response) => {
  const context = getCartContext(req)
  if (!context) {
    throw new AuthorizationError('Invalid or missing authorization')
  }

  const cartId = (req.headers['x-cart-id'] as string) || req.cookies?.['cart_id']
  if (!cartId) {
    throw new NotFoundError('No cart found')
  }

  const cart = await cartService.clearCart({
    cartId,
    ...context,
  })

  if (!cart) {
    throw new NotFoundError('Cart not found or unauthorized')
  }

  return ok(res, storefrontCartDto(cart))
})
