import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { renderAuthed } from '@/test/renderAuthed'
import { ownerUser, storeSettings } from '@/test/catalogue'
import { EmailsPage } from './pages/EmailsPage'

/**
 * The emails screen.
 *
 * What these tests defend, learned the hard way from three rounds of "nobody
 * got the email":
 *
 *   • **An address is never silently altered.** The field used to cap entries at
 *     forty characters and quietly truncate anything longer, which produced an
 *     address belonging to nobody, a save the server rejected, and an operator
 *     looking at a list they believed they had just saved.
 *   • **The delivery log tells the causes apart.** "Sent" and "failed with a
 *     reason" are different problems with different fixes, and from an empty
 *     inbox they are identical.
 *   • **The log carries no message bodies.** An operations screen about delivery
 *     must not become a second place to read customers' addresses.
 */

let api: ApiMock

const templates = [
  { template: 'order-placed', enabled: true, alwaysOn: false, alwaysOnReason: null, updatedAt: null },
  {
    template: 'admin-order-placed',
    enabled: true,
    alwaysOn: false,
    alwaysOnReason: null,
    updatedAt: null,
  },
  {
    template: 'password-reset',
    enabled: true,
    alwaysOn: true,
    alwaysOnReason: 'The only way back into an account with a forgotten password.',
    updatedAt: null,
  },
]

const logEntry = (overrides = {}) => ({
  id: 'msg-1',
  to: 'buyer@example.test',
  template: 'order-placed',
  subject: 'Order #1001 received',
  status: 'sent',
  attempts: 1,
  lastError: null,
  provider: 'smtp',
  providerResponse: '250 OK id=1r4Xy2-0008Kt-9s',
  providerMessageId: '<abc@stdbeauty.com>',
  sentAt: '2026-09-02T10:00:00.000Z',
  createdAt: '2026-09-02T10:00:00.000Z',
  ...overrides,
})

function routes(mock: ApiMock, log = [logEntry()], summary: Record<string, number> = { sent: 1 }) {
  return mock
    .withSession(ownerUser)
    .on('GET', '/storefront/settings', { currency: 'GBP', storeName: 'Copperleaf', logoUrl: null })
    .on('GET', '/admin/notifications/unread-count', { count: 0 })
    .on('GET', '/admin/settings/emails/log', () =>
      jsonEnvelope(log, {
        pagination: { page: 1, limit: 20, total: log.length, totalPages: 1, hasNext: false, hasPrev: false },
        summary,
      }),
    )
    .on('GET', '/admin/settings/emails', templates)
    .on('GET', '/admin/settings', storeSettings({ adminNotificationEmails: ['ops@shop.test'] }))
}

/** `onList` carries pagination only; this one needs `summary` in `meta` too. */
function jsonEnvelope(data: unknown, meta: unknown) {
  return new Response(JSON.stringify({ success: true, data, meta }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  api = apiMock().install()
  tokenStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  tokenStore.clear()
})

describe('who gets the alerts', () => {
  it('keeps a long address whole instead of cutting it to fit', async () => {
    // 46 characters. The old field capped at 40 and truncated silently, which
    // made an address that is nobody's and a save the server then refused.
    const long = 'accounts.payable@a-fairly-long-domain-name.com'
    const user = userEvent.setup()
    routes(api)

    renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    const field = await screen.findByLabelText(/Addresses/)
    await user.type(field, long)
    await user.tab()

    expect(await screen.findByText(long)).toBeInTheDocument()
  })

  it('refuses one that is genuinely too long, rather than trimming it', async () => {
    const user = userEvent.setup()
    routes(api)

    renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    const field = await screen.findByLabelText(/Addresses/)
    await user.type(field, `${'x'.repeat(320)}@shop.test`)
    await user.tab()

    expect(await screen.findByText(/longer than 320 characters/i)).toBeInTheDocument()
  })

  it('commits an address left in the box when focus moves away', async () => {
    // Somebody types the third address and clicks Save without pressing Enter.
    const user = userEvent.setup()
    routes(api)

    renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    const field = await screen.findByLabelText(/Addresses/)
    await user.type(field, 'warehouse@shop.test')
    await user.tab()

    expect(await screen.findByText('warehouse@shop.test')).toBeInTheDocument()
  })
})

describe('the delivery test', () => {
  it('asks where to send it rather than assuming', async () => {
    // Mailing the shop's own address proves only that the server can deliver
    // to itself — the exact case that looks healthy while every customer email
    // is refused.
    routes(api)

    renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    expect(await screen.findByLabelText(/Send it to/)).toBeInTheDocument()
    expect(screen.getByText(/outside your own domain/i)).toBeInTheDocument()
  })

  it('sends to the address typed', async () => {
    const user = userEvent.setup()
    routes(api).on('POST', '/admin/settings/emails/test', { id: 'msg-9', status: 'queued' })

    renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    await user.type(await screen.findByLabelText(/Send it to/), 'me@gmail.test')
    await user.click(screen.getByRole('button', { name: /Send it/ }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/admin/settings/emails/test')[0]?.body).toEqual({
        to: 'me@gmail.test',
      })
    })
  })

  it('says queued, not delivered', async () => {
    // The screen cannot know whether it arrived. Claiming it did would be the
    // single most misleading thing it could say.
    const user = userEvent.setup()
    routes(api).on('POST', '/admin/settings/emails/test', { id: 'msg-9', status: 'queued' })

    renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    await user.type(await screen.findByLabelText(/Send it to/), 'me@gmail.test')
    await user.click(screen.getByRole('button', { name: /Send it/ }))

    expect(await screen.findByText(/Queued\./)).toBeInTheDocument()
    expect(screen.queryByText(/sent successfully|delivered/i)).not.toBeInTheDocument()
  })

  it('repeats the server’s refusal', async () => {
    const user = userEvent.setup()
    routes(api).onError(
      'POST',
      '/admin/settings/emails/test',
      422,
      'VALIDATION_FAILED',
      'The request failed validation',
    )

    renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    await user.type(await screen.findByLabelText(/Send it to/), 'me@gmail.test')
    await user.click(screen.getByRole('button', { name: /Send it/ }))

    expect(await screen.findByText('The request failed validation')).toBeInTheDocument()
  })
})

describe('the delivery log', () => {
  it('shows what the mail server said about a failure', async () => {
    routes(
      api,
      [
        logEntry({
          id: 'msg-2',
          to: 'buyer@example.test',
          status: 'failed',
          attempts: 5,
          lastError: '550 5.7.1 Relaying denied',
        }),
      ],
      { failed: 1 },
    )

    renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    // The provider's own sentence: it says what to fix.
    expect(await screen.findByText('550 5.7.1 Relaying denied')).toBeInTheDocument()
    // Scoped to the table — the status filter has a "Failed" option too.
    expect(within(screen.getByRole('table')).getByText('Failed')).toBeInTheDocument()
  })

  it('warns when messages are undelivered, and only then', async () => {
    routes(api, [logEntry({ status: 'queued', lastError: 'Connection timed out' })], { queued: 3 })

    renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    expect(await screen.findByText(/3 messages have not been delivered/)).toBeInTheDocument()
  })

  it('says nothing alarming when everything went out', async () => {
    // A warning a healthy shop always sees is a warning it learns to ignore.
    routes(api, [logEntry()], { sent: 12 })

    renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    await screen.findByText('buyer@example.test')
    expect(screen.queryByText(/have not been delivered/)).not.toBeInTheDocument()
  })

  it('narrows to the failures on request', async () => {
    const user = userEvent.setup()
    routes(api, [logEntry({ status: 'failed', lastError: 'Authentication failed' })], { failed: 2 })

    renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    await user.click(await screen.findByRole('button', { name: /Show the failures/ }))

    await waitFor(() => {
      const calls = api.callsTo('GET', '/admin/settings/emails/log')
      expect(calls.at(-1)?.url).toContain('status=failed')
    })
  })

  it('offers a retry on a failed message, and sends it again', async () => {
    // A message killed by a worker running a stale build is perfectly sendable
    // once the worker is fixed — but the sweep will not touch a failed row, so
    // without this the only recourse is asking the customer to order again.
    const user = userEvent.setup()
    routes(
      api,
      [logEntry({ status: 'failed', lastError: 'unknown template "admin-order-placed"' })],
      { failed: 1 },
    ).on('POST', '/admin/settings/emails/log/msg-1/retry', logEntry({ status: 'queued' }))

    renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    await user.click(await screen.findByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/admin/settings/emails/log/msg-1/retry')).toHaveLength(1)
    })
  })

  it('does not offer a retry on a message that already went out', async () => {
    // The server refuses it, and a button that only ever errors is worse than
    // no button.
    routes(api, [logEntry({ status: 'sent' })], { sent: 1 })

    renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    await screen.findByText('buyer@example.test')
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('tells a switched-off template apart from a failed one', async () => {
    // Two completely different problems: one is a switch on this very page.
    routes(api, [logEntry({ status: 'disabled', lastError: null })], { disabled: 1 })

    renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    const table = await screen.findByRole('table')
    expect(within(table).getByText('Off')).toBeInTheDocument()
  })
})

/**
 * The receipt behind "Sent".
 *
 * These two are the difference between a log that answers "the customer says
 * it never arrived" and one that just repeats the claim being disputed.
 */
describe('what "Sent" is evidence of', () => {
  it('shows the mail server’s own reply on a sent message', async () => {
    routes(api, [logEntry()], { sent: 1 })
    await renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    const table = await screen.findByRole('table')
    // The queue id, which is what a receiving postmaster can actually look up.
    expect(within(table).getByText('250 OK id=1r4Xy2-0008Kt-9s')).toBeInTheDocument()
  })

  it('says plainly when the configured provider sent nothing at all', async () => {
    routes(
      api,
      [
        logEntry({
          provider: 'console',
          providerResponse:
            'Not sent. EMAIL_PROVIDER=console wrote this message to tmp/mail/x.eml instead of delivering it.',
        }),
      ],
      { sent: 1 },
    )
    await renderAuthed(<EmailsPage />, { route: '/settings/emails' })

    const table = await screen.findByRole('table')
    // Still recorded 'sent' — nothing failed — but the row must not let an
    // operator believe a customer received it.
    expect(within(table).getByText(/Not sent\. EMAIL_PROVIDER=console/)).toBeInTheDocument()
  })
})
