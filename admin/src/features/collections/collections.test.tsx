import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { jsonResponse } from '@/test/http'
import { renderAuthed } from '@/test/renderAuthed'
import {
  adminUser,
  collectionDetail,
  collectionSummary,
  productRuleFields,
  productSummary,
  smartCollection,
  staffUser,
} from '@/test/catalogue'
import { ProductListPage } from '@/features/products/pages/ProductListPage'
import { CollectionDetailPage } from './pages/CollectionDetailPage'
import { CollectionListPage } from './pages/CollectionListPage'

/**
 * Collections, smart and manual.
 *
 * The one thing worth proving over and over: the two kinds are never editable
 * the same way. A smart collection has no hand-picked products — its membership
 * is its rules — and any screen that offered to add one would be offering
 * something the server refuses twice over.
 */

let api: ApiMock

// `apiMock` matches by substring, so `/admin/collections` swallows
// `/admin/collections/col-1`. Anything more specific has to be registered on
// the mock before this is called.
function baseRoutes(mock: ApiMock, user = adminUser) {
  return mock
    .withSession(user)
    .on('GET', '/storefront/settings', { currency: 'GBP', storeName: 'Test' })
    .on('GET', '/admin/notifications/unread-count', { count: 0 })
    .on('GET', '/admin/collections/rules/fields', productRuleFields())
    .on('GET', '/admin/collections', [collectionSummary(), smartCollection()])
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

describe('CollectionListPage', () => {
  it('shows both kinds with a live count, and marks the smart ones', async () => {
    baseRoutes(api)
    await renderAuthed(<CollectionListPage />, { route: '/collections' })

    expect(await screen.findByText('Best sellers')).toBeInTheDocument()
    expect(screen.getByText('Under £50')).toBeInTheDocument()
    expect(screen.getByText('Smart')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    // A smart collection describes itself by its rules, not a description.
    expect(screen.getByText('Price is less than 5000')).toBeInTheDocument()
  })

  it('says what archiving does before doing it', async () => {
    const user = userEvent.setup()
    baseRoutes(api)

    await renderAuthed(<CollectionListPage />, { route: '/collections' })
    await screen.findByText('Best sellers')

    await user.click(screen.getAllByRole('button', { name: /Archive/ })[0]!)

    expect(await screen.findByText('Archive "Best sellers"?')).toBeInTheDocument()
    expect(screen.getByText(/No product is changed/)).toBeInTheDocument()
    expect(api.callsTo('DELETE', '/admin/collections/col-1')).toHaveLength(0)
  })

  it('warns that a smart collection has no hand-picked products', async () => {
    const user = userEvent.setup()
    baseRoutes(api)

    await renderAuthed(<CollectionListPage />, { route: '/collections' })
    await screen.findByText('Best sellers')

    await user.click(screen.getByRole('button', { name: 'Create collection' }))
    await user.selectOptions(screen.getByLabelText('How products get in'), 'dynamic')

    expect(await screen.findByText('Membership is the rule')).toBeInTheDocument()
  })

  it('hides the writes from an operator who cannot make them', async () => {
    baseRoutes(api, staffUser)
    await renderAuthed(<CollectionListPage />, { route: '/collections' })
    await screen.findByText('Best sellers')

    expect(screen.queryByRole('button', { name: 'Create collection' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Archive/ })).not.toBeInTheDocument()
  })
})

// ── One collection ──────────────────────────────────────────────────────────

describe('CollectionDetailPage', () => {
  const manualRoute = { route: '/collections/col-1', path: '/collections/:id' }
  const smartRoute = { route: '/collections/col-2', path: '/collections/:id' }

  function manualRoutes(mock: ApiMock, user = adminUser) {
    return baseRoutes(mock.on('GET', '/admin/collections/col-1', collectionDetail()), user).onList(
      '/admin/products',
      [productSummary({ id: 'prod-1', title: 'Classic Burger' })],
    )
  }

  function smartRoutes(mock: ApiMock) {
    return baseRoutes(
      mock
        .on('GET', '/admin/collections/col-2', { ...smartCollection(), productIds: ['prod-1'] })
        .on('POST', '/admin/collections/preview', {
          productCount: 4,
          summary: 'Price is less than 5000',
          products: [{ id: 'prod-1', title: 'Classic Burger', handle: 'classic-burger' }],
        }),
    ).onList('/admin/products', [productSummary({ id: 'prod-1', title: 'Classic Burger' })])
  }

  it('gives a manual collection a list it can arrange', async () => {
    manualRoutes(api)
    await renderAuthed(<CollectionDetailPage />, manualRoute)

    expect(await screen.findByRole('heading', { name: 'Best sellers' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add products' })).toBeInTheDocument()
    // No rule builder anywhere on a hand-picked collection.
    expect(screen.queryByRole('button', { name: 'Add condition' })).not.toBeInTheDocument()
  })

  it('saves an arrangement wholesale, because the order is the content', async () => {
    const user = userEvent.setup()
    baseRoutes(
      api
        .on('GET', '/admin/collections/col-1', {
          ...collectionDetail(),
          productIds: ['prod-1', 'prod-2'],
        })
        .on('PUT', '/admin/collections/col-1/products', { productIds: ['prod-2', 'prod-1'] }),
    ).onList('/admin/products', [
      productSummary({ id: 'prod-1', title: 'Classic Burger' }),
      productSummary({ id: 'prod-2', title: 'Veggie Wrap' }),
    ])

    await renderAuthed(<CollectionDetailPage />, manualRoute)
    // The rows are their own request; wait for them before reordering.
    await screen.findByText('Veggie Wrap')

    await user.click(screen.getByRole('button', { name: 'Move Veggie Wrap up' }))
    await user.click(screen.getByRole('button', { name: 'Save order' }))

    await waitFor(() => {
      const [call] = api.callsTo('PUT', '/admin/collections/col-1/products')
      // The whole arrangement, not a move instruction.
      expect(call?.body).toEqual({ productIds: ['prod-2', 'prod-1'] })
    })
  })

  it('gives a smart collection rules and a live count instead', async () => {
    smartRoutes(api)
    await renderAuthed(<CollectionDetailPage />, smartRoute)

    expect(await screen.findByRole('heading', { name: 'Under £50' })).toBeInTheDocument()
    expect(await screen.findByText('4')).toBeInTheDocument()
    // The one thing that must never appear on a smart collection.
    expect(screen.queryByRole('button', { name: 'Add products' })).not.toBeInTheDocument()
  })

  it('builds rules only from the fields the server publishes', async () => {
    const user = userEvent.setup()
    smartRoutes(api)

    await renderAuthed(<CollectionDetailPage />, smartRoute)
    await screen.findByRole('heading', { name: 'Under £50' })

    const field = await screen.findByLabelText('Condition 1 field')
    expect(within(field as HTMLSelectElement).getByText('Price')).toBeInTheDocument()
    expect(within(field as HTMLSelectElement).queryByText('Search vector')).not.toBeInTheDocument()

    // And the operators come from the field's type, not from a list here.
    await user.click(screen.getByRole('button', { name: 'Add condition' }))
    const operator = screen.getByLabelText('Condition 2 operator')
    expect(within(operator as HTMLSelectElement).queryByText('contains')).toBeInTheDocument()
  })

  it('previews before saving, and only saves when asked', async () => {
    const user = userEvent.setup()
    smartRoutes(
      api.on('PATCH', '/admin/collections/col-2', () =>
        jsonResponse(200, { success: true, data: smartCollection() }),
      ),
    )

    await renderAuthed(<CollectionDetailPage />, smartRoute)
    await screen.findByRole('heading', { name: 'Under £50' })
    await screen.findByText('4')

    expect(api.callsTo('POST', '/admin/collections/preview').length).toBeGreaterThan(0)
    expect(api.callsTo('PATCH', '/admin/collections/col-2')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Add condition' }))
    await user.click(await screen.findByRole('button', { name: 'Save rules' }))

    await waitFor(() => expect(api.callsTo('PATCH', '/admin/collections/col-2').length).toBe(1))
  })

  it('gives an operator without write permission a read-only collection', async () => {
    manualRoutes(api, staffUser)
    await renderAuthed(<CollectionDetailPage />, manualRoute)
    await screen.findByRole('heading', { name: 'Best sellers' })

    expect(screen.queryByRole('button', { name: 'Add products' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Title')).toBeDisabled()
  })
})

// ── Bulk actions on the product list ────────────────────────────────────────

describe('bulk product actions', () => {
  function listRoutes(mock: ApiMock, user = adminUser) {
    return baseRoutes(mock, user)
      .on('GET', '/admin/categories/tree', [])
      .onList('/admin/products', [
        productSummary({ id: 'prod-1', title: 'Classic Burger' }),
        productSummary({ id: 'prod-2', title: 'Veggie Wrap' }),
      ])
  }

  it('offers nothing until something is selected', async () => {
    const user = userEvent.setup()
    listRoutes(api)

    await renderAuthed(<ProductListPage />, { route: '/products' })
    await screen.findByText('Classic Burger')

    expect(screen.queryByLabelText('Bulk action')).not.toBeInTheDocument()

    await user.click(screen.getAllByLabelText('Select row')[0]!)
    expect(await screen.findByLabelText('Bulk action')).toBeInTheDocument()
    expect(screen.getByText('1 selected')).toBeInTheDocument()
  })

  it('selects every row on the page, and only this page', async () => {
    const user = userEvent.setup()
    listRoutes(api)

    await renderAuthed(<ProductListPage />, { route: '/products' })
    await screen.findByText('Classic Burger')

    await user.click(screen.getByLabelText('Select every row on this page'))
    expect(await screen.findByText('2 selected')).toBeInTheDocument()
  })

  it('sends one action for the whole selection', async () => {
    const user = userEvent.setup()
    listRoutes(api).on('POST', '/admin/products/bulk', {
      results: [
        { productId: 'prod-1', ok: true },
        { productId: 'prod-2', ok: true },
      ],
      succeeded: 2,
      failed: 0,
    })

    await renderAuthed(<ProductListPage />, { route: '/products' })
    await screen.findByText('Classic Burger')

    await user.click(screen.getByLabelText('Select every row on this page'))
    await user.selectOptions(await screen.findByLabelText('Bulk action'), 'publish')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      const [call] = api.callsTo('POST', '/admin/products/bulk')
      expect(call?.body).toMatchObject({
        action: 'publish',
        productIds: ['prod-1', 'prod-2'],
      })
    })
  })

  it('keeps the selection and says why when only some went through', async () => {
    const user = userEvent.setup()
    listRoutes(api).on('POST', '/admin/products/bulk', {
      results: [
        { productId: 'prod-1', ok: true },
        { productId: 'prod-2', ok: false, error: 'A draft product cannot be published' },
      ],
      succeeded: 1,
      failed: 1,
    })

    await renderAuthed(<ProductListPage />, { route: '/products' })
    await screen.findByText('Classic Burger')

    await user.click(screen.getByLabelText('Select every row on this page'))
    await user.selectOptions(await screen.findByLabelText('Bulk action'), 'publish')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    expect(await screen.findByText('Some products did not change')).toBeInTheDocument()
    expect(screen.getByText(/draft product cannot be published/)).toBeInTheDocument()
    // Still selected, so the operator can act on what is left.
    expect(screen.getByText('2 selected')).toBeInTheDocument()
  })

  it('never offers a smart collection as somewhere to add products', async () => {
    const user = userEvent.setup()
    listRoutes(api)

    await renderAuthed(<ProductListPage />, { route: '/products' })
    await screen.findByText('Classic Burger')

    await user.click(screen.getAllByLabelText('Select row')[0]!)
    await user.selectOptions(await screen.findByLabelText('Bulk action'), 'addToCollection')

    const picker = await screen.findByLabelText('Collection')
    expect(within(picker as HTMLSelectElement).getByText('Best sellers')).toBeInTheDocument()
    // Its membership is its rules; the server refuses to be told otherwise.
    expect(within(picker as HTMLSelectElement).queryByText('Under £50')).not.toBeInTheDocument()
  })

  it('gives no selection at all to an operator who cannot write', async () => {
    listRoutes(api, staffUser)

    await renderAuthed(<ProductListPage />, { route: '/products' })
    await screen.findByText('Classic Burger')

    expect(screen.queryByLabelText('Select row')).not.toBeInTheDocument()
  })
})
