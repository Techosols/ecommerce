import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'
import { apiMock } from '@/test/apiMock'
import { renderPage } from '@/test/render'
import { category, categoryTree, productCard } from '@/test/fixtures'
import { CategoryPage } from './pages/CategoryPage'
import { findCategory, flattenCategories, pathToCategory } from './categoryTree'

/**
 * Browsing by category.
 *
 * A category is the merchant's own taxonomy — one file per product, in a tree
 * that with a seeded catalogue runs to thousands of nodes. So the shop never
 * renders the whole thing: the header shows the top level, and each page offers
 * its own children, which is what makes the depth walkable rather than
 * overwhelming.
 *
 * What these tests defend: the page says where you are, offers where to go
 * next, and asks the server for the products rather than filtering any here.
 */

let mock

beforeEach(() => {
  mock = apiMock().install()
})
afterEach(cleanup)

function open(overrides = {}, products = [productCard()]) {
  mock
    .on('GET', '/storefront/categories/lips', category(overrides))
    .on('GET', '/storefront/categories', categoryTree())
    .onList('/storefront/products', products)

  return renderPage(<CategoryPage />, {
    route: '/categories/lips',
    path: '/categories/:handle',
  })
}

describe('the category page', () => {
  it('narrows the products to the category in the URL', async () => {
    // By handle, never by id: an address a person can read, type and link to.
    open()

    expect(await screen.findByRole('heading', { name: 'Lips' })).toBeInTheDocument()
    expect(mock.callsTo('GET', '/storefront/products')[0].url).toContain('category=lips')
  })

  it('shows the trail back to the root', async () => {
    open()

    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getByRole('link', { name: 'Make-up' })).toBeInTheDocument()
  })

  it('does not link the crumb you are standing on', async () => {
    // A breadcrumb whose last crumb navigates to the page you are already on is
    // a control that appears to do something and does nothing.
    open()

    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).queryByRole('link', { name: 'Lips' })).not.toBeInTheDocument()
    expect(within(crumbs).getByText('Lips')).toHaveAttribute('aria-current', 'page')
  })

  it('offers the categories below this one', async () => {
    // The children come from the tree, which the header has already fetched —
    // so walking down three levels costs no extra requests.
    open()

    const within_ = await screen.findByRole('navigation', { name: /Categories within/ })
    expect(within(within_).getByRole('link', { name: 'Balms' })).toHaveAttribute(
      'href',
      '/categories/balms',
    )
    expect(within(within_).getByRole('link', { name: 'Lipstick' })).toBeInTheDocument()
  })

  it('renders the description as the HTML the admin wrote', async () => {
    open()
    expect((await screen.findByText('Balms and colour.')).tagName).toBe('P')
  })

  it('points at the groups below when a parent holds no products of its own', async () => {
    // Common with a real taxonomy: everything files at the leaves. "Nothing
    // here" with no way onward would read as a broken shop.
    open({}, [])

    expect(await screen.findByText(/organised into the groups above/)).toBeInTheDocument()
  })
})

describe('walking the tree', () => {
  const tree = categoryTree()

  it('finds a node however deep it is', () => {
    expect(findCategory(tree, 'lipstick')?.name).toBe('Lipstick')
    expect(findCategory(tree, 'nothing')).toBeNull()
    expect(findCategory(tree, undefined)).toBeNull()
  })

  it('gives the path from the root, for an open menu branch', () => {
    expect(pathToCategory(tree, 'lipstick')).toEqual(['lips', 'lipstick'])
    expect(pathToCategory(tree, 'skin')).toEqual(['skin'])
    expect(pathToCategory(tree, 'gone')).toEqual([])
  })

  it('flattens with depth, keeping the server’s order', () => {
    // The order is the merchant's arrangement. Re-sorting here would show
    // something different from what they set up.
    expect(flattenCategories(tree).map((node) => [node.handle, node.depth])).toEqual([
      ['lips', 0],
      ['balms', 1],
      ['lipstick', 1],
      ['skin', 0],
    ])
  })
})
