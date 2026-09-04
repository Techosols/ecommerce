import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { renderAuthed } from '@/test/renderAuthed'
import { ownerUser } from '@/test/catalogue'
import { jsonResponse } from '@/test/http'
import { MetafieldsPage } from './pages/MetafieldsPage'
import { MetafieldsCard } from './components/MetafieldsCard'
import type { MetafieldDefinition, MetafieldEntry } from './types/metafields.types'

/**
 * Custom fields in the admin.
 *
 * What is worth holding down is the handful of places this could quietly
 * mislead somebody:
 *
 *   • **The form comes from the definitions**, so a long-text field is a
 *     textarea and a whole number is a number input — nobody hand-wrote either.
 *   • **Visibility is stated, not implied.** A field customers can see says so,
 *     everywhere it appears.
 *   • **Deleting names the damage** — the count of values, not "are you sure?".
 *   • **A record with no fields shows nothing**, rather than an empty card on
 *     every product page forever.
 */

let api: ApiMock

function definition(overrides: Partial<MetafieldDefinition> = {}): MetafieldDefinition {
  return {
    id: 'def-1',
    ownerType: 'product',
    namespace: 'custom',
    key: 'ingredients',
    name: 'Ingredients',
    description: null,
    type: 'multi_line_text',
    validations: {},
    required: false,
    storefrontVisible: true,
    position: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    valueCount: 0,
    ...overrides,
  }
}

function entry(overrides: Partial<MetafieldEntry> = {}): MetafieldEntry {
  return {
    definitionId: 'def-1',
    namespace: 'custom',
    key: 'ingredients',
    name: 'Ingredients',
    description: null,
    type: 'multi_line_text',
    validations: {},
    required: false,
    storefrontVisible: true,
    value: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function routes(mock: ApiMock, overrides: (m: ApiMock) => ApiMock = (m) => m, user = ownerUser) {
  return overrides(mock)
    .withSession(user)
    .on('GET', '/storefront/settings', { currency: 'GBP', storeName: 'Test' })
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

describe('the definitions screen', () => {
  it('says which fields customers can see and which are staff only', async () => {
    routes(api, (mock) =>
      mock.on('GET', '/admin/metafields/definitions', [
        definition({ storefrontVisible: true }),
        definition({
          id: 'def-2',
          key: 'supplier_code',
          name: 'Supplier code',
          type: 'single_line_text',
          storefrontVisible: false,
        }),
      ]),
    )
    await renderAuthed(<MetafieldsPage />, { route: '/settings/custom-fields' })

    expect(await screen.findByText('Ingredients')).toBeInTheDocument()
    expect(screen.getByText('Customers can see this')).toBeInTheDocument()
    expect(screen.getByText('Staff only')).toBeInTheDocument()
  })

  it('names how many values a delete would destroy', async () => {
    routes(api, (mock) =>
      mock.on('GET', '/admin/metafields/definitions', [definition({ valueCount: 340 })]),
    )
    await renderAuthed(<MetafieldsPage />, { route: '/settings/custom-fields' })

    await userEvent.click(await screen.findByRole('button', { name: 'Delete Ingredients' }))

    // The count is the decision being asked for. "Are you sure?" is not.
    expect(await screen.findByText(/the 340 values already filled in/i)).toBeInTheDocument()
  })

  it('will not let the type be changed once the field exists', async () => {
    routes(api, (mock) =>
      mock.on('GET', '/admin/metafields/definitions', [definition({ valueCount: 5 })]),
    )
    await renderAuthed(<MetafieldsPage />, { route: '/settings/custom-fields' })

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText(/^Type/)).toBeDisabled()
    expect(within(dialog).getByText(/values are already stored against it/i)).toBeInTheDocument()
  })

  it('offers no way to add a field without the settings permission', async () => {
    routes(
      api,
      (mock) => mock.on('GET', '/admin/metafields/definitions', [definition()]),
      // Can open the screen (settings:read) but not change what fields exist.
      { ...ownerUser, permissions: ownerUser.permissions.filter((p) => p !== 'settings:write') },
    )
    await renderAuthed(<MetafieldsPage />, { route: '/settings/custom-fields' })

    await screen.findByText('Ingredients')
    expect(screen.queryByRole('button', { name: /add a field/i })).not.toBeInTheDocument()
  })
})

describe('the editor on a record', () => {
  it('renders nothing at all when no fields are defined', async () => {
    routes(api, (mock) => mock.on('GET', '/admin/metafields/product/p-1', []))
    const { container } = await renderAuthed(
      <MetafieldsCard ownerType="product" ownerId="p-1" canWrite />,
    )

    // An empty card on every product page forever is a permanent cost for a
    // shop that never defines a field.
    await waitFor(() => expect(container.querySelector('form, section')).toBeNull())
    expect(screen.queryByText('Custom fields')).not.toBeInTheDocument()
  })

  it('builds the input from the definition, not from the page', async () => {
    routes(api, (mock) =>
      mock.on('GET', '/admin/metafields/product/p-1', [
        entry({ type: 'multi_line_text', name: 'Ingredients' }),
        entry({
          definitionId: 'def-2',
          key: 'spf',
          name: 'SPF',
          type: 'integer',
          validations: { min: 0, max: 50 },
        }),
      ]),
    )
    await renderAuthed(<MetafieldsCard ownerType="product" ownerId="p-1" canWrite />)

    expect(await screen.findByLabelText(/Ingredients/)).toHaveProperty('tagName', 'TEXTAREA')
    const spf = screen.getByLabelText(/SPF/)
    expect(spf).toHaveAttribute('type', 'number')
    // The definition's bounds reach the input, so the browser helps before the
    // server has to refuse.
    expect(spf).toHaveAttribute('max', '50')
  })

  it('turns a list of choices into a dropdown', async () => {
    routes(api, (mock) =>
      mock.on('GET', '/admin/metafields/product/p-1', [
        entry({
          key: 'skin_type',
          name: 'Skin type',
          type: 'single_line_text',
          validations: { choices: ['Dry', 'Oily'] },
        }),
      ]),
    )
    await renderAuthed(<MetafieldsCard ownerType="product" ownerId="p-1" canWrite />)

    const select = await screen.findByLabelText(/Skin type/)
    expect(select).toHaveProperty('tagName', 'SELECT')
    expect(within(select as HTMLElement).getByRole('option', { name: 'Oily' })).toBeInTheDocument()
  })

  it('saves what was typed and reports the server’s own refusal', async () => {
    let sent: unknown = null
    routes(api, (mock) =>
      mock
        .on('PUT', '/admin/metafields/product/p-1', (request) => {
          sent = request.body
          return jsonResponse(422, {
            success: false,
            message: 'SPF must be 50 or less',
            code: 'VALIDATION_FAILED',
          })
        })
        .on('GET', '/admin/metafields/product/p-1', [
          entry({ key: 'spf', name: 'SPF', type: 'integer' }),
        ]),
    )
    await renderAuthed(<MetafieldsCard ownerType="product" ownerId="p-1" canWrite />)

    await userEvent.type(await screen.findByLabelText(/SPF/), '90')
    await userEvent.click(screen.getByRole('button', { name: /save fields/i }))

    // The server's sentence names the field and what is wrong with it, which a
    // generic "could not save" would throw away.
    expect(await screen.findByText('SPF must be 50 or less')).toBeInTheDocument()
    expect(sent).toEqual({ values: [{ definitionId: 'def-1', value: '90' }] })
  })

  it('shows the values read-only to somebody who cannot edit the record', async () => {
    routes(api, (mock) =>
      mock.on('GET', '/admin/metafields/product/p-1', [entry({ value: 'Water, glycerin' })]),
    )
    await renderAuthed(<MetafieldsCard ownerType="product" ownerId="p-1" canWrite={false} />)

    expect(await screen.findByLabelText(/Ingredients/)).toBeDisabled()
    expect(screen.queryByRole('button', { name: /save fields/i })).not.toBeInTheDocument()
  })
})
