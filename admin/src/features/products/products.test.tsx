import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { jsonResponse } from '@/test/http'
import { renderAuthed } from '@/test/renderAuthed'
import {
  adminUser,
  category,
  productDetail,
  productSummary,
  productWithOptions,
  productWithShades,
  staffUser,
  variantInventory,
} from '@/test/catalogue'
import { ProductCreatePage } from './pages/ProductCreatePage'
import { ProductEditPage } from './pages/ProductEditPage'
import { ProductListPage } from './pages/ProductListPage'

/**
 * Product management, against the server's real contracts.
 *
 * The fixtures are the server's own DTO shapes and the assertions check the
 * requests that leave the browser, so these tests fail when the admin stops
 * matching the API rather than when a class name changes.
 */

let api: ApiMock

function baseRoutes(mock: ApiMock, user = adminUser) {
  return mock
    .withSession(user)
    // The product page's collections card. A sub-resource of the product, so
    // it has to precede `/admin/products/:id` — `apiMock` matches by substring,
    // in registration order.
    .on('GET', /\/admin\/products\/[^/]+\/collections/, [])
    .on('GET', '/admin/collections', [])
    .on('GET', '/storefront/settings', { currency: 'GBP', storeName: 'Test' })
    .on('GET', '/admin/categories', [category(), category({ id: 'cat-2', name: 'Sides', handle: 'sides' })])
    .on('GET', '/admin/notifications/unread-count', { count: 0 })
    .on('GET', /\/admin\/inventory\/variants\//, () =>
      jsonResponse(200, { success: true, data: variantInventory() }),
    )
}

beforeEach(() => {
  api = apiMock().install()
  tokenStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  tokenStore.clear()
})

// ── Listing ─────────────────────────────────────────────────────────────────

describe('ProductListPage', () => {
  it('lists products from the server, with their category resolved', async () => {
    baseRoutes(api).onList('/admin/products', [
      productSummary(),
      productSummary({ id: 'prod-2', title: 'Fries', handle: 'fries', categoryId: 'cat-2', status: 'draft' }),
    ])

    await renderAuthed(<ProductListPage />, { route: '/products' })

    expect(await screen.findByText('Classic Burger')).toBeInTheDocument()
    expect(screen.getByText('Fries')).toBeInTheDocument()

    // categoryId is resolved against the categories list, which the API returns
    // in full — the product summary carries only the id. Scoped to the table,
    // because the same names are also options in the category filter.
    const table = screen.getByRole('table')
    await waitFor(() => expect(within(table).getByText('Burgers')).toBeInTheDocument())
    expect(within(table).getByText('Sides')).toBeInTheDocument()
  })

  it('sends the search term to the server rather than filtering in the browser', async () => {
    const user = userEvent.setup()
    baseRoutes(api).onList('/admin/products', [productSummary()])

    await renderAuthed(<ProductListPage />, { route: '/products' })
    await screen.findByText('Classic Burger')

    await user.type(screen.getByLabelText('Search products'), 'fries')

    await waitFor(() => {
      expect(api.callsTo('GET', 'q=fries').length).toBeGreaterThan(0)
    })
  })

  it('debounces the search so typing is not one request per keystroke', async () => {
    const user = userEvent.setup()
    baseRoutes(api).onList('/admin/products', [productSummary()])

    await renderAuthed(<ProductListPage />, { route: '/products' })
    await screen.findByText('Classic Burger')

    const before = api.callsTo('GET', '/admin/products').length
    await user.type(screen.getByLabelText('Search products'), 'burger')

    await waitFor(() => expect(api.callsTo('GET', 'q=burger').length).toBe(1))
    // Six keystrokes, far fewer than six new requests.
    expect(api.callsTo('GET', '/admin/products').length - before).toBeLessThan(4)
  })

  it('passes the status and category filters through as query parameters', async () => {
    const user = userEvent.setup()
    baseRoutes(api).onList('/admin/products', [productSummary()])

    await renderAuthed(<ProductListPage />, { route: '/products' })
    await screen.findByText('Classic Burger')

    // Status is a saved view across the top now, not a select. It is still a
    // server query parameter — that is the part worth defending.
    await user.click(screen.getByRole('tab', { name: 'Draft' }))
    await waitFor(() => expect(api.callsTo('GET', 'status=draft').length).toBeGreaterThan(0))

    await user.selectOptions(screen.getByLabelText('Filter by category'), 'cat-2')
    await waitFor(() => expect(api.callsTo('GET', 'categoryId=cat-2').length).toBeGreaterThan(0))
  })

  it('delegates sorting to the server', async () => {
    const user = userEvent.setup()
    baseRoutes(api).onList('/admin/products', [productSummary()])

    await renderAuthed(<ProductListPage />, { route: '/products' })
    await screen.findByText('Classic Burger')

    await user.click(screen.getByRole('button', { name: /Product/ }))

    await waitFor(() => {
      expect(api.callsTo('GET', 'sort=title').length).toBeGreaterThan(0)
    })
  })

  it('offers an empty state that distinguishes "no matches" from "nothing yet"', async () => {
    baseRoutes(api).onList('/admin/products', [])

    await renderAuthed(<ProductListPage />, { route: '/products?q=nothing' })

    expect(await screen.findByText('No products found')).toBeInTheDocument()
  })

  it('shows an error state with a retry when the list fails', async () => {
    baseRoutes(api).onError(
      'GET',
      '/admin/products',
      503,
      'SERVICE_UNAVAILABLE',
      'The database is unavailable',
    )

    await renderAuthed(<ProductListPage />, { route: '/products' })

    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('hides the create action from an operator without catalog:write', async () => {
    baseRoutes(api, staffUser).onList('/admin/products', [productSummary()])

    await renderAuthed(<ProductListPage />, { route: '/products' })
    await screen.findByText('Classic Burger')

    expect(screen.queryByRole('button', { name: 'Add product' })).not.toBeInTheDocument()
  })
})

// ── Creating ────────────────────────────────────────────────────────────────

describe('ProductCreatePage', () => {
  it('creates a product with one variant carrying the price in minor units', async () => {
    const user = userEvent.setup()
    baseRoutes(api).on('POST', '/admin/products', () =>
      jsonResponse(201, { success: true, data: productDetail() }),
    )

    await renderAuthed(<ProductCreatePage />, { route: '/products/new' })

    await user.type(screen.getByLabelText(/^title/i), 'Classic Burger')
    await user.type(screen.getByLabelText(/^price/i), '5.99')
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]!)

    await waitFor(() => expect(api.callsTo('POST', '/admin/products')).toHaveLength(1))

    const body = api.callsTo('POST', '/admin/products')[0]!.body as {
      title: string
      handle: string
      variants: Array<{ priceAmount: number }>
    }
    expect(body.title).toBe('Classic Burger')
    // £5.99 must cross the wire as 599, never as 5.99 — the server rejects a
    // float outright.
    expect(body.variants[0]!.priceAmount).toBe(599)
    // The handle follows the title until somebody edits it.
    expect(body.handle).toBe('classic-burger')
  })

  it('refuses to submit without a title or a price, and sends nothing', async () => {
    const user = userEvent.setup()
    baseRoutes(api).on('POST', '/admin/products', () =>
      jsonResponse(201, { success: true, data: productDetail() }),
    )

    await renderAuthed(<ProductCreatePage />, { route: '/products/new' })
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]!)

    expect(await screen.findByText('A product needs a title.')).toBeInTheDocument()
    expect(screen.getByText('Give the product a price.')).toBeInTheDocument()
    expect(api.callsTo('POST', '/admin/products')).toHaveLength(0)
  })

  it("shows the server's field errors beside the inputs that caused them", async () => {
    const user = userEvent.setup()
    baseRoutes(api).on('POST', '/admin/products', () =>
      jsonResponse(422, {
        success: false,
        code: 'VALIDATION_FAILED',
        message: 'Validation failed',
        details: [{ path: 'body.handle', message: 'That handle is already in use' }],
      }),
    )

    await renderAuthed(<ProductCreatePage />, { route: '/products/new' })
    await user.type(screen.getByLabelText(/^title/i), 'Classic Burger')
    await user.type(screen.getByLabelText(/^price/i), '5.99')
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]!)

    expect(await screen.findByText('That handle is already in use')).toBeInTheDocument()
  })

  it('builds one variant per option combination', async () => {
    const user = userEvent.setup()
    baseRoutes(api).on('POST', '/admin/products', () =>
      jsonResponse(201, { success: true, data: productDetail() }),
    )

    await renderAuthed(<ProductCreatePage />, { route: '/products/new' })

    await user.type(screen.getByLabelText(/^title/i), 'Pizza')
    await user.click(screen.getByLabelText(/comes in several variations/i))

    await user.type(screen.getByLabelText('Option name'), 'Size')
    const values = screen.getByPlaceholderText('Add a value and press Enter…')
    await user.type(values, 'Small,Large,')

    await user.type(screen.getByLabelText('Price for Small'), '8.00')
    await user.type(screen.getByLabelText('Price for Large'), '12.00')
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]!)

    await waitFor(() => expect(api.callsTo('POST', '/admin/products')).toHaveLength(1))

    const body = api.callsTo('POST', '/admin/products')[0]!.body as {
      options: Array<{ name: string; values: string[] }>
      variants: Array<{ priceAmount: number; options: Record<string, string> }>
    }
    expect(body.options).toEqual([{ name: 'Size', values: ['Small', 'Large'] }])
    expect(body.variants).toHaveLength(2)
    // Variants name their options by name and value, never by id.
    expect(body.variants[0]!.options).toEqual({ Size: 'Small' })
    expect(body.variants[0]!.priceAmount).toBe(800)
    expect(body.variants[1]!.priceAmount).toBe(1200)
  })

  it('does not submit twice when the button is double-clicked', async () => {
    const user = userEvent.setup()
    let resolve: (value: Response) => void = () => undefined
    baseRoutes(api).on(
      'POST',
      '/admin/products',
      () => new Promise<Response>((r) => (resolve = r)),
    )

    await renderAuthed(<ProductCreatePage />, { route: '/products/new' })
    await user.type(screen.getByLabelText(/^title/i), 'Classic Burger')
    await user.type(screen.getByLabelText(/^price/i), '5.99')

    const submit = screen.getAllByRole('button', { name: 'Save' })[0]!
    await user.click(submit)
    await user.click(submit)
    await user.click(submit)

    expect(api.callsTo('POST', '/admin/products')).toHaveLength(1)
    resolve(jsonResponse(201, { success: true, data: productDetail() }))
  })
})

// ── Editing ─────────────────────────────────────────────────────────────────

describe('ProductEditPage', () => {
  function editRoutes(mock: ApiMock, user = adminUser, detail = productDetail()) {
    return baseRoutes(mock, user).on('GET', '/admin/products/prod-1', detail)
  }

  it('sends only the fields that changed', async () => {
    const user = userEvent.setup()
    editRoutes(api).on('PATCH', '/admin/products/prod-1', () =>
      jsonResponse(200, { success: true, data: productDetail({ title: 'Deluxe Burger' }) }),
    )

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    const title = await screen.findByLabelText(/^title/i)
    await user.clear(title)
    await user.type(title, 'Deluxe Burger')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.callsTo('PATCH', '/admin/products/prod-1')).toHaveLength(1))

    // Vendor, tags, SEO and everything else the operator did not touch must be
    // absent — resending them would revert a colleague's concurrent edit.
    expect(api.callsTo('PATCH', '/admin/products/prod-1')[0]!.body).toEqual({
      title: 'Deluxe Burger',
    })
  })

  it('sends null rather than an empty string when a field is cleared', async () => {
    const user = userEvent.setup()
    editRoutes(api).on('PATCH', '/admin/products/prod-1', () =>
      jsonResponse(200, { success: true, data: productDetail({ subtitle: null }) }),
    )

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    await user.clear(await screen.findByLabelText(/^subtitle/i))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.callsTo('PATCH', '/admin/products/prod-1')).toHaveLength(1))
    // `null` clears the value; `''` would be a 422 or a stored empty string.
    expect(api.callsTo('PATCH', '/admin/products/prod-1')[0]!.body).toEqual({ subtitle: null })
  })

  it('changes the category by id', async () => {
    const user = userEvent.setup()
    editRoutes(api).on('PATCH', '/admin/products/prod-1', () =>
      jsonResponse(200, { success: true, data: productDetail() }),
    )

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    // The select renders before the categories request lands; waiting for the
    // option rather than the select is what makes this deterministic.
    await screen.findByRole('option', { name: 'Sides' })
    await user.selectOptions(screen.getByLabelText(/^category/i), 'cat-2')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.callsTo('PATCH', '/admin/products/prod-1')).toHaveLength(1))
    expect(api.callsTo('PATCH', '/admin/products/prod-1')[0]!.body).toEqual({ categoryId: 'cat-2' })
  })

  it('offers no way to save until something actually changes', async () => {
    // The save bar is *absent* when the form is clean rather than present and
    // disabled — which is the whole reason it replaced a header button. A page
    // that always shows Save gives no clue whether anything is unsaved.
    editRoutes(api)
    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    await screen.findByLabelText(/^title/i)
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
  })

  it('raises the save bar the moment a field is edited, and discards back', async () => {
    const user = userEvent.setup()
    editRoutes(api)
    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    const title = await screen.findByLabelText(/^title/i)
    await user.type(title, ' Deluxe')

    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Discard' }))

    // Back to the server's value, and the bar goes with it.
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument())
    expect(title).toHaveValue('Classic Burger')
    expect(api.callsTo('PATCH', '/admin/products/prod-1')).toHaveLength(0)
  })

  it('archives through the archive endpoint, behind a confirmation', async () => {
    const user = userEvent.setup()
    // The GET reflects the archive, as a real server would: the mutation
    // invalidates the detail query, and a stub frozen on the old state would
    // make the assertion pass or fail for the wrong reason.
    let current = productDetail()
    baseRoutes(api)
      .on('GET', '/admin/products/prod-1', () => jsonResponse(200, { success: true, data: current }))
      .on('POST', '/admin/products/prod-1/archive', () => {
        current = productDetail({ status: 'archived', archivedAt: '2026-03-01T00:00:00.000Z' })
        return jsonResponse(200, { success: true, data: current })
      })

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    // Archive is behind More actions now — a destructive transition should not
    // be a button sitting in the sidebar next to the save affordances.
    await user.click(await screen.findByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByRole('menuitem', { name: /Archive product/ }))

    // Nothing destructive has happened yet — the dialog is the gate.
    expect(api.callsTo('POST', '/admin/products/prod-1/archive')).toHaveLength(0)

    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Archive product' }))

    await waitFor(() =>
      expect(api.callsTo('POST', '/admin/products/prod-1/archive')).toHaveLength(1),
    )
    expect(await screen.findByText('This product is archived')).toBeInTheDocument()
  })

  it('never offers a DELETE — the API has none', async () => {
    const user = userEvent.setup()
    editRoutes(api)
    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    await screen.findByLabelText(/^title/i)
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /delete/i })).not.toBeInTheDocument()

    // Archive is behind More actions now — a destructive transition should not
    // be a button sitting in the sidebar next to the save affordances.
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByRole('menuitem', { name: /Archive product/ }))
    expect(within(screen.getByRole('dialog')).getByText(/Nothing is\s+deleted/)).toBeInTheDocument()
  })

  it('makes an archived product read-only and offers a restore', async () => {
    editRoutes(api, adminUser, productDetail({ status: 'archived', archivedAt: '2026-03-01T00:00:00.000Z' }))

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    expect(await screen.findByLabelText(/^title/i)).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Restore to draft' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('gives a read-only view to an operator with only catalog:read', async () => {
    editRoutes(api, staffUser)
    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    expect(await screen.findByLabelText(/^title/i)).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Archive product' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Save/ })).not.toBeInTheDocument()
  })

  it('shows the forbidden state when the server refuses the read', async () => {
    baseRoutes(api, staffUser).onError(
      'GET',
      '/admin/products/prod-1',
      403,
      'INSUFFICIENT_PERMISSIONS',
      'You need catalog:read',
    )

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    expect(await screen.findByText(/do not have access to this/i)).toBeInTheDocument()
  })

  it('reports a failed save without losing the edit', async () => {
    const user = userEvent.setup()
    editRoutes(api).onError(
      'PATCH',
      '/admin/products/prod-1',
      409,
      'HANDLE_TAKEN',
      'That handle is already in use',
    )

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    const title = await screen.findByLabelText(/^title/i)
    await user.clear(title)
    await user.type(title, 'Deluxe Burger')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('That handle is already in use')).toBeInTheDocument()
    // The operator's work is still on screen and still saveable.
    expect(screen.getByLabelText(/^title/i)).toHaveValue('Deluxe Burger')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })
})

// ── Options, variants and stock ─────────────────────────────────────────────

/**
 * Colour swatches.
 *
 * What these defend:
 *
 *   • **A colour is stated, never guessed.** The picker writes a hex the
 *     merchant chose; nothing here derives a colour from the word "Mulberry".
 *   • **Unset is a state, not black.** A value with no colour draws an empty
 *     ring and says so to a screen reader.
 *   • **It is offered where it makes sense.** A Size axis gets no picker; a
 *     Shade axis does — and so does any axis where a colour has been set.
 *   • **Recolouring is safe on a live product.** It goes to its own endpoint
 *     and never touches the options or the variants.
 */
describe('ProductEditPage — colour swatches', () => {
  function shadeRoutes(mock: ApiMock, detail = productWithShades()) {
    return baseRoutes(mock).on('GET', '/admin/products/prod-2', () =>
      jsonResponse(200, { success: true, data: detail }),
    )
  }

  const route = { route: '/products/prod-2', path: '/products/:id' }

  it('draws the colour a value has, and an empty ring for one it has not', async () => {
    shadeRoutes(api)
    await renderAuthed(<ProductEditPage />, route)

    // Named for a screen reader, which cannot see either circle.
    expect(await screen.findByRole('img', { name: 'Mulberry, #7b2d4e' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Sand, no colour set' })).toBeInTheDocument()
  })

  it('offers no picker on an axis that is not a colour', async () => {
    // Size is a size. A colour control on it would be noise.
    baseRoutes(api).on('GET', '/admin/products/prod-2', () =>
      jsonResponse(200, { success: true, data: productWithOptions() }),
    )
    await renderAuthed(<ProductEditPage />, route)

    // "Small" appears on the option chip and again on its variant row, so the
    // wait anchors on something singular.
    await screen.findByRole('button', { name: 'Add another option' })
    expect(screen.queryByRole('button', { name: /colour (of|for)/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /no colour set/ })).not.toBeInTheDocument()
  })

  it('offers one on an axis the merchant did not name after a colour, once one is set', async () => {
    // "Fabric" is not a colour word — but somebody has already coloured a value
    // on it, which settles the question better than the name does.
    shadeRoutes(
      api,
      productWithShades({
        options: [
          {
            id: 'opt-shade',
            name: 'Fabric',
            position: 0,
            values: [
              { id: 'val-mulberry', value: 'Mulberry', position: 0, swatchHex: '#7b2d4e' },
              { id: 'val-sand', value: 'Sand', position: 1, swatchHex: null },
            ],
          },
        ],
      }),
    )
    await renderAuthed(<ProductEditPage />, route)

    expect(
      await screen.findByRole('button', { name: 'Set a colour for Sand' }),
    ).toBeInTheDocument()
  })

  it('saves a typed hex through the value endpoint', async () => {
    const user = userEvent.setup()
    shadeRoutes(api).on('PATCH', '/admin/products/prod-2/options/opt-shade/values/val-sand', () =>
      jsonResponse(200, { success: true, data: productWithShades() }),
    )
    await renderAuthed(<ProductEditPage />, route)

    await user.click(await screen.findByRole('button', { name: 'Set a colour for Sand' }))
    await user.type(screen.getByLabelText('Hex colour for Sand'), '#C2B280')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    const calls = await waitFor(() => {
      const found = api.callsTo('PATCH', '/options/opt-shade/values/val-sand')
      expect(found).toHaveLength(1)
      return found
    })
    // Normalised on the way out, the same three spellings the server accepts.
    expect(calls[0]!.body).toEqual({ swatchHex: '#c2b280' })
  })

  it('refuses to send something that is not a colour', async () => {
    const user = userEvent.setup()
    shadeRoutes(api)
    await renderAuthed(<ProductEditPage />, route)

    await user.click(await screen.findByRole('button', { name: 'Set a colour for Sand' }))
    await user.type(screen.getByLabelText('Hex colour for Sand'), 'sand')

    expect(screen.getByText('A colour looks like #b4622d.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(api.callsTo('PATCH', '/options/opt-shade/values/val-sand')).toHaveLength(0)
  })

  it('clears a colour back to nothing', async () => {
    const user = userEvent.setup()
    shadeRoutes(api).on(
      'PATCH',
      '/admin/products/prod-2/options/opt-shade/values/val-mulberry',
      () => jsonResponse(200, { success: true, data: productWithShades() }),
    )
    await renderAuthed(<ProductEditPage />, route)

    await user.click(await screen.findByRole('button', { name: 'Change the colour of Mulberry' }))
    await user.click(screen.getByRole('button', { name: 'Clear' }))

    const calls = await waitFor(() => {
      const found = api.callsTo('PATCH', '/options/opt-shade/values/val-mulberry')
      expect(found).toHaveLength(1)
      return found
    })
    expect(calls[0]!.body).toEqual({ swatchHex: null })
  })

  it('does not touch the options or the variants when recolouring', async () => {
    // The whole reason this is its own endpoint: it must be safe on a product
    // that is already selling.
    const user = userEvent.setup()
    shadeRoutes(api).on('PATCH', '/admin/products/prod-2/options/opt-shade/values/val-sand', () =>
      jsonResponse(200, { success: true, data: productWithShades() }),
    )
    await renderAuthed(<ProductEditPage />, route)

    await user.click(await screen.findByRole('button', { name: 'Set a colour for Sand' }))
    await user.type(screen.getByLabelText('Hex colour for Sand'), '#c2b280')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(api.callsTo('PATCH', '/options/opt-shade/values/val-sand')).toHaveLength(1),
    )
    expect(api.callsTo('PUT', '/admin/products/prod-2/options')).toHaveLength(0)
    expect(api.callsTo('POST', '/admin/products/prod-2/variants')).toHaveLength(0)
  })

  it('offers no picker to somebody who cannot edit the catalogue', async () => {
    shadeRoutes(api.withSession(staffUser))
    await renderAuthed(<ProductEditPage />, route)

    await screen.findAllByText('Mulberry')
    // Staff can read the catalogue but not write it, so the circles are shown
    // and the controls behind them are not usable.
    expect(screen.getByRole('img', { name: 'Mulberry, #7b2d4e' })).toBeInTheDocument()
    for (const picker of screen.queryAllByRole('button', { name: /colour (of|for)/ })) {
      expect(picker).toBeDisabled()
    }
  })
})

describe('ProductEditPage — options and variants', () => {
  function optionRoutes(mock: ApiMock, detail = productWithOptions()) {
    return baseRoutes(mock).on('GET', '/admin/products/prod-2', () =>
      jsonResponse(200, { success: true, data: detail }),
    )
  }

  const optionsRoute = '/products/:id'

  it('appends an option value through the value endpoint, not by replacing the options', async () => {
    const user = userEvent.setup()
    optionRoutes(api).on('POST', '/admin/products/prod-2/options/opt-size/values', () =>
      jsonResponse(201, { success: true, data: productWithOptions() }),
    )

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-2', path: optionsRoute })

    await user.type(await screen.findByLabelText('Add a value to Size'), 'Family')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() =>
      expect(api.callsTo('POST', '/admin/products/prod-2/options/opt-size/values')).toHaveLength(1),
    )
    expect(
      api.callsTo('POST', '/admin/products/prod-2/options/opt-size/values')[0]!.body,
    ).toEqual({ value: 'Family' })

    // PUT /options rewrites every option and is refused while variants exist —
    // the admin must never reach for it to add a value.
    expect(api.callsTo('PUT', '/admin/products/prod-2/options')).toHaveLength(0)
  })

  it('explains, rather than hides, a value the server refuses to remove', async () => {
    const user = userEvent.setup()
    optionRoutes(api).onError(
      'DELETE',
      '/admin/products/prod-2/options/opt-size/values/val-large',
      409,
      'OPTION_VALUE_IN_USE',
      '1 variant(s) still use "Large" — archive them first',
    )

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-2', path: optionsRoute })

    await user.click(await screen.findByRole('button', { name: 'Remove Large from Size' }))

    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Remove value' }))

    expect(
      await screen.findByText('1 variant(s) still use "Large" — archive them first'),
    ).toBeInTheDocument()
  })

  it('adds a variant for an unused combination, naming its options by value', async () => {
    const user = userEvent.setup()
    const detail = productWithOptions({
      options: [
        {
          id: 'opt-size',
          name: 'Size',
          position: 0,
          values: [
            { id: 'val-small', value: 'Small', position: 0, swatchHex: null },
            { id: 'val-large', value: 'Large', position: 1, swatchHex: null },
            { id: 'val-family', value: 'Family', position: 2, swatchHex: null },
          ],
        },
      ],
    })
    optionRoutes(api, detail).on('POST', '/admin/products/prod-2/variants', () =>
      jsonResponse(201, { success: true, data: detail.variants[0] }),
    )

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-2', path: optionsRoute })

    await user.click(await screen.findByRole('button', { name: 'Add variant' }))

    const dialog = screen.getByRole('dialog')
    await user.selectOptions(within(dialog).getByLabelText('Size'), 'Family')
    await user.type(within(dialog).getByLabelText(/^price/i), '18.00')
    await user.click(within(dialog).getByRole('button', { name: 'Add variant' }))

    await waitFor(() =>
      expect(api.callsTo('POST', '/admin/products/prod-2/variants')).toHaveLength(1),
    )
    expect(api.callsTo('POST', '/admin/products/prod-2/variants')[0]!.body).toEqual({
      priceAmount: 1800,
      options: { Size: 'Family' },
    })
  })

  it('refuses a combination a variant already occupies, without asking the server', async () => {
    const user = userEvent.setup()
    optionRoutes(api)

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-2', path: optionsRoute })
    await user.click(await screen.findByRole('button', { name: 'Add variant' }))

    const dialog = screen.getByRole('dialog')
    // Small is the first value and already has a variant.
    expect(within(dialog).getByRole('button', { name: 'Add variant' })).toBeDisabled()
    expect(within(dialog).getByText(/already covers that combination/)).toBeInTheDocument()
    expect(api.callsTo('POST', '/admin/products/prod-2/variants')).toHaveLength(0)
  })

  it('edits a variant in a drawer and sends only what changed', async () => {
    const user = userEvent.setup()
    optionRoutes(api).on('PATCH', '/admin/variants/var-large', () =>
      jsonResponse(200, {
        success: true,
        data: { ...productWithOptions().variants[1]!, barcode: '5012345678900' },
      }),
    )

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-2', path: optionsRoute })

    await user.click(await screen.findByRole('row', { name: /Large/ }))

    const drawer = screen.getByRole('dialog', { name: 'Large' })
    await user.type(within(drawer).getByLabelText(/^barcode/i), '5012345678900')
    await user.click(within(drawer).getByRole('button', { name: 'Save variant' }))

    await waitFor(() => expect(api.callsTo('PATCH', '/admin/variants/var-large')).toHaveLength(1))
    // The price, SKU, weight and everything else the operator did not touch stay
    // out of the body — a full PATCH would revert a colleague's edit.
    expect(api.callsTo('PATCH', '/admin/variants/var-large')[0]!.body).toEqual({
      barcode: '5012345678900',
    })
  })

  it('will not archive a product down to zero live variants', async () => {
    const user = userEvent.setup()
    const detail = productWithOptions()
    optionRoutes(api, {
      ...detail,
      variants: [detail.variants[0]!],
    })

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-2', path: optionsRoute })

    await user.click(await screen.findByRole('row', { name: /Small/ }))

    const drawer = screen.getByRole('dialog', { name: 'Small' })
    expect(within(drawer).getByRole('button', { name: 'Archive variant' })).toBeDisabled()
  })

  it('adds a whole new axis, saying what the existing variants become', async () => {
    const user = userEvent.setup()
    optionRoutes(api).on('POST', '/admin/products/prod-2/options', () =>
      jsonResponse(201, { success: true, data: productWithOptions() }),
    )

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-2', path: optionsRoute })

    await user.click(await screen.findByRole('button', { name: 'Add another option' }))

    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText(/^option name/i), 'Colour')
    await user.type(within(dialog).getByPlaceholderText(/Black, Navy/), 'Black,Sand,')
    await user.selectOptions(within(dialog).getByLabelText(/existing variants become/i), 'Sand')
    await user.click(within(dialog).getByRole('button', { name: 'Add option' }))

    await waitFor(() => expect(api.callsTo('POST', '/admin/products/prod-2/options')).toHaveLength(1))
    // The value existing variants take is required — without it they would have
    // nothing selected on the new axis, which the model forbids.
    expect(api.callsTo('POST', '/admin/products/prod-2/options')[0]!.body).toEqual({
      name: 'Colour',
      values: ['Black', 'Sand'],
      appliesToExisting: 'Sand',
    })
  })

  it('refuses an option name the product already has, without asking the server', async () => {
    const user = userEvent.setup()
    optionRoutes(api)

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-2', path: optionsRoute })
    await user.click(await screen.findByRole('button', { name: 'Add another option' }))

    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText(/^option name/i), 'size')
    await user.type(within(dialog).getByPlaceholderText(/Black, Navy/), 'Huge,')

    expect(
      within(dialog).getByText('This product already has an option with that name.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Add option' })).toBeDisabled()
    expect(api.callsTo('POST', '/admin/products/prod-2/options')).toHaveLength(0)
  })

})

describe('ProductEditPage — a product with no options', () => {
  it('saves the product and its single variant in one action, as two requests', async () => {
    const user = userEvent.setup()
    baseRoutes(api)
      .on('GET', '/admin/products/prod-1', productDetail())
      .on('PATCH', '/admin/products/prod-1', () =>
        jsonResponse(200, { success: true, data: productDetail({ title: 'Deluxe Burger' }) }),
      )
      .on('PATCH', '/admin/variants/var-1', () =>
        jsonResponse(200, {
          success: true,
          data: { ...productDetail().variants[0]!, price: { amount: 699, currency: 'GBP' } },
        }),
      )

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    const title = await screen.findByLabelText(/^title/i)
    await user.clear(title)
    await user.type(title, 'Deluxe Burger')

    const price = screen.getByLabelText(/^price/i)
    await user.clear(price)
    await user.type(price, '6.99')

    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.callsTo('PATCH', '/admin/variants/var-1')).toHaveLength(1))
    expect(api.callsTo('PATCH', '/admin/products/prod-1')[0]!.body).toEqual({
      title: 'Deluxe Burger',
    })
    // The price lives on the variant, in minor units — never on the product.
    expect(api.callsTo('PATCH', '/admin/variants/var-1')[0]!.body).toEqual({ priceAmount: 699 })
  })

  it('leaves the variant alone when only the product changed', async () => {
    const user = userEvent.setup()
    baseRoutes(api)
      .on('GET', '/admin/products/prod-1', productDetail())
      .on('PATCH', '/admin/products/prod-1', () =>
        jsonResponse(200, { success: true, data: productDetail({ vendor: 'Acme' }) }),
      )

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    await user.clear(await screen.findByLabelText(/^vendor/i))
    await user.type(screen.getByLabelText(/^vendor/i), 'Acme')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.callsTo('PATCH', '/admin/products/prod-1')).toHaveLength(1))
    expect(api.callsTo('PATCH', '/admin/variants/var-1')).toHaveLength(0)
  })

  it('moves stock by a delta and a reason rather than overwriting a total', async () => {
    const user = userEvent.setup()
    baseRoutes(api)
      .on('GET', '/admin/products/prod-1', productDetail())
      .on('POST', '/admin/inventory/adjustments', () =>
        jsonResponse(201, {
          success: true,
          data: { inventoryItemId: 'inv-1', onHand: 32, reserved: 2, available: 30 },
        }),
      )

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    await user.click(await screen.findByRole('button', { name: 'Adjust' }))

    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText('Quantity'), '12')
    await user.selectOptions(within(dialog).getByLabelText(/^reason/i), 'receive')
    await user.click(within(dialog).getByRole('button', { name: 'Save adjustment' }))

    await waitFor(() =>
      expect(api.callsTo('POST', '/admin/inventory/adjustments')).toHaveLength(1),
    )
    expect(api.callsTo('POST', '/admin/inventory/adjustments')[0]!.body).toEqual({
      variantId: 'var-1',
      delta: 12,
      reason: 'receive',
    })
  })

  it('shows stock without controls to an operator who may only read it', async () => {
    baseRoutes(api, staffUser).on('GET', '/admin/products/prod-1', productDetail())

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    expect(await screen.findByText('Available')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Adjust' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Track quantity' })).not.toBeInTheDocument()
  })

  it('offers to add the first option to a product that has none', async () => {
    const user = userEvent.setup()
    baseRoutes(api)
      .on('GET', '/admin/products/prod-1', productDetail())
      .on('POST', '/admin/products/prod-1/options', () =>
        jsonResponse(201, { success: true, data: productDetail() }),
      )

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    await user.click(await screen.findByRole('button', { name: 'Add options' }))

    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText(/^option name/i), 'Material')
    await user.type(within(dialog).getByPlaceholderText(/Black, Navy/), 'Cotton,Linen,')
    await user.click(within(dialog).getByRole('button', { name: 'Add option' }))

    await waitFor(() =>
      expect(api.callsTo('POST', '/admin/products/prod-1/options')).toHaveLength(1),
    )
    // The single existing variant takes the first value by default; the merchant
    // is still shown which, because it is what that variant becomes.
    expect(api.callsTo('POST', '/admin/products/prod-1/options')[0]!.body).toEqual({
      name: 'Material',
      values: ['Cotton', 'Linen'],
      appliesToExisting: 'Cotton',
    })
  })

  it('previews the search listing with the fallbacks the storefront serves', async () => {
    // The storefront serves `seoTitle ?? title`, so an empty SEO field does not
    // mean an empty search result — and a preview that went blank would say
    // something untrue about what shoppers see.
    baseRoutes(api).on('GET', '/admin/products/prod-1', productDetail())

    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    await screen.findByLabelText(/^title/i)
    const seo = screen.getByText('Search engine listing').closest('section')!
    expect(within(seo).getByText('Classic Burger')).toBeInTheDocument()
    expect(within(seo).getByText(/\/products\/classic-burger/)).toBeInTheDocument()
  })

  it('sends the SEO fields the server accepts', async () => {
    const user = userEvent.setup()
    baseRoutes(api)
      .on('GET', '/admin/products/prod-1', productDetail())
      .on('PATCH', '/admin/products/prod-1', productDetail())
    await renderAuthed(<ProductEditPage />, { route: '/products/prod-1', path: '/products/:id' })

    await screen.findByLabelText(/^title/i)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(screen.getByLabelText('Page title'), 'The best burger in town')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const call = await waitFor(() => {
      const calls = api.callsTo('PATCH', '/admin/products/prod-1')
      expect(calls).toHaveLength(1)
      return calls[0]!
    })
    expect(call.body).toEqual({ seoTitle: 'The best burger in town' })
  })
})
