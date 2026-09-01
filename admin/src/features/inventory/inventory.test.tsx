import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { renderAuthed } from '@/test/renderAuthed'
import {
  adminUser,
  inventoryItem,
  inventoryRow,
  staffUser,
  stockLocation,
  stockMovement,
  stockReservation,
} from '@/test/catalogue'
import { InventoryItemPage } from './pages/InventoryItemPage'
import { InventoryListPage } from './pages/InventoryListPage'
import { LocationsPage } from './pages/LocationsPage'

/**
 * Inventory.
 *
 * Three things these tests exist to hold down, because each of them is a way a
 * stock screen quietly lies:
 *
 *   • **Untracked is not zero.** An item that is not counted is unconditionally
 *     sellable. A list that renders it as `0` tells staff the opposite of the
 *     truth.
 *   • **A count is not a delta.** The stocktake dialog sends the number counted
 *     and lets the server work out the correction. If the browser ever does
 *     that subtraction, a count taken against a figure that was stale when the
 *     page rendered becomes the wrong movement.
 *   • **Nothing is destroyed quietly.** Archiving a location, like every other
 *     removal in this admin, says what it does before it does it.
 */

let api: ApiMock

const locations = [
  stockLocation(),
  stockLocation({ id: 'loc-2', code: 'camden', name: 'Camden shop', isDefault: false }),
]

/**
 * `apiMock` matches by substring in registration order, so `/admin/inventory`
 * swallows `/admin/inventory/items/inv-1/history`. Everything narrower than the
 * list has to be registered before it.
 */
function baseRoutes(mock: ApiMock, user = adminUser) {
  return mock
    .withSession(user)
    .on('GET', '/storefront/settings', { currency: 'GBP', storeName: 'Test' })
    .on('GET', '/admin/notifications/unread-count', { count: 0 })
    .on('GET', '/admin/locations', locations)
}

beforeEach(() => {
  api = apiMock().install()
  tokenStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  tokenStore.clear()
})

// ── The list ────────────────────────────────────────────────────────────────

describe('InventoryListPage', () => {
  function listRoutes(mock: ApiMock, rows = [inventoryRow()], user = adminUser) {
    return baseRoutes(mock, user).onList('/admin/inventory', rows)
  }

  it('shows all three numbers, because one of them is never enough', async () => {
    listRoutes(api)
    await renderAuthed(<InventoryListPage />, { route: '/inventory' })

    const row = within(await screen.findByRole('row', { name: /Classic Burger/ }))
    expect(row.getByText('20')).toBeInTheDocument() // on the shelf
    expect(row.getByText('2')).toBeInTheDocument() // spoken for
    expect(row.getByText('18')).toBeInTheDocument() // sellable
    expect(row.getByText('BURG-1', { exact: false })).toBeInTheDocument()
  })

  it('says an untracked item is always available, not that it has none', async () => {
    listRoutes(api, [
      inventoryRow({
        id: 'inv-2',
        productTitle: 'Made to order cake',
        trackInventory: false,
        totals: { onHand: 0, reserved: 0, available: 0 },
      }),
    ])
    await renderAuthed(<InventoryListPage />, { route: '/inventory' })

    const row = within(await screen.findByRole('row', { name: /Made to order cake/ }))
    expect(row.getByText('Always')).toBeInTheDocument()
    expect(row.getByText('Untracked')).toBeInTheDocument()
    expect(row.queryByText('0')).not.toBeInTheDocument()
  })

  it('marks low and out separately, on the server’s reckoning', async () => {
    listRoutes(api, [
      inventoryRow({ id: 'inv-2', productTitle: 'Nearly gone', isLow: true, totals: { onHand: 3, reserved: 0, available: 3 } }),
      inventoryRow({ id: 'inv-3', productTitle: 'All gone', isLow: true, totals: { onHand: 2, reserved: 2, available: 0 } }),
    ])
    await renderAuthed(<InventoryListPage />, { route: '/inventory' })

    const low = within(await screen.findByRole('row', { name: /Nearly gone/ }))
    expect(low.getByText('Low')).toBeInTheDocument()

    // Reserved down to nothing is out of stock, even with two on the shelf.
    const out = within(screen.getByRole('row', { name: /All gone/ }))
    expect(out.getByText('Out of stock')).toBeInTheDocument()
  })

  it('sends the search and the filters to the server rather than sifting here', async () => {
    const user = userEvent.setup()
    listRoutes(api)
    await renderAuthed(<InventoryListPage />, { route: '/inventory' })
    await screen.findByText('Classic Burger')

    await user.type(screen.getByLabelText('Search stock'), 'burg')
    await user.selectOptions(screen.getByLabelText('Location'), 'loc-2')
    await user.selectOptions(screen.getByLabelText('Stock level'), 'low')
    await user.selectOptions(screen.getByLabelText('Tracking'), 'false')

    await waitFor(() => {
      const last = api.callsTo('GET', '/admin/inventory').at(-1)!
      expect(last.url).toContain('q=burg')
      expect(last.url).toContain('locationId=loc-2')
      expect(last.url).toContain('low=true')
      expect(last.url).toContain('tracked=false')
    })
  })

  it('explains that a location narrows the quantities, not the rows', async () => {
    const user = userEvent.setup()
    listRoutes(api)
    await renderAuthed(<InventoryListPage />, { route: '/inventory' })
    await screen.findByText('Classic Burger')

    await user.selectOptions(screen.getByLabelText('Location'), 'loc-2')

    expect(await screen.findByText(/Items held elsewhere still appear, at zero/)).toBeInTheDocument()
  })
})

// ── One item ────────────────────────────────────────────────────────────────

describe('InventoryItemPage', () => {
  const route = { route: '/inventory/inv-1', path: '/inventory/:id' }

  function itemRoutes(mock: ApiMock, item = inventoryItem(), user = adminUser) {
    return baseRoutes(
      mock
        .on('GET', '/admin/inventory/items/inv-1/reservations', [stockReservation()])
        .onList('/admin/inventory/items/inv-1/history', [stockMovement()])
        .on('GET', '/admin/inventory/items/inv-1', item),
      user,
    )
  }

  it('names what it is counting, and links to the product not the variant', async () => {
    itemRoutes(api)
    await renderAuthed(<InventoryItemPage />, route)

    expect(await screen.findByRole('heading', { name: 'Classic Burger' })).toBeInTheDocument()
    expect(screen.getByText(/Brioche · BURG-1/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the product' })).toHaveAttribute(
      'href',
      '/products/prod-1',
    )
  })

  it('breaks the totals down by location', async () => {
    itemRoutes(api)
    await renderAuthed(<InventoryItemPage />, route)

    expect(await screen.findByText('Main stockroom')).toBeInTheDocument()
    expect(screen.getByText(/20 on hand · 2 reserved/)).toBeInTheDocument()
  })

  it('names the order holding stock, so the reserved figure is explainable', async () => {
    itemRoutes(api)
    await renderAuthed(<InventoryItemPage />, route)

    expect(await screen.findByRole('link', { name: '#1042' })).toHaveAttribute(
      'href',
      '/orders/ord-1',
    )
  })

  it('shows both halves of a movement, so a reservation is not rendered as nothing', async () => {
    itemRoutes(
      api.onList('/admin/inventory/items/inv-1/history', [
        stockMovement({
          id: 'mov-2',
          reason: 'reservation',
          delta: { onHand: 0, reserved: 2 },
          resulting: { onHand: 20, reserved: 2 },
        }),
      ]),
    )
    await renderAuthed(<InventoryItemPage />, route)

    // Scoped to the ledger: "Reserved" is also one of the three totals above it.
    await screen.findByText(/→ 20 on hand/)
    const ledger = within(
      screen.getAllByRole('list').find((element) => element.tagName === 'OL')!,
    )
    expect(ledger.getByText('Reserved')).toBeInTheDocument()
    expect(ledger.getByText('+2')).toBeInTheDocument()
    // On hand did not move, and the row says so rather than omitting it.
    expect(ledger.getByText('—')).toBeInTheDocument()
    expect(ledger.getByText(/→ 20 on hand/)).toBeInTheDocument()
  })

  it('says an untracked item is always sellable and offers no movements', async () => {
    itemRoutes(api, inventoryItem({ trackInventory: false, levels: [] }))
    await renderAuthed(<InventoryItemPage />, route)

    expect(await screen.findByText(/It is always available to buy/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Adjust' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Count' })).not.toBeInTheDocument()
  })

  it('distinguishes a blank threshold from a zero one', async () => {
    itemRoutes(api)
    await renderAuthed(<InventoryItemPage />, route)

    expect(await screen.findByText(/Using the store default of 5/)).toBeInTheDocument()
  })

  it('lets an operator who can only look, only look', async () => {
    itemRoutes(api, inventoryItem(), staffUser)
    await renderAuthed(<InventoryItemPage />, route)

    await screen.findByRole('heading', { name: 'Classic Burger' })
    expect(screen.queryByRole('button', { name: 'Adjust' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Count stock')).toBeDisabled()
  })
})

// ── Moving stock ────────────────────────────────────────────────────────────

describe('StockMoveDialog', () => {
  const route = { route: '/inventory/inv-1', path: '/inventory/:id' }

  function movementRoutes(mock: ApiMock) {
    return baseRoutes(
      mock
        .on('GET', '/admin/inventory/items/inv-1/reservations', [])
        .onList('/admin/inventory/items/inv-1/history', [])
        .on('GET', '/admin/inventory/items/inv-1', inventoryItem())
        .on('POST', '/admin/inventory/adjustments', {
          inventoryItemId: 'inv-1',
          onHand: 18,
          reserved: 2,
          available: 16,
        })
        .on('POST', '/admin/inventory/stocktake', {
          inventoryItemId: 'inv-1',
          onHand: 17,
          reserved: 2,
          available: 15,
        })
        .on('POST', '/admin/inventory/transfers', { from: {}, to: {} }),
    )
  }

  async function open(kind: 'Adjust' | 'Count' | 'Transfer') {
    const user = userEvent.setup()
    movementRoutes(api)
    await renderAuthed(<InventoryItemPage />, route)
    await screen.findByRole('heading', { name: 'Classic Burger' })
    await user.click(screen.getByRole('button', { name: kind }))
    return user
  }

  it('sends a signed delta and a reason when stock is adjusted', async () => {
    const user = await open('Adjust')

    await user.selectOptions(screen.getByLabelText('Direction'), 'out')
    await user.type(screen.getByLabelText(/^Quantity/), '2')
    await user.selectOptions(screen.getByLabelText(/^Reason/), 'damage')
    await user.click(screen.getByRole('button', { name: 'Adjust stock' }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/admin/inventory/adjustments')).toHaveLength(1)
    })
    expect(api.callsTo('POST', '/admin/inventory/adjustments')[0]!.body).toMatchObject({
      inventoryItemId: 'inv-1',
      delta: -2,
      reason: 'damage',
    })
  })

  it('never offers a reason only the system may write', async () => {
    await open('Adjust')

    const reason = screen.getByLabelText(/^Reason/)
    expect(within(reason).queryByText('Reserved')).not.toBeInTheDocument()
    expect(within(reason).queryByText('Sold')).not.toBeInTheDocument()
    // Nor stocktake: a count is its own endpoint, not a reason on an adjustment.
    expect(within(reason).queryByText('Stock count')).not.toBeInTheDocument()
  })

  it('sends what was counted, never a delta', async () => {
    const user = await open('Count')

    await user.type(screen.getByLabelText(/^Counted on hand/), '17')
    await user.click(screen.getByRole('button', { name: 'Record count' }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/admin/inventory/stocktake')).toHaveLength(1)
    })
    const body = api.callsTo('POST', '/admin/inventory/stocktake')[0]!.body as Record<string, unknown>
    expect(body).toMatchObject({ inventoryItemId: 'inv-1', countedOnHand: 17 })
    expect(body).not.toHaveProperty('delta')
  })

  it('shows the correction a count implies without computing the movement', async () => {
    const user = await open('Count')

    // No location chosen: the default is what the server will use, so it is
    // what the comparison has to resolve to.
    await user.type(screen.getByLabelText(/^Counted on hand/), '17')

    expect(await screen.findByText(/Main stockroom currently holds 20/)).toBeInTheDocument()
    expect(screen.getByText(/corrects it by −3/)).toBeInTheDocument()
    expect(api.callsTo('POST', '/admin/inventory/stocktake')).toHaveLength(0)
  })

  it('accepts a count of zero, which is a real answer', async () => {
    const user = await open('Count')

    await user.type(screen.getByLabelText(/^Counted on hand/), '0')
    expect(screen.getByRole('button', { name: 'Record count' })).toBeEnabled()
  })

  it('refuses a transfer to the same place it came from', async () => {
    const user = await open('Transfer')

    await user.selectOptions(screen.getByLabelText('From'), 'loc-1')
    // The destination cannot even offer the origin.
    const to = screen.getByLabelText('To')
    expect(within(to).queryByText('Main stockroom')).not.toBeInTheDocument()

    await user.selectOptions(to, 'loc-2')
    await user.type(screen.getByLabelText(/^Quantity/), '4')
    // Scoped: the page header offers a "Transfer" button of its own.
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Transfer' }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/admin/inventory/transfers')).toHaveLength(1)
    })
    expect(api.callsTo('POST', '/admin/inventory/transfers')[0]!.body).toMatchObject({
      fromLocationId: 'loc-1',
      toLocationId: 'loc-2',
      quantity: 4,
    })
  })

  it('keeps the operator on the dialog when the server refuses', async () => {
    const user = userEvent.setup()
    // Registered before the happy path: the mock matches in declaration order.
    api.onError(
      'POST',
      '/admin/inventory/adjustments',
      409,
      'INSUFFICIENT_STOCK',
      'Only 18 available at Main stockroom.',
    )
    movementRoutes(api)

    await renderAuthed(<InventoryItemPage />, route)
    await screen.findByRole('heading', { name: 'Classic Burger' })
    await user.click(screen.getByRole('button', { name: 'Adjust' }))
    await user.type(screen.getByLabelText(/^Quantity/), '99')
    await user.click(screen.getByRole('button', { name: 'Adjust stock' }))

    expect(await screen.findByText(/Only 18 available/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Adjust stock' })).toBeInTheDocument()
  })
})

// ── Locations ───────────────────────────────────────────────────────────────

describe('LocationsPage', () => {
  it('marks the default, and does not offer to archive it', async () => {
    baseRoutes(api)
    await renderAuthed(<LocationsPage />, { route: '/inventory/locations' })

    expect(await screen.findByText('Main stockroom')).toBeInTheDocument()
    expect(screen.getByText('Default')).toBeInTheDocument()
    // One archive button, on the location that is not the default.
    expect(screen.getAllByRole('button', { name: /Archive/ })).toHaveLength(1)
  })

  it('says what archiving costs before doing it', async () => {
    const user = userEvent.setup()
    baseRoutes(api)
    await renderAuthed(<LocationsPage />, { route: '/inventory/locations' })
    await screen.findByText('Camden shop')

    await user.click(screen.getByRole('button', { name: /Archive/ }))

    expect(await screen.findByText('Archive "Camden shop"?')).toBeInTheDocument()
    expect(screen.getByText(/refuses if anything is still held there/)).toBeInTheDocument()
    expect(api.callsTo('DELETE', '/admin/locations')).toHaveLength(0)
  })

  it('warns that making a new default moves the role off the old one', async () => {
    const user = userEvent.setup()
    baseRoutes(api)
    await renderAuthed(<LocationsPage />, { route: '/inventory/locations' })
    await screen.findByText('Main stockroom')

    await user.click(screen.getByRole('button', { name: 'New location' }))
    await user.click(screen.getByLabelText('Default location'))

    expect(await screen.findByText(/moves that role off whichever location holds it now/)).toBeInTheDocument()
  })

  it('creates a location with what was typed', async () => {
    const user = userEvent.setup()
    baseRoutes(api).on('POST', '/admin/locations', stockLocation({ id: 'loc-3' }))
    await renderAuthed(<LocationsPage />, { route: '/inventory/locations' })
    await screen.findByText('Main stockroom')

    await user.click(screen.getByRole('button', { name: 'New location' }))
    await user.type(screen.getByLabelText(/^Name/), 'Dalston kiosk')
    await user.type(screen.getByLabelText(/^Code/), 'dalston')
    await user.click(screen.getByRole('button', { name: 'Create location' }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/admin/locations')).toHaveLength(1)
    })
    expect(api.callsTo('POST', '/admin/locations')[0]!.body).toMatchObject({
      name: 'Dalston kiosk',
      code: 'dalston',
      isDefault: false,
    })
  })

  it('hides every write from an operator who cannot make one', async () => {
    baseRoutes(api, staffUser)
    await renderAuthed(<LocationsPage />, { route: '/inventory/locations' })

    expect(await screen.findByText('Main stockroom')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New location' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Archive/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })
})
