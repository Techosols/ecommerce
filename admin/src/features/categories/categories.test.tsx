import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { jsonResponse } from '@/test/http'
import { renderAuthed } from '@/test/renderAuthed'
import { adminUser, category, staffUser } from '@/test/catalogue'
import { CategoryListPage } from './pages/CategoryListPage'
import { descendantIds, toTree } from './hooks/categories.hooks'

let api: ApiMock

const burgers = category({ id: 'cat-1', name: 'Burgers', handle: 'burgers' })
const sides = category({ id: 'cat-2', name: 'Sides', handle: 'sides', position: 1 })
const fries = category({ id: 'cat-3', name: 'Fries', handle: 'fries', parentId: 'cat-2' })

function baseRoutes(mock: ApiMock, user = adminUser, categories = [burgers, sides, fries]) {
  return mock
    .withSession(user)
    .on('GET', '/admin/categories', categories)
    .on('GET', '/admin/notifications/unread-count', { count: 0 })
}

beforeEach(() => {
  api = apiMock().install()
  tokenStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  tokenStore.clear()
})

// ── The tree, built in the browser from the server's flat list ──────────────

describe('toTree', () => {
  it('nests children under their parent and records the depth', () => {
    const tree = toTree([burgers, sides, fries])

    expect(tree.map((node) => node.id)).toEqual(['cat-1', 'cat-2'])
    expect(tree[1]!.children.map((node) => node.id)).toEqual(['cat-3'])
    expect(tree[1]!.children[0]!.depth).toBe(1)
  })

  it('promotes a node whose parent is missing rather than dropping it', () => {
    // The same rule the server's own tree builder applies: hiding a parent must
    // not make a whole branch disappear.
    const orphan = category({ id: 'cat-9', name: 'Orphan', parentId: 'gone' })
    const tree = toTree([orphan])
    expect(tree.map((node) => node.id)).toEqual(['cat-9'])
  })

  it('blocks a category and its descendants from becoming their own parent', () => {
    // The server refuses this with CATEGORY_CYCLE; the picker never offers it.
    const blocked = descendantIds(toTree([burgers, sides, fries]), 'cat-2')
    expect([...blocked].sort()).toEqual(['cat-2', 'cat-3'])
  })
})

// ── Listing ─────────────────────────────────────────────────────────────────

describe('CategoryListPage', () => {
  it('lists categories as a hierarchy', async () => {
    baseRoutes(api)
    await renderAuthed(<CategoryListPage />, { route: '/categories' })

    expect(await screen.findByText('Burgers')).toBeInTheDocument()
    const table = screen.getByRole('table')
    // Depth-first: a child follows its parent.
    const names = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0]?.textContent ?? '')
    expect(names[1]).toContain('Sides')
    expect(names[2]).toContain('Fries')
  })

  it('filters in the browser and keeps a match’s ancestors visible', async () => {
    const user = userEvent.setup()
    baseRoutes(api)
    await renderAuthed(<CategoryListPage />, { route: '/categories' })
    await screen.findByText('Burgers')

    await user.type(screen.getByLabelText('Search categories'), 'fries')

    await waitFor(() => expect(screen.queryByText('Burgers')).not.toBeInTheDocument())
    expect(screen.getByText('Fries')).toBeInTheDocument()
    // Sides is not a match but is Fries' parent — a child shown without its
    // parent stops being a tree.
    expect(screen.getByText('Sides')).toBeInTheDocument()

    // The list endpoint takes no search parameter, so nothing was refetched.
    expect(api.callsTo('GET', '/admin/categories')).toHaveLength(1)
  })

  it('shows an empty state when there are no categories', async () => {
    baseRoutes(api, adminUser, [])
    await renderAuthed(<CategoryListPage />, { route: '/categories' })

    expect(await screen.findByText('No categories yet')).toBeInTheDocument()
  })

  it('shows an error state with a retry when the list fails', async () => {
    api
      .withSession(adminUser)
      .onError('GET', '/admin/categories', 500, 'INTERNAL_ERROR', 'Something broke')

    await renderAuthed(<CategoryListPage />, { route: '/categories' })

    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('hides every write action from an operator with only catalog:read', async () => {
    baseRoutes(api, staffUser)
    await renderAuthed(<CategoryListPage />, { route: '/categories' })
    await screen.findByText('Burgers')

    expect(screen.queryByRole('button', { name: 'Add category' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument()
  })
})

// ── Creating and editing ────────────────────────────────────────────────────

describe('category form', () => {
  it('creates a category, deriving the handle from the name', async () => {
    const user = userEvent.setup()
    baseRoutes(api).on('POST', '/admin/categories', () =>
      jsonResponse(201, { success: true, data: category({ id: 'cat-new', name: 'Hot Drinks' }) }),
    )

    await renderAuthed(<CategoryListPage />, { route: '/categories' })
    await user.click(await screen.findByRole('button', { name: 'Add category' }))

    await user.type(screen.getByLabelText(/^name/i), 'Hot Drinks')
    await user.click(screen.getByRole('button', { name: 'Create category' }))

    await waitFor(() => expect(api.callsTo('POST', '/admin/categories')).toHaveLength(1))
    expect(api.callsTo('POST', '/admin/categories')[0]!.body).toEqual({
      name: 'Hot Drinks',
      handle: 'hot-drinks',
    })
  })

  it('creates a child under the row it was started from', async () => {
    const user = userEvent.setup()
    baseRoutes(api).on('POST', '/admin/categories', () =>
      jsonResponse(201, { success: true, data: category({ id: 'cat-new', name: 'Onion Rings' }) }),
    )

    await renderAuthed(<CategoryListPage />, { route: '/categories' })
    await user.click(await screen.findByRole('button', { name: 'Actions for Sides' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add a sub-category' }))

    await user.type(screen.getByLabelText(/^name/i), 'Onion Rings')
    await user.click(screen.getByRole('button', { name: 'Create category' }))

    await waitFor(() => expect(api.callsTo('POST', '/admin/categories')).toHaveLength(1))
    expect(api.callsTo('POST', '/admin/categories')[0]!.body).toMatchObject({ parentId: 'cat-2' })
  })

  it('refuses an empty name without sending anything', async () => {
    const user = userEvent.setup()
    baseRoutes(api).on('POST', '/admin/categories', () =>
      jsonResponse(201, { success: true, data: category() }),
    )

    await renderAuthed(<CategoryListPage />, { route: '/categories' })
    await user.click(await screen.findByRole('button', { name: 'Add category' }))
    await user.click(screen.getByRole('button', { name: 'Create category' }))

    expect(await screen.findByText('A category needs a name.')).toBeInTheDocument()
    expect(api.callsTo('POST', '/admin/categories')).toHaveLength(0)
  })

  it("surfaces the server's field errors on the input that caused them", async () => {
    const user = userEvent.setup()
    baseRoutes(api).on('POST', '/admin/categories', () =>
      jsonResponse(422, {
        success: false,
        code: 'VALIDATION_FAILED',
        message: 'Validation failed',
        details: [{ path: 'body.handle', message: 'That handle is already used' }],
      }),
    )

    await renderAuthed(<CategoryListPage />, { route: '/categories' })
    await user.click(await screen.findByRole('button', { name: 'Add category' }))
    await user.type(screen.getByLabelText(/^name/i), 'Burgers')
    await user.click(screen.getByRole('button', { name: 'Create category' }))

    expect(await screen.findByText('That handle is already used')).toBeInTheDocument()
  })

  it('edits a category and sends only the changed fields', async () => {
    const user = userEvent.setup()
    baseRoutes(api).on('PATCH', '/admin/categories/cat-1', () =>
      jsonResponse(200, { success: true, data: category({ name: 'Beef Burgers' }) }),
    )

    await renderAuthed(<CategoryListPage />, { route: '/categories' })
    await user.click(await screen.findByRole('button', { name: 'Actions for Burgers' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))

    const name = screen.getByLabelText(/^name/i)
    await user.clear(name)
    await user.type(name, 'Beef Burgers')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.callsTo('PATCH', '/admin/categories/cat-1')).toHaveLength(1))
    // The handle, parent, description and position were untouched and must not
    // be in the request.
    expect(api.callsTo('PATCH', '/admin/categories/cat-1')[0]!.body).toEqual({
      name: 'Beef Burgers',
    })
  })

  it('does not offer a category itself or its descendants as its own parent', async () => {
    const user = userEvent.setup()
    baseRoutes(api)

    await renderAuthed(<CategoryListPage />, { route: '/categories' })
    await user.click(await screen.findByRole('button', { name: 'Actions for Sides' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))

    const parent = screen.getByLabelText(/^parent/i)
    const options = within(parent).getAllByRole('option').map((option) => option.textContent?.trim())
    expect(options).toContain('Burgers')
    expect(options).not.toContain('Sides')
    expect(options).not.toContain('Fries')
  })

  it('does not send a PATCH when nothing changed', async () => {
    const user = userEvent.setup()
    baseRoutes(api)

    await renderAuthed(<CategoryListPage />, { route: '/categories' })
    await user.click(await screen.findByRole('button', { name: 'Actions for Burgers' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.callsTo('PATCH', '/admin/categories/cat-1')).toHaveLength(0)
  })
})

// ── Archiving ───────────────────────────────────────────────────────────────

describe('archiving a category', () => {
  it('confirms first, then calls DELETE', async () => {
    const user = userEvent.setup()
    baseRoutes(api).on('DELETE', '/admin/categories/cat-1', () => new Response(null, { status: 204 }))

    await renderAuthed(<CategoryListPage />, { route: '/categories' })
    await user.click(await screen.findByRole('button', { name: 'Actions for Burgers' }))
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }))

    expect(api.callsTo('DELETE', '/admin/categories/cat-1')).toHaveLength(0)

    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Archive category' }))

    await waitFor(() => expect(api.callsTo('DELETE', '/admin/categories/cat-1')).toHaveLength(1))
  })

  it('reports the server’s refusal when products still point at the category', async () => {
    const user = userEvent.setup()
    baseRoutes(api).onError(
      'DELETE',
      '/admin/categories/cat-1',
      409,
      'CATEGORY_IN_USE',
      '3 product(s) are still in this category — move them first',
    )

    await renderAuthed(<CategoryListPage />, { route: '/categories' })
    await user.click(await screen.findByRole('button', { name: 'Actions for Burgers' }))
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }))
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive category' }),
    )

    // The refusal is expected behaviour, not a fault: the server will not
    // silently re-classify the products inside.
    expect(await screen.findByText('That category is still in use')).toBeInTheDocument()
    expect(
      screen.getByText('3 product(s) are still in this category — move them first'),
    ).toBeInTheDocument()
    // The category is still there.
    expect(screen.getByText('Burgers')).toBeInTheDocument()
  })
})
