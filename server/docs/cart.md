# Cart Domain Model

## 1. Overview

The cart is a temporary container for purchase intent. It stores what a customer intends to purchase, in the exact configuration they selected, but is never authoritative for prices or availability.

**Critical rules:**
- Never reserve inventory here — reservation is an order-creation operation
- Always recalculate prices from the current product/variant state
- Validate all selections server-side
- Guest carts use opaque tokens, never sequential IDs
- Merging is transactional and deterministic

## 2. Domain Model

```
Customer / Guest
      ↓
   Cart
    ├── id (uuid)
    ├── customer_id (nullable)
    ├── guest_token (opaque, nullable)
    ├── status (active | merged | abandoned)
    │
    └── Cart Items
         ├── id (uuid)
         ├── variant_id (reference)
         ├── quantity
         ├── selected_options (json)
         ├── selected_modifiers (json)
         └── timestamps
```

## 3. Guest Carts

Guest shopping flow:

```
Browse Published Product
      ↓
Select Variant
      ↓
Add to Cart (create guest cart)
      ↓
Modify Cart
      ↓
Sign In
      ↓
Guest Cart Merges into Customer Cart
      ↓
Checkout
```

### Design

- A guest cart is identified by an opaque UUID token (`guest_token`)
- The token is not sequential and cannot be guessed
- A guest cart expires after 30 days of inactivity
- A new guest cart is created per anonymous session
- Multiple guest tokens are allowed; the client maintains one

### Client Storage

The client MUST:
1. Store the `guestToken` from the POST /cart response (typically in localStorage)
2. Pass the `guestToken` in the Authorization header as a Bearer token on subsequent requests
3. Store the `cartId` and include it in the `x-cart-id` header for all cart operations

Example:

```javascript
// Create guest cart
const res = await fetch('/api/v1/storefront/cart', { method: 'POST' });
const { id, guestToken } = await res.json();
localStorage.setItem('guestToken', guestToken);
localStorage.setItem('cartId', id);

// Add to cart
await fetch('/api/v1/storefront/cart/items', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${guestToken}`,
    'x-cart-id': cartId,
  },
  body: JSON.stringify({ variantId: '...', quantity: 1 }),
});
```

## 4. Authenticated Carts

A customer with an authenticated session:

1. Has exactly one active cart per user
2. Cart is linked to `customer_id` in the database
3. Cart persists across login sessions
4. Cart ID is returned in POST /cart response

A customer can:
- Create or fetch their cart
- Add/update/remove items
- Merge their guest cart (on login) into their customer cart

## 5. Cart Items

A cart item represents a specific purchasable configuration:

- **Variant**: The product variant being purchased
- **Quantity**: How many units
- **Selected Options**: The choices made (e.g., `{ "Size": "Large", "Crust": "Thin" }`)
- **Selected Modifiers**: Customizations (e.g., `{ "ExtraCheese": true, "NoOnions": true }`)

### Uniqueness

An item is identified by the combination:
```
(cart_id, variant_id, selected_options, selected_modifiers)
```

This is enforced by a unique constraint in the database. If a customer adds the same variant with the same configuration twice, the quantities merge.

Example:

```javascript
// First add: quantity 2
POST /cart/items { variantId: '123', quantity: 2 }

// Second add: same variant + config
POST /cart/items { variantId: '123', quantity: 3 }

// Result: one item with quantity 5
```

## 6. Server-Side Validation

When adding an item to a cart, the server validates:

- Product exists
- Product is active (status = 'active')
- Variant exists
- Variant is active (`is_active = true`)
- Variant is not archived (`archived_at IS NULL`)
- Variant is published
- Selected options are valid (if the variant has options)
- Selected modifiers are valid
- Requested quantity is valid (1 to 1,000,000)

The server **never** trusts:
- Product name
- Variant name
- Price
- Totals
- Availability
- Any data beyond the variant ID and quantity

## 7. Pricing

### Live Recalculation

Cart totals are computed **every time the cart is read**, never cached. This ensures:

- Price changes are immediately reflected
- Catalogue and cart never diverge
- Stale data is impossible

### Calculation

Per cart item:
```
unit_price = variant.price_amount
line_total = unit_price × quantity

cart_subtotal = SUM(line_total for each item)
cart_total = subtotal + discounts + fees + taxes
```

Prices use integer arithmetic (minor currency units). There is no floating-point.

### Price Verification

A client may request pricing BEFORE adding to cart:

```javascript
// Future: GET /storefront/products/:id/pricing
// Would return estimated totals with current prices
```

But the server always recomputes at every step.

## 8. Inventory Integration

### Important: No Reservation

Adding items to a cart does **not** reserve inventory. Inventory rules:

- **Cart validation**: "Is this variant available?" (advisory)
- **Cart addition**: Variant must be active; no stock check
- **Checkout**: "Can I reserve this quantity?" (mandatory)
- **Order creation**: Reserve inventory transactionally

If a cart contains more stock than is available, checkout will fail with `INSUFFICIENT_STOCK`. This is acceptable: the customer is informed at checkout time.

### Why No Cart Reservation

Reserving on add-to-cart:
1. Lets one shopper deny inventory to everyone by filling a cart
2. Requires an expiry mechanism for something that isn't a commitment
3. Complicates the merge process (released reservation + new reservation)

## 9. Guest → Customer Merge

When a guest logs in, their cart is merged into their customer cart.

### Merge Algorithm

For each guest cart item:

1. **No match in customer cart**: Transfer the item
2. **Matching item exists**: Add quantities (subject to max)
3. **Conflict detected**: Log it; the merge continues

Example:

```
Guest cart:
  - Burger (Single): qty 2

Customer cart:
  - Burger (Single): qty 1

Result:
  - Burger (Single): qty 3
  Conflict logged: { variantId, guestQuantity: 2, customerQuantity: 1, resulting: 3 }
```

### Transaction Safety

The merge is transactional:
- All items transfer in one transaction
- If any item fails, the entire merge rolls back
- The guest cart is marked as `status = 'merged'` only after success

## 10. Cart Expiration

### Lifetime

- Default: 30 days
- Extended: every time the cart is modified (add, update, remove, clear)

### Cleanup

A nightly job (`cleanup.expired_carts`) marks expired carts as abandoned.

```
cleanup.expired_carts:
  SELECT carts WHERE status = 'active' AND expires_at < now()
  UPDATE status = 'abandoned'
  PUBLISH cart.expired event
```

## 11. API Surface

### Storefront (Customer + Guest)

```
POST   /storefront/cart                 # Create guest cart or fetch customer cart
GET    /storefront/cart                 # Retrieve current cart
POST   /storefront/cart/items           # Add item (or merge quantity)
PATCH  /storefront/cart/items/:id       # Update item quantity
DELETE /storefront/cart/items/:id       # Remove item
DELETE /storefront/cart                 # Clear all items
```

### Authentication

**Guest Access:**
- No Authorization header for cart creation
- Bearer token (guestToken) for all subsequent requests
- Include `x-cart-id` header with cart ID

**Customer Access:**
- Bearer token (JWT access token) from login
- Include `x-cart-id` header with cart ID

### Response Format

```json
{
  "id": "uuid",
  "guestToken": "uuid (guests only)",
  "items": [
    {
      "id": "uuid",
      "variant": {
        "id": "uuid",
        "title": "Default",
        "sku": "ABC-123"
      },
      "quantity": 2,
      "selectedOptions": { "Size": "Large" },
      "selectedModifiers": { "ExtraCheese": true },
      "unitPrice": { "amount": 599, "currency": "USD" },
      "lineTotal": { "amount": 1198, "currency": "USD" }
    }
  ],
  "itemCount": 1,
  "subtotal": { "amount": 1198, "currency": "USD" },
  "discount": { "amount": 0, "currency": "USD" },
  "fees": { "amount": 0, "currency": "USD" },
  "total": { "amount": 1198, "currency": "USD" },
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

## 12. Events Published

```
cart.created              # New cart created
cart.item_added           # Item added (or quantity merged)
cart.item_updated         # Item quantity changed
cart.item_removed         # Item removed
cart.cleared              # All items cleared
cart.merged               # Guest cart merged into customer cart
cart.expired              # Cart marked abandoned (cleanup job)
```

## 13. Security Considerations

### IDOR (Insecure Direct Object Reference)

- **Customer**: Can only access their own cart (verified by `customer_id`)
- **Guest**: Can only access their cart (verified by `guest_token`)
- The server enforces access control; the client cannot override

### Token Exposure

- Guest tokens are opaque UUIDs; they cannot be sequentially guessed
- Guest tokens are never logged (they're not passwords, but treating them similarly)
- Guest tokens expire after 30 days

### Price Manipulation

- Client-provided prices are ignored; server recalculates
- Totals are never trusted from the client

### Inventory Enumeration

- Adding a non-existent variant returns 404, which is fine (variant IDs are UUIDs, not sequential)
- Adding an archived variant returns 422 (no longer available)
- The error does not reveal whether the variant existed

### Concurrency

Two carts updates at the same time:
```
Customer adds Burger at 10:00:00.001
Customer updates quantity at 10:00:00.002
Result: Last write wins (quantity update overrides the add)
```

For the cart, this is acceptable. Inventory operations use row-level locks; carts do not.

## 14. Testing Strategy

### Unit Tests
- Pricing calculations
- Configuration uniqueness
- Event publishing

### Integration Tests
- Guest cart creation and operations
- Customer cart creation and operations
- Guest → customer merge
- Server-side validation (all edge cases)
- Pricing recalculation on product changes
- IDOR prevention
- Concurrency (simultaneous modifications)

### End-to-End Flow
```
Guest browsing
→ Create guest cart
→ Add multiple items with options/modifiers
→ Update quantities
→ Sign in (merge carts)
→ Verify customer cart contains guest items
→ Proceed to checkout
```

## 15. Future Enhancements

1. **Discounts**: Apply coupons, quantity discounts, promotional codes
2. **Taxes**: Calculate sales tax based on customer location
3. **Shipping**: Estimate shipping cost based on cart contents and address
4. **Wishlist**: Save items for later
5. **Cart Recovery**: Email abandoned carts
6. **Recommendations**: Suggest related products
7. **Reserved Stock**: Time-limited reservations for high-demand items
8. **Analytics**: Track add-to-cart events, abandonment, conversion

## 16. Checkout Boundary

The cart is **not** an order. When checkout begins:

```
Cart                    ← temporary, always recomputed
    ↓
Checkout Service        ← validates everything
    ↓
Order                   ← immutable snapshot, reservations, payment
```

The checkout service will:
1. Verify all items still exist and are available
2. Recalculate prices one final time
3. Reserve inventory transactionally
4. Create the order
5. Initiate payment processing

If step 2 fails (price changed dramatically), the user is notified and cart is returned.
If step 3 fails (insufficient stock), checkout fails with `INSUFFICIENT_STOCK`.
