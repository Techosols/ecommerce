/**
 * Public surface of the `carts` feature (§2.2).
 *
 * Depends on catalogue and inventory; nothing depends on it except checkout,
 * which converts a resolved cart into an order.
 *
 * Routes are mounted by `router.ts` directly, not re-exported here.
 */
export { cartsService } from './carts.service.js'
export type { CartHandle } from './carts.service.js'
export { cartDto } from './carts.mapper.js'
export type {
  Cart,
  CartItem,
  CartStatus,
  CartTotals,
  ResolvedCart,
  ResolvedCartLine,
} from './carts.types.js'
