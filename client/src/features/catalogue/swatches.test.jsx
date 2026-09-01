import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiMock } from '@/test/apiMock'
import { renderPage } from '@/test/render'
import { cart, colourfulCard, lipstick, productCard } from '@/test/fixtures'
import { ProductPage } from './pages/ProductPage'
import { ProductCard } from './components/ProductCard'
import { ProductListPage } from './pages/ProductListPage'
import {
  chooseValue,
  galleryIndexFor,
  isColourOption,
  selectionOf,
  valueStates,
  variantFor,
} from './variantSelection'
import { fromMinorUnits, toMinorUnits } from './listingFilters'

/**
 * Colours, and choosing by them.
 *
 * What these tests defend:
 *
 *   • **A colour is shown, never guessed.** Every circle is painted with the
 *     hex the merchant set. Nothing here derives a colour from the word
 *     "Mulberry", which is the shortcut that works for "Red" and fails for a
 *     real catalogue.
 *   • **"Sold out" and "never made" are different.** A Deep Brown 40 g does
 *     not exist; a Mulberry 40 g might merely be out. Both are marked, and
 *     differently, because hiding either leaves a shopper guessing.
 *   • **Picking a colour moves the picture.** That is the whole reason the
 *     variant image is published.
 *   • **The picker resolves a variant; it does not price one.** Every figure
 *     on screen is read off the variant the server sent.
 */

let mock

beforeEach(() => {
  mock = apiMock().install()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const route = { route: '/products/velvet-matte', path: '/products/:handle' }

function shopRoutes(product = lipstick()) {
  return mock
    .on('GET', '/storefront/products/velvet-matte', product)
    .onList('/storefront/products', [productCard()])
}

// ── The pure part ───────────────────────────────────────────────────────────

describe('variantSelection', () => {
  it('calls an axis a colour when its values carry one, not when it is named one', () => {
    const product = lipstick()
    expect(isColourOption(product.options[0])).toBe(true)
    // Size has no swatches. A storefront matching on the word "Colour" would
    // also have to know "Shade", "Farbe" and every other catalogue's wording.
    expect(isColourOption(product.options[1])).toBe(false)
  })

  it('resolves a variant from one choice per axis', () => {
    const product = lipstick()
    const chosen = variantFor(product, { Shade: 'val-mulberry', Size: 'val-40g' })
    expect(chosen.id).toBe('var-mul-40')
  })

  it('returns null for a combination nobody stocked', () => {
    const product = lipstick()
    expect(variantFor(product, { Shade: 'val-brown', Size: 'val-40g' })).toBeNull()
  })

  it('separates "not made" from "sold out"', () => {
    const product = lipstick()
    product.variants[1] = { ...product.variants[1], available: false }

    const states = valueStates(product, product.options[1], { Shade: 'val-mulberry' })
    expect(states['val-5g']).toEqual({ exists: true, available: true })
    // Made, and unavailable.
    expect(states['val-40g']).toEqual({ exists: true, available: false })

    const brown = valueStates(product, product.options[1], { Shade: 'val-brown' })
    // Never made at all.
    expect(brown['val-40g']).toEqual({ exists: false, available: false })
  })

  it('repairs the rest of the selection when a choice breaks it', () => {
    // In 40 g, then switch to Deep Brown — which does not come in 40 g. The
    // shopper asked for Deep Brown, so they get it, and the size falls back.
    const product = lipstick()
    const next = chooseValue(
      product,
      { Shade: 'val-mulberry', Size: 'val-40g' },
      product.options[0],
      'val-brown',
    )

    expect(next.Shade).toBe('val-brown')
    expect(next.Size).toBe('val-5g')
    expect(variantFor(product, next)).not.toBeNull()
  })

  it('finds the gallery position of a variant’s own photograph', () => {
    const product = lipstick()
    expect(galleryIndexFor(product, product.variants[0])).toBe(1)
    // A variant with no image of its own leaves the gallery alone.
    expect(galleryIndexFor(product, product.variants[1])).toBeNull()
  })

  it('reads a variant’s choices back out', () => {
    expect(selectionOf(lipstick().variants[0])).toEqual({
      Shade: 'val-mulberry',
      Size: 'val-5g',
    })
  })
})

// ── The product page ────────────────────────────────────────────────────────

describe('ProductPage — swatches', () => {
  it('paints each shade with the colour the server sent', async () => {
    shopRoutes()
    const { container } = renderPage(<ProductPage />, route)

    await screen.findByRole('heading', { name: 'Velvet Matte Lipstick' })
    const swatches = container.querySelectorAll('[style*="background-color"]')
    const colours = [...swatches].map((node) => node.style.backgroundColor)

    // rgb, because that is what the DOM normalises a hex to.
    expect(colours).toContain('rgb(123, 45, 78)') // #7b2d4e
    expect(colours).toContain('rgb(74, 44, 32)') // #4a2c20
  })

  it('names each colour for somebody who cannot see it', async () => {
    shopRoutes()
    renderPage(<ProductPage />, route)

    expect(await screen.findByRole('radio', { name: 'Mulberry' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Deep Brown' })).toBeInTheDocument()
  })

  it('asks one question per axis rather than listing every variant', async () => {
    shopRoutes()
    renderPage(<ProductPage />, route)

    await screen.findByRole('heading', { name: 'Velvet Matte Lipstick' })
    // Two groups — Shade and Size — not one list of "Mulberry / 5 g" chips.
    expect(screen.getByRole('group', { name: /Shade/ })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: /Size/ })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /Mulberry \/ 5 g/ })).not.toBeInTheDocument()
  })

  it('shows the price of the variant chosen, not the range', async () => {
    const user = userEvent.setup()
    shopRoutes()
    renderPage(<ProductPage />, route)

    expect(await screen.findByText('£19.00')).toBeInTheDocument()
    expect(screen.queryByText('From £19.00')).not.toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: '40 g' }))

    expect(await screen.findByText('£34.00')).toBeInTheDocument()
  })

  it('marks a combination nobody made, and refuses the click', async () => {
    const user = userEvent.setup()
    shopRoutes()
    renderPage(<ProductPage />, route)

    await user.click(await screen.findByRole('radio', { name: 'Deep Brown' }))

    // There is no Deep Brown 40 g, and the picker says so rather than
    // pretending and then correcting itself.
    const missing = await screen.findByRole('radio', {
      name: '40 g — not available in this combination',
    })
    expect(missing).toBeDisabled()
  })

  it('keeps a sold-out shade visible and marked', async () => {
    const product = lipstick()
    product.variants = product.variants.map((variant) =>
      variant.id.startsWith('var-brown') ? { ...variant, available: false } : variant,
    )
    shopRoutes(product)
    renderPage(<ProductPage />, route)

    const soldOut = await screen.findByRole('radio', { name: 'Deep Brown — sold out' })
    expect(soldOut).toBeDisabled()
    // Visible, not hidden: somebody comparing shades needs to know it exists.
    expect(soldOut).toBeInTheDocument()
  })

  it('moves the gallery to the photograph of the shade chosen', async () => {
    const user = userEvent.setup()
    shopRoutes()
    renderPage(<ProductPage />, route)

    // Opens on the *default variant's* photograph, not the hero shot: the
    // page's first answer to "what does this look like" should match the
    // shade it has already selected.
    expect(await screen.findByAltText('Mulberry')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Deep Brown' }))

    // Deep Brown's own photograph, published on the variant.
    expect(await screen.findByAltText('Deep Brown')).toBeInTheDocument()
  })

  it('leaves the gallery alone for a variant with no image of its own', async () => {
    const user = userEvent.setup()
    shopRoutes()
    renderPage(<ProductPage />, route)

    // Mulberry 5 g has an image; Mulberry 40 g does not. Choosing the size
    // must not throw the shopper back to the hero shot.
    await screen.findByAltText('Mulberry')

    await user.click(screen.getByRole('radio', { name: '40 g' }))

    expect(screen.getByAltText('Mulberry')).toBeInTheDocument()
  })

  it('lets the shopper browse the gallery by hand', async () => {
    const user = userEvent.setup()
    shopRoutes()
    renderPage(<ProductPage />, route)

    await screen.findByAltText('Mulberry')
    await user.click(screen.getByRole('button', { name: 'Show image 1' }))

    // A hand-picked image sticks: it is pinned to the current variant, so it
    // survives until the shopper chooses a different one.
    expect(screen.getByAltText('Both shades')).toBeInTheDocument()
  })

  it('adds the variant its choices resolved to', async () => {
    const user = userEvent.setup()
    shopRoutes().on('POST', '/storefront/cart/items', cart())
    renderPage(<ProductPage />, route)

    await user.click(await screen.findByRole('radio', { name: 'Deep Brown' }))
    await user.click(screen.getByRole('button', { name: /Add to basket/ }))

    const call = await waitFor(() => {
      const calls = mock.callsTo('POST', '/storefront/cart/items')
      expect(calls).toHaveLength(1)
      return calls[0]
    })
    expect(call.body).toEqual({ variantId: 'var-brown-5', quantity: 1 })
  })
})

// ── The card ────────────────────────────────────────────────────────────────

describe('ProductCard — colours and quick add', () => {
  it('shows the colours a product comes in', () => {
    renderPage(<ProductCard product={colourfulCard()} />)

    const colours = screen.getByRole('list', { name: 'Available colours' })
    expect(within(colours).getByRole('img', { name: 'Mulberry' })).toBeInTheDocument()
    expect(within(colours).getByRole('img', { name: 'Deep Brown' })).toBeInTheDocument()
  })

  it('counts the colours it has no room for rather than cramming them in', () => {
    const many = colourfulCard({
      colours: Array.from({ length: 8 }, (_, index) => ({
        value: `Shade ${index}`,
        swatchHex: '#112233',
      })),
    })
    renderPage(<ProductCard product={many} />)

    expect(screen.getAllByRole('img', { name: /^Shade / })).toHaveLength(5)
    expect(screen.getByText('+3')).toBeInTheDocument()
  })

  it('shows no colour row for a product that has none', () => {
    renderPage(<ProductCard product={productCard()} />)

    expect(screen.queryByRole('list', { name: 'Available colours' })).not.toBeInTheDocument()
  })

  it('fetches the options only when quick add is opened', async () => {
    const user = userEvent.setup()
    mock.on('GET', '/storefront/products/velvet-matte', lipstick())
    renderPage(<ProductCard product={colourfulCard()} />)

    // Nothing yet: a grid of twelve cards must not make twelve requests.
    expect(mock.callsTo('GET', '/storefront/products/velvet-matte')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Quick add Velvet Matte Lipstick' }))

    await waitFor(() =>
      expect(mock.callsTo('GET', '/storefront/products/velvet-matte')).toHaveLength(1),
    )
    expect(await screen.findByRole('radio', { name: 'Mulberry' })).toBeInTheDocument()
  })

  it('adds from the grid without leaving it', async () => {
    const user = userEvent.setup()
    mock
      .on('GET', '/storefront/products/velvet-matte', lipstick())
      .on('POST', '/storefront/cart/items', cart())
    renderPage(<ProductCard product={colourfulCard()} />)

    await user.click(screen.getByRole('button', { name: 'Quick add Velvet Matte Lipstick' }))
    await screen.findByRole('radio', { name: 'Mulberry' })
    await user.click(screen.getByRole('button', { name: 'Add to basket' }))

    const call = await waitFor(() => {
      const calls = mock.callsTo('POST', '/storefront/cart/items')
      expect(calls).toHaveLength(1)
      return calls[0]
    })
    expect(call.body).toEqual({ variantId: 'var-mul-5', quantity: 1 })
  })

  it('offers no quick add on something that cannot be bought', () => {
    renderPage(<ProductCard product={colourfulCard({ available: false })} />)

    expect(screen.queryByRole('button', { name: /Quick add/ })).not.toBeInTheDocument()
  })
})

// ── Sorting and filtering ───────────────────────────────────────────────────

describe('listing filters', () => {
  it('converts what a person types into minor units', () => {
    expect(toMinorUnits('19.99')).toBe(1999)
    expect(toMinorUnits('20')).toBe(2000)
    // An empty box and a typo both mean "no bound" — never zero, which would
    // silently empty the page.
    expect(toMinorUnits('')).toBeNull()
    expect(toMinorUnits('cheap')).toBeNull()
    expect(toMinorUnits('-5')).toBeNull()
  })

  it('converts back for the box', () => {
    expect(fromMinorUnits(1999)).toBe('19.99')
    expect(fromMinorUnits(null)).toBe('')
  })
})

describe('ProductListPage — sort and filter', () => {
  it('sends the sort to the server rather than reordering the page', async () => {
    const user = userEvent.setup()
    mock.onList('/storefront/products', [productCard()])
    renderPage(<ProductListPage />, { route: '/products' })
    await screen.findByText('Copperleaf Classic')

    await user.selectOptions(screen.getByLabelText('Sort products'), 'price_low')

    await waitFor(() => {
      expect(mock.callsTo('GET', '/storefront/products').at(-1).url).toContain('sort=price_low')
    })
  })

  it('sends a price range in minor units', async () => {
    const user = userEvent.setup()
    mock.onList('/storefront/products', [productCard()])
    renderPage(<ProductListPage />, { route: '/products' })
    await screen.findByText('Copperleaf Classic')

    await user.click(screen.getByRole('button', { name: /^Filter/ }))
    await user.type(screen.getByLabelText('Lowest price'), '10')
    await user.type(screen.getByLabelText('Highest price'), '25.50')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      const last = mock.callsTo('GET', '/storefront/products').at(-1).url
      expect(last).toContain('minPrice=1000')
      expect(last).toContain('maxPrice=2550')
    })
  })

  it('sends the in-stock filter to the server', async () => {
    const user = userEvent.setup()
    mock.onList('/storefront/products', [productCard()])
    renderPage(<ProductListPage />, { route: '/products' })
    await screen.findByText('Copperleaf Classic')

    await user.click(screen.getByRole('button', { name: /^Filter/ }))
    await user.click(screen.getByLabelText('In stock only'))

    await waitFor(() => {
      expect(mock.callsTo('GET', '/storefront/products').at(-1).url).toContain('inStock=true')
    })
  })

  it('goes back to page one when a filter narrows the results', async () => {
    // Page 4 of a narrower result may not exist, and a pager pointing at it
    // shows an empty grid with no explanation.
    const user = userEvent.setup()
    mock.onList('/storefront/products', [productCard()], { page: 3, totalPages: 5 })
    renderPage(<ProductListPage />, { route: '/products?page=3' })
    await screen.findByText('Copperleaf Classic')

    await user.selectOptions(screen.getByLabelText('Sort products'), 'newest')

    await waitFor(() => {
      expect(mock.callsTo('GET', '/storefront/products').at(-1).url).not.toContain('page=3')
    })
  })

  it('reads its state out of the URL, so a filtered listing is linkable', async () => {
    mock.onList('/storefront/products', [productCard()])
    renderPage(<ProductListPage />, { route: '/products?sort=price_high&inStock=true' })

    await waitFor(() => {
      const first = mock.callsTo('GET', '/storefront/products')[0].url
      expect(first).toContain('sort=price_high')
      expect(first).toContain('inStock=true')
    })
    expect(screen.getByLabelText('Sort products')).toHaveValue('price_high')
  })
})
