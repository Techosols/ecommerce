import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiMock } from '@/test/apiMock'
import { renderPage } from '@/test/render'
import { collection, collectionList, productCard, productDetail } from '@/test/fixtures'
import { ProductListPage } from './pages/ProductListPage'
import { ProductPage } from './pages/ProductPage'
import { CollectionPage } from './pages/CollectionPage'
import { ProductCard } from './components/ProductCard'
import { HomePage } from './pages/HomePage'

/**
 * Browsing the shop.
 *
 * What these tests defend — each one a way the screen could look right and be
 * wrong:
 *
 *   • **The storefront prices nothing.** Every figure is the server's. A test
 *     that asserts a price asserts the screen showed what it was told.
 *   • **Filtering happens on the server.** A search must narrow the whole
 *     catalogue, not the twelve products already on screen.
 *   • **The URL is the state.** A filtered listing has to be linkable and
 *     survive the back button.
 *   • **The shop browses by collection.** A collection is a shopfront answer
 *     ("bestsellers"); a category is a filing answer. Only the first belongs
 *     in front of a shopper.
 *   • **Sold out is said, not implied.** A shopper choosing a size needs to
 *     see that the large exists and cannot be had.
 */

let mock

beforeEach(() => {
  mock = apiMock().install()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── The card ────────────────────────────────────────────────────────────────

describe('ProductCard', () => {
  it('shows the server’s "from" price, and never computes one', () => {
    renderPage(<ProductCard product={productCard()} />)

    // The fixture's variants differ, so the server sent a range.
    expect(screen.getByText('From £11.50')).toBeInTheDocument()
  })

  it('shows one price when the range does not move', () => {
    const flat = {
      min: { amount: 1150, currency: 'GBP' },
      max: { amount: 1150, currency: 'GBP' },
    }
    renderPage(<ProductCard product={productCard({ priceRange: flat })} />)

    expect(screen.getByText('£11.50')).toBeInTheDocument()
  })

  it('says a sold-out product is unavailable rather than showing a dash', () => {
    // `publicProductCardDto` computes the range over purchasable variants
    // only, so a sold-out product genuinely arrives with no price at all.
    renderPage(<ProductCard product={productCard({ available: false, priceRange: null })} />)

    expect(screen.getByText('Sold out')).toBeInTheDocument()
    expect(screen.getByText('Currently unavailable')).toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })

  it('is one link to one place', () => {
    renderPage(<ProductCard product={productCard()} />)

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/products/copperleaf-classic')
  })
})

// ── The listing ─────────────────────────────────────────────────────────────

describe('ProductListPage', () => {
  it('renders a page of products with the server’s count', async () => {
    mock.onList('/storefront/products', [productCard(), productCard({ id: 'p2', handle: 'b', title: 'Sourdough' })], {
      total: 31,
      totalPages: 3,
      hasNext: true,
    })

    renderPage(<ProductListPage />, { route: '/products' })

    expect(await screen.findByText('Copperleaf Classic')).toBeInTheDocument()
    expect(screen.getByText('31 products')).toBeInTheDocument()
  })

  it('sends the search to the server rather than filtering what is on screen', async () => {
    mock.onList('/storefront/products', [productCard()])

    renderPage(<ProductListPage />, { route: '/products?q=coffee' })

    await waitFor(() => {
      expect(mock.callsTo('GET', '/storefront/products')[0].url).toContain('q=coffee')
    })
  })

  it('sends the collection from the URL, so a filtered listing is linkable', async () => {
    mock.onList('/storefront/products', [productCard()])

    renderPage(<ProductListPage />, { route: '/products?collection=bestsellers' })

    await waitFor(() => {
      expect(mock.callsTo('GET', '/storefront/products')[0].url).toContain('collection=bestsellers')
    })
  })

  it('never asks the storefront to filter by category', async () => {
    // Categories are the merchant's filing system, not a shopper's way in.
    mock.onList('/storefront/products', [productCard()])

    renderPage(<ProductListPage />, { route: '/products?q=bun' })

    await waitFor(() => expect(mock.callsTo('GET', '/storefront/products')).toHaveLength(1))
    expect(mock.callsTo('GET', '/storefront/products')[0].url).not.toContain('category=')
  })

  it('asks for the page named in the URL, not always the first', async () => {
    mock.onList('/storefront/products', [productCard()], { page: 2, totalPages: 3, hasPrev: true })

    renderPage(<ProductListPage />, { route: '/products?page=2' })

    await waitFor(() => {
      expect(mock.callsTo('GET', '/storefront/products')[0].url).toContain('page=2')
    })
  })

  it('pages forward through the URL', async () => {
    const user = userEvent.setup()
    mock.onList('/storefront/products', [productCard()], { total: 31, totalPages: 3, hasNext: true })
    renderPage(<ProductListPage />, { route: '/products' })
    await screen.findByText('Copperleaf Classic')

    await user.click(screen.getByRole('button', { name: 'Next' }))

    await waitFor(() => {
      expect(mock.callsTo('GET', '/storefront/products').at(-1).url).toContain('page=2')
    })
  })

  it('offers no pager when there is only one page', async () => {
    mock.onList('/storefront/products', [productCard()], { total: 1, totalPages: 1 })

    renderPage(<ProductListPage />, { route: '/products' })
    await screen.findByText('Copperleaf Classic')

    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument()
  })

  it('explains an empty search and offers a way out of it', async () => {
    mock.onList('/storefront/products', [], { total: 0, totalPages: 0 })

    renderPage(<ProductListPage />, { route: '/products?q=zzz' })

    expect(await screen.findByText('Nothing matched that')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument()
  })

  it('distinguishes an empty shop from an empty search', async () => {
    mock.onList('/storefront/products', [], { total: 0, totalPages: 0 })

    renderPage(<ProductListPage />, { route: '/products' })

    expect(await screen.findByText('Nothing is for sale yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
  })

  it('offers a retry rather than a blank page when the request fails', async () => {
    mock.onError('GET', '/storefront/products', 500, 'INTERNAL_ERROR', 'Boom')

    renderPage(<ProductListPage />, { route: '/products' })

    expect(await screen.findByText('That did not load')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

// ── One product ─────────────────────────────────────────────────────────────

describe('ProductPage', () => {
  const route = { route: '/products/copperleaf-classic', path: '/products/:handle' }

  it('shows the selected variant’s price, not the range', async () => {
    mock.on('GET', '/storefront/products/copperleaf-classic', productDetail())

    renderPage(<ProductPage />, route)

    // "From £11.50" would be dishonest once a size has been chosen.
    expect(await screen.findByText('£11.50')).toBeInTheDocument()
    expect(screen.queryByText('From £11.50')).not.toBeInTheDocument()
  })

  it('re-prices when a different size is chosen', async () => {
    const user = userEvent.setup()
    mock.on('GET', '/storefront/products/copperleaf-classic', productDetail())
    renderPage(<ProductPage />, route)
    await screen.findByText('£11.50')

    await user.click(screen.getByText('Double'))

    expect(await screen.findByText('£14.00')).toBeInTheDocument()
  })

  it('keeps a sold-out size visible and marked', async () => {
    // Hiding it would leave a shopper wondering whether the large exists.
    const detail = productDetail()
    detail.variants[1] = { ...detail.variants[1], available: false, availability: 'out_of_stock' }
    mock.on('GET', '/storefront/products/copperleaf-classic', detail)

    renderPage(<ProductPage />, route)

    const double = await screen.findByText(/Double/)
    expect(double).toBeInTheDocument()
    expect(within(double.closest('label')).getByRole('radio')).toBeDisabled()
  })

  it('starts on a variant that can actually be bought', async () => {
    const detail = productDetail()
    detail.variants[0] = { ...detail.variants[0], available: false, availability: 'out_of_stock' }
    mock.on('GET', '/storefront/products/copperleaf-classic', detail)

    renderPage(<ProductPage />, route)

    // Not the first variant — the first buyable one.
    expect(await screen.findByText('£14.00')).toBeInTheDocument()
  })

  it('says sold out on the action when nothing can be bought', async () => {
    const detail = productDetail({ available: false })
    detail.variants = detail.variants.map((variant) => ({
      ...variant,
      available: false,
      availability: 'out_of_stock',
    }))
    mock.on('GET', '/storefront/products/copperleaf-classic', detail)

    renderPage(<ProductPage />, route)

    expect(await screen.findByRole('button', { name: 'Sold out' })).toBeInTheDocument()
  })

  it('shows the availability the server resolved, not one inferred here', async () => {
    const detail = productDetail()
    detail.variants[0] = { ...detail.variants[0], availability: 'low_stock' }
    mock.on('GET', '/storefront/products/copperleaf-classic', detail)

    renderPage(<ProductPage />, route)

    expect(await screen.findByText('Only a few left')).toBeInTheDocument()
  })

  it('offers no size picker for a product with one variant', async () => {
    const detail = productDetail({ options: [], variants: [productDetail().variants[0]] })
    mock.on('GET', '/storefront/products/copperleaf-classic', detail)

    renderPage(<ProductPage />, route)

    await screen.findByText('£11.50')
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })

  it('leads back to the shop, not to a category', async () => {
    // The DTO carries a category — the page deliberately does not offer it as
    // a way to browse, because nothing else in the storefront does.
    mock.on('GET', '/storefront/products/copperleaf-classic', productDetail())

    renderPage(<ProductPage />, route)

    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getByRole('link', { name: 'Shop' })).toHaveAttribute('href', '/products')
    expect(within(crumbs).queryByRole('link', { name: 'Prepared Foods' })).not.toBeInTheDocument()
  })
})

// ── A collection ────────────────────────────────────────────────────────────

describe('CollectionPage', () => {
  const route = { route: '/collections/bestsellers', path: '/collections/:handle' }

  function collectionRoutes(products = [productCard()]) {
    return mock
      .on('GET', '/storefront/collections/bestsellers', collection())
      .onList('/storefront/products', products)
  }

  it('narrows the products to the collection in the URL', async () => {
    collectionRoutes()

    renderPage(<CollectionPage />, route)

    await waitFor(() => {
      expect(mock.callsTo('GET', '/storefront/products')[0].url).toContain(
        'collection=bestsellers',
      )
    })
  })

  it('shows the collection’s own title and description', async () => {
    collectionRoutes()

    renderPage(<CollectionPage />, route)

    expect(await screen.findByRole('heading', { name: 'Bestsellers' })).toBeInTheDocument()
    expect(screen.getByText('What leaves the counter fastest.')).toBeInTheDocument()
  })

  it('renders the description as the HTML the admin wrote', async () => {
    // Descriptions come out of a rich text editor and are sanitised server
    // side. Rendering them as text would show a shopper the tags.
    mock
      .on('GET', '/storefront/collections/bestsellers', {
        ...collection(),
        description: '<p>What sells</p><ul><li>Balm</li></ul>',
      })
      .onList('/storefront/products', [productCard()])

    renderPage(<CollectionPage />, route)

    await screen.findByRole('heading', { name: 'Bestsellers' })
    expect(screen.getByText('What sells').tagName).toBe('P')
    expect(screen.getByText('Balm').tagName).toBe('LI')
  })

  it('asks the server what is in it rather than filtering on rules here', async () => {
    // A dynamic collection's membership is its rules, evaluated on the server
    // at read time. The storefront must never be told what the rules are, and
    // the DTO deliberately does not carry them.
    collectionRoutes()

    renderPage(<CollectionPage />, route)

    await screen.findByRole('heading', { name: 'Bestsellers' })
    const body = await mock.callsTo('GET', '/storefront/collections/bestsellers')
    expect(body).toHaveLength(1)
    expect(screen.queryByText(/rule/i)).not.toBeInTheDocument()
  })

  it('says a collection is empty rather than showing a bare grid', async () => {
    collectionRoutes([])

    renderPage(<CollectionPage />, route)

    expect(await screen.findByText('Nothing in here yet')).toBeInTheDocument()
  })

  it('carries the collection through to the next page', async () => {
    const user = userEvent.setup()
    mock
      .on('GET', '/storefront/collections/bestsellers', collection())
      .onList('/storefront/products', [productCard()], { total: 31, totalPages: 3, hasNext: true })

    renderPage(<CollectionPage />, route)
    await screen.findByText('Copperleaf Classic')

    await user.click(screen.getByRole('button', { name: 'Next' }))

    await waitFor(() => {
      const last = mock.callsTo('GET', '/storefront/products').at(-1).url
      expect(last).toContain('collection=bestsellers')
      expect(last).toContain('page=2')
    })
  })

  it('offers a retry rather than a blank page when the collection fails to load', async () => {
    mock
      .onError('GET', '/storefront/collections/bestsellers', 500, 'INTERNAL_ERROR', 'Boom')
      .onList('/storefront/products', [productCard()])

    renderPage(<CollectionPage />, route)

    expect(await screen.findByText('That did not load')).toBeInTheDocument()
  })
})

// ── The way in ──────────────────────────────────────────────────────────────

describe('HomePage', () => {
  it('offers collections as the way to browse, never categories', async () => {
    mock
      .on('GET', '/storefront/collections', collectionList())
      .onList('/storefront/products', [productCard()])

    renderPage(<HomePage />, { route: '/' })

    const bestsellers = await screen.findByRole('link', { name: /Bestsellers/ })
    expect(bestsellers).toHaveAttribute('href', '/collections/bestsellers')
    expect(screen.queryByRole('link', { name: /categories/i })).not.toBeInTheDocument()
    expect(mock.callsTo('GET', '/storefront/categories')).toHaveLength(0)
  })

  it('draws the shop even when there are no collections yet', async () => {
    mock.on('GET', '/storefront/collections', []).onList('/storefront/products', [productCard()])

    renderPage(<HomePage />, { route: '/' })

    expect(await screen.findByText('Copperleaf Classic')).toBeInTheDocument()
    expect(screen.queryByText('Have a look through')).not.toBeInTheDocument()
  })
})
