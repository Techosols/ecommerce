import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { jsonResponse } from '@/test/http'
import { renderAuthed } from '@/test/renderAuthed'
import {
  adminUser,
  customerDetail,
  customerEvent,
  customerSegment,
  customerSummary,
  ruleFields,
  staffUser,
} from '@/test/catalogue'
import { CustomerDetailPage } from './pages/CustomerDetailPage'
import { CustomerListPage } from './pages/CustomerListPage'
import { SegmentsPage } from './pages/SegmentsPage'

/**
 * Customers and segments.
 *
 * The things worth holding: consent is four states and never a switch, every
 * narrowing is a server parameter rather than an array filtered in the browser,
 * the rule builder is generated from the server's own field table, and the one
 * destructive action names what disappears before it happens.
 */

let api: ApiMock

// Sub-resources are registered before their prefix: `apiMock` matches by
// substring, so `/admin/customers/cus-1` would otherwise swallow `/events`.
function baseRoutes(mock: ApiMock, user = adminUser) {
  return mock
    .withSession(user)
    .on('GET', '/storefront/settings', { currency: 'GBP', storeName: 'Test' })
    .on('GET', '/admin/notifications/unread-count', { count: 0 })
    .on('GET', '/admin/customers/segments/fields', ruleFields())
    .on('GET', '/admin/customers/segments', [customerSegment()])
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

describe('CustomerListPage', () => {
  it('shows what each customer is worth, read from the server', async () => {
    baseRoutes(api).onList('/admin/customers', [customerSummary()])

    await renderAuthed(<CustomerListPage />, { route: '/customers' })

    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument()
    const body = screen.getByRole('table').querySelector('tbody')!
    expect(within(body).getByText('£120.00')).toBeInTheDocument()
    // The average comes from the server too, not from dividing in the browser.
    expect(within(body).getByText('£40.00 average')).toBeInTheDocument()
  })

  it('keeps "never asked" and "said no" visibly apart', async () => {
    baseRoutes(api).onList('/admin/customers', [
      customerSummary(),
      customerSummary({
        id: 'cus-2',
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        marketing: { email: 'unsubscribed', sms: 'not_subscribed', optInLevel: null },
      }),
    ])

    await renderAuthed(<CustomerListPage />, { route: '/customers' })
    await screen.findByText('Grace Hopper')

    const body = screen.getByRole('table').querySelector('tbody')!
    expect(within(body).getByText('Subscribed')).toBeInTheDocument()
    expect(within(body).getByText('Unsubscribed')).toBeInTheDocument()
  })

  it('narrows on the server and keeps the filter in the URL', async () => {
    const user = userEvent.setup()
    baseRoutes(api).onList('/admin/customers', [customerSummary()])

    await renderAuthed(<CustomerListPage />, { route: '/customers' })
    await screen.findByText('Grace Hopper')

    await user.click(screen.getByRole('button', { name: 'More filters' }))
    await user.selectOptions(screen.getByLabelText('Email marketing'), 'unsubscribed')

    await waitFor(() =>
      expect(api.callsTo('GET', 'marketingEmailState=unsubscribed').length).toBeGreaterThan(0),
    )
  })

  it('sends the segment as a filter rather than fetching its members', async () => {
    const user = userEvent.setup()
    baseRoutes(api).onList('/admin/customers', [customerSummary()])

    await renderAuthed(<CustomerListPage />, { route: '/customers' })
    await screen.findByText('Grace Hopper')

    // The segment list is its own request; wait for it before choosing one.
    await screen.findByRole('option', { name: 'Big spenders' })
    await user.selectOptions(screen.getByLabelText('Segment'), 'seg-1')

    await waitFor(() =>
      expect(api.callsTo('GET', 'segmentId=seg-1').length).toBeGreaterThan(0),
    )
  })

  it('exports with the filters that are on screen', async () => {
    const user = userEvent.setup()
    baseRoutes(api)
      .onList('/admin/customers', [customerSummary()])
      .on('GET', '/admin/customers/export', () =>
        jsonResponse(200, { success: true, data: [] }),
      )

    await renderAuthed(<CustomerListPage />, { route: '/customers?minSpent=50' })
    await screen.findByText('Grace Hopper')

    await user.click(screen.getByRole('button', { name: 'Export' }))

    await waitFor(() => {
      const [call] = api.callsTo('GET', '/admin/customers/export')
      // Major units on screen, minor units on the wire.
      expect(call?.url).toContain('minSpent=5000')
    })
  })

  it('hides the writes from an operator who cannot make them', async () => {
    baseRoutes(api, staffUser).onList('/admin/customers', [customerSummary()])

    await renderAuthed(<CustomerListPage />, { route: '/customers' })
    await screen.findByText('Grace Hopper')

    expect(screen.queryByRole('button', { name: 'New customer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Rebuild totals/ })).not.toBeInTheDocument()
  })
})

// ── One customer ────────────────────────────────────────────────────────────

describe('CustomerDetailPage', () => {
  function detailRoutes(mock: ApiMock, user = adminUser, detail = customerDetail()) {
    return baseRoutes(mock, user)
      .on('GET', '/admin/customers/cus-1/events', [customerEvent()])
      .onList('/admin/orders', [])
      .on('GET', '/admin/customers/cus-1', () =>
        jsonResponse(200, { success: true, data: detail }),
      )
  }

  const route = { route: '/customers/cus-1', path: '/customers/:id' }

  it('shows the lifetime figures as the server sends them', async () => {
    detailRoutes(api)
    await renderAuthed(<CustomerDetailPage />, route)

    expect(await screen.findByRole('heading', { name: 'Grace Hopper' })).toBeInTheDocument()
    expect(screen.getByText('£120.00')).toBeInTheDocument()
    expect(screen.getByText('£40.00')).toBeInTheDocument()
  })

  it('offers consent as four states, not a switch', async () => {
    detailRoutes(api)
    await renderAuthed(<CustomerDetailPage />, route)
    await screen.findByRole('heading', { name: 'Grace Hopper' })

    const email = screen.getByLabelText('Email')
    expect(email).toHaveValue('subscribed')
    expect(within(email as HTMLSelectElement).getByText('Not subscribed')).toBeInTheDocument()
    expect(within(email as HTMLSelectElement).getByText('Unsubscribed')).toBeInTheDocument()
  })

  it('sends a consent change as its own request, with the channel', async () => {
    const user = userEvent.setup()
    detailRoutes(api).on('PATCH', '/admin/customers/cus-1/marketing', () =>
      jsonResponse(200, {
        success: true,
        data: customerSummary({
          marketing: { email: 'unsubscribed', sms: 'not_subscribed', optInLevel: null },
        }),
      }),
    )

    await renderAuthed(<CustomerDetailPage />, route)
    await screen.findByRole('heading', { name: 'Grace Hopper' })

    await user.selectOptions(screen.getByLabelText('Email'), 'unsubscribed')

    await waitFor(() => {
      const [call] = api.callsTo('PATCH', '/admin/customers/cus-1/marketing')
      expect(call?.body).toMatchObject({ channel: 'email', state: 'unsubscribed' })
    })
  })

  it('saves only the fields that changed', async () => {
    const user = userEvent.setup()
    detailRoutes(api).on('PATCH', '/admin/customers/cus-1', () =>
      jsonResponse(200, { success: true, data: customerSummary({ firstName: 'Grace B' }) }),
    )

    await renderAuthed(<CustomerDetailPage />, route)
    await screen.findByRole('heading', { name: 'Grace Hopper' })

    await user.clear(screen.getByLabelText('First name'))
    await user.type(screen.getByLabelText('First name'), 'Grace B')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      const [call] = api.callsTo('PATCH', '/admin/customers/cus-1')
      expect(call?.body).toMatchObject({ firstName: 'Grace B' })
    })
  })

  it('sends only the tags that changed, as an add and a remove', async () => {
    const user = userEvent.setup()
    detailRoutes(api)
      .on('POST', '/admin/customers/cus-1/tags', () =>
        jsonResponse(200, { success: true, data: customerSummary({ tags: ['trade'] }) }),
      )
      .on('DELETE', '/admin/customers/cus-1/tags', () =>
        jsonResponse(200, { success: true, data: customerSummary({ tags: [] }) }),
      )

    await renderAuthed(<CustomerDetailPage />, route)
    await screen.findByRole('heading', { name: 'Grace Hopper' })

    await user.type(screen.getByPlaceholderText('wholesale, vip…'), 'trade{Enter}')
    await user.click(screen.getByRole('button', { name: 'Save tags' }))

    await waitFor(() => {
      const [call] = api.callsTo('POST', '/admin/customers/cus-1/tags')
      // Only the new one: `vip` was already there and is not resent.
      expect(call?.body).toMatchObject({ tags: ['trade'] })
    })
  })

  it('shows a consent change on the timeline with where it moved from', async () => {
    baseRoutes(api)
      .on('GET', '/admin/customers/cus-1/events', [
        customerEvent({
          id: 'evt-2',
          kind: 'marketing.consent_changed',
          body: null,
          metadata: { channel: 'email', from: 'not_subscribed', to: 'subscribed' },
        }),
      ])
      .onList('/admin/orders', [])
      .on('GET', '/admin/customers/cus-1', customerDetail())

    await renderAuthed(<CustomerDetailPage />, route)

    expect(await screen.findByText('Email marketing')).toBeInTheDocument()
    expect(screen.getByText('Not subscribed → Subscribed')).toBeInTheDocument()
  })

  it('does not offer to delete a system observation', async () => {
    baseRoutes(api)
      .on('GET', '/admin/customers/cus-1/events', [
        customerEvent({ id: 'evt-3', kind: 'account.created_by_staff', body: null }),
      ])
      .onList('/admin/orders', [])
      .on('GET', '/admin/customers/cus-1', customerDetail())

    await renderAuthed(<CustomerDetailPage />, route)
    await screen.findByText('Created by staff')

    expect(screen.queryByRole('button', { name: 'Delete this note' })).not.toBeInTheDocument()
  })

  it('names what disappears before merging, and does not merge on one click', async () => {
    const user = userEvent.setup()
    detailRoutes(api).onList('/admin/customers', [
      customerSummary({ id: 'cus-2', email: 'duplicate@example.com' }),
    ])

    await renderAuthed(<CustomerDetailPage />, route)
    await screen.findByRole('heading', { name: 'Grace Hopper' })

    await user.click(screen.getByRole('button', { name: 'Merge' }))
    await user.type(screen.getByLabelText('Search for the duplicate customer'), 'duplicate')

    const candidate = await screen.findByText('duplicate@example.com')
    await user.click(candidate)

    expect(await screen.findByText('This cannot be undone')).toBeInTheDocument()
    // Nothing has been sent: the operator still has to press the button.
    expect(api.callsTo('POST', '/merge')).toHaveLength(0)
  })

  it('warns that disabling ends every session, and asks first', async () => {
    const user = userEvent.setup()
    detailRoutes(api)

    await renderAuthed(<CustomerDetailPage />, route)
    await screen.findByRole('heading', { name: 'Grace Hopper' })

    await user.click(screen.getByRole('button', { name: 'Disable account' }))

    expect(await screen.findByText('Disable this account?')).toBeInTheDocument()
    expect(screen.getByText(/signed out everywhere/)).toBeInTheDocument()
    expect(api.callsTo('PATCH', '/status')).toHaveLength(0)
  })

  it('gives an operator without write permission a read-only record', async () => {
    detailRoutes(api, staffUser)

    await renderAuthed(<CustomerDetailPage />, route)
    await screen.findByRole('heading', { name: 'Grace Hopper' })

    expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('First name')).toBeDisabled()
  })
})

// ── Segments ────────────────────────────────────────────────────────────────

describe('SegmentsPage', () => {
  it('shows the live member count', async () => {
    baseRoutes(api)
    await renderAuthed(<SegmentsPage />, { route: '/customers/segments' })

    expect(await screen.findByText('Big spenders')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
  })

  it('builds rules only from the fields the server publishes', async () => {
    const user = userEvent.setup()
    baseRoutes(api).on('POST', '/admin/customers/segments/preview', {
      memberCount: 4,
      summary: 'Total spent is at least 5000',
      sample: [{ id: 'cus-1', email: 'grace@example.com', name: 'Grace Hopper' }],
    })

    await renderAuthed(<SegmentsPage />, { route: '/customers/segments' })
    await screen.findByText('Big spenders')

    await user.click(screen.getByRole('button', { name: 'New segment' }))
    await user.click(await screen.findByRole('button', { name: 'Add condition' }))

    const field = screen.getByLabelText('Condition 1 field')
    // Exactly the catalogue, and nothing invented in the browser.
    expect(within(field as HTMLSelectElement).getByText('Total spent')).toBeInTheDocument()
    expect(within(field as HTMLSelectElement).queryByText('Password')).not.toBeInTheDocument()
  })

  it('previews a rule set without saving it', async () => {
    const user = userEvent.setup()
    baseRoutes(api).on('POST', '/admin/customers/segments/preview', {
      memberCount: 4,
      summary: 'Total spent is at least 5000',
      sample: [{ id: 'cus-1', email: 'grace@example.com', name: 'Grace Hopper' }],
    })

    await renderAuthed(<SegmentsPage />, { route: '/customers/segments' })
    await screen.findByText('Big spenders')
    await user.click(screen.getByRole('button', { name: 'New segment' }))

    expect(await screen.findByText('4')).toBeInTheDocument()
    expect(screen.getByText('grace@example.com')).toBeInTheDocument()
    // A preview is not a save.
    expect(api.callsTo('POST', '/admin/customers/segments').filter((call) =>
      !call.url.includes('preview'),
    )).toHaveLength(0)
  })

  it('drops a half-typed condition instead of sending a rule the server refuses', async () => {
    const user = userEvent.setup()
    baseRoutes(api)
      .on('POST', '/admin/customers/segments/preview', {
        memberCount: 0,
        summary: 'Every customer',
        sample: [],
      })
      .on('POST', '/admin/customers/segments', () =>
        jsonResponse(201, { success: true, data: customerSegment({ name: 'Quiet' }) }),
      )

    await renderAuthed(<SegmentsPage />, { route: '/customers/segments' })
    await screen.findByText('Big spenders')
    await user.click(screen.getByRole('button', { name: 'New segment' }))

    await user.type(await screen.findByLabelText(/^Name/), 'Quiet')
    await user.click(screen.getByRole('button', { name: 'Add condition' }))
    await user.click(screen.getByRole('button', { name: 'Create segment' }))

    await waitFor(() => {
      const [call] = api
        .callsTo('POST', '/admin/customers/segments')
        .filter((entry) => !entry.url.includes('preview'))
      expect(call?.body).toMatchObject({ name: 'Quiet', rules: { conditions: [] } })
    })
  })

  it('says what a deletion does before doing it', async () => {
    const user = userEvent.setup()
    baseRoutes(api)

    await renderAuthed(<SegmentsPage />, { route: '/customers/segments' })
    await screen.findByText('Big spenders')

    await user.click(screen.getByRole('button', { name: /Delete/ }))

    expect(await screen.findByText('Delete "Big spenders"?')).toBeInTheDocument()
    expect(screen.getByText(/No customer is changed or removed/)).toBeInTheDocument()
    expect(api.callsTo('DELETE', '/admin/customers/segments/seg-1')).toHaveLength(0)
  })
})
