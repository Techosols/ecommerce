import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiMock } from '@/test/apiMock'
import { renderPage } from '@/test/render'
import { bankTransfer, order, paymentProof } from '@/test/fixtures'
import { BankTransferPage } from './pages/BankTransferPage'
import { OrderView } from '@/features/account/pages/OrderPage'

/**
 * Paying by bank transfer.
 *
 * What these tests defend:
 *
 *   • **The order does not become a dead end.** Choosing this method leaves the
 *     order unpaid and the sweep eventually cancels it, so the way to pay has
 *     to be reachable from the confirmation and from a cold visit later.
 *   • **The account details are the shop's, shown as given.** A page that
 *     invented, reformatted or truncated an IBAN would send money to the wrong
 *     place.
 *   • **Nothing here claims the order is paid.** A receipt is a claim until a
 *     person compares it with a bank statement, and the wording has to say so.
 *   • **A rejection reaches the customer with its reason**, which is the only
 *     part of a review they can act on.
 */

let mock

beforeEach(() => {
  mock = apiMock().install()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const claim = { orderNumber: '#1001', email: 'shopper@example.test' }

/** Arriving from an order page, with both halves already in the link. */
function openPrefilled(data = bankTransfer()) {
  mock.on('POST', '/storefront/payments/bank-transfer', data)
  return renderPage(<BankTransferPage />, {
    route: `/pay/bank-transfer?order=${encodeURIComponent(claim.orderNumber)}&email=${encodeURIComponent(claim.email)}`,
    auth: true,
  })
}

describe('getting to the payment page', () => {
  it('asks for the order number and email when it has neither', async () => {
    renderPage(<BankTransferPage />, { route: '/pay/bank-transfer', auth: true })

    expect(await screen.findByLabelText(/Order number/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Email/)).toBeInTheDocument()
  })

  it('looks the order up straight away when the link carries both', async () => {
    // The link from a confirmation page or email. Making somebody retype a
    // credential they are already holding is the fastest way to lose them.
    openPrefilled()

    await waitFor(() => {
      expect(mock.callsTo('POST', '/storefront/payments/bank-transfer')[0].body).toEqual(claim)
    })
    expect(await screen.findByText('Order #1001')).toBeInTheDocument()
  })

  it('repeats the server’s refusal rather than inventing one', async () => {
    mock.onError(
      'POST',
      '/storefront/payments/bank-transfer',
      404,
      'NOT_FOUND',
      'No order matches that number and email address',
    )
    const user = userEvent.setup()
    renderPage(<BankTransferPage />, { route: '/pay/bank-transfer', auth: true })

    await user.type(await screen.findByLabelText(/Order number/), '#9999')
    await user.type(screen.getByLabelText(/^Email/), 'nobody@example.test')
    await user.click(screen.getByRole('button', { name: /Continue/ }))

    expect(
      await screen.findByText('No order matches that number and email address'),
    ).toBeInTheDocument()
  })
})

describe('where to send the money', () => {
  it('shows the account exactly as the shop gave it', async () => {
    openPrefilled()

    expect(await screen.findByText('Copperleaf Ltd')).toBeInTheDocument()
    expect(screen.getByText('Example Bank')).toBeInTheDocument()
    expect(screen.getByText('GB33BUKB20201555555555')).toBeInTheDocument()
    // The amount owed, and the reference that lets staff find it on a
    // statement — both given the same weight as the account itself.
    expect(screen.getByText('£32.34')).toBeInTheDocument()
  })

  it('leaves out a field the shop has not filled in', async () => {
    // The server sends `swift: null` when there isn't one. A row labelled
    // "SWIFT / BIC" with nothing beside it reads as a page that failed to load.
    openPrefilled()
    await screen.findByText('Copperleaf Ltd')
    expect(screen.queryByText(/SWIFT/)).not.toBeInTheDocument()
  })

  it('renders the shop’s instructions as the HTML they were written in', async () => {
    // Written in the admin's rich text editor and sanitised server side, which
    // is what makes rendering them here safe.
    openPrefilled()
    const strong = await screen.findByText('order number')
    expect(strong.tagName).toBe('STRONG')
  })

  it('offers every value for copying, named for what it is', async () => {
    // Reading an IBAN off one screen and typing it into a banking app on
    // another is how money reaches the wrong account.
    openPrefilled()
    expect(await screen.findByRole('button', { name: /Copy iban/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copy amount/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copy reference/i })).toBeInTheDocument()
  })
})

describe('the receipt', () => {
  it('asks only for what a person needs to match a bank statement', async () => {
    openPrefilled()

    expect(await screen.findByLabelText(/Name on the account/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Which bank/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Last four digits/)).toBeInTheDocument()
    // A full account number typed into a public form is a liability the shop
    // would then be holding on somebody's behalf.
    expect(screen.queryByLabelText(/^Account number/)).not.toBeInTheDocument()
  })

  it('does not promise the order is paid', async () => {
    openPrefilled()
    expect(await screen.findByText(/Someone will check it/)).toBeInTheDocument()
  })

  it('will not send without a screenshot', async () => {
    const user = userEvent.setup()
    openPrefilled()

    await user.click(await screen.findByRole('button', { name: /Send the receipt/ }))

    expect(await screen.findByText(/Choose a screenshot/)).toBeInTheDocument()
    expect(mock.callsTo('POST', '/payments/bank-transfer/proofs')).toHaveLength(0)
  })
})

describe('what became of a receipt already sent', () => {
  it('says one is waiting, and does not ask for another', async () => {
    openPrefilled(bankTransfer({ proofs: [paymentProof()] }))

    expect(await screen.findByText('Waiting to be checked')).toBeInTheDocument()
    // Sending a second while the first is unreviewed is refused by the server;
    // offering the form would be a promise it will break.
    expect(screen.queryByLabelText(/Name on the account/)).not.toBeInTheDocument()
  })

  it('shows why one was turned down, and lets them try again', async () => {
    // The reason is the only part of a review the customer can act on. The
    // database refuses a rejection without one, and hiding it here would turn a
    // fixable mistake into an email to support.
    openPrefilled(
      bankTransfer({
        proofs: [
          paymentProof({
            status: 'rejected',
            reviewNote: 'The amount does not match — we received £20.00.',
          }),
        ],
      }),
    )

    expect(await screen.findByText('Not matched')).toBeInTheDocument()
    expect(
      screen.getByText('The amount does not match — we received £20.00.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/Name on the account/)).toBeInTheDocument()
  })

  it('never names the member of staff who decided', async () => {
    // Which colleague looked at a receipt is the shop's business; naming them
    // invites the argument to become personal. The DTO does not carry it, and
    // this asserts the page does not go looking for it.
    openPrefilled(bankTransfer({ proofs: [paymentProof({ status: 'approved' })] }))

    expect(await screen.findByText('Payment confirmed')).toBeInTheDocument()
    expect(screen.queryByText(/reviewed by/i)).not.toBeInTheDocument()
  })

  it('stops asking for money once the order is paid', async () => {
    openPrefilled(
      bankTransfer({
        order: { ...bankTransfer().order, paymentStatus: 'paid' },
        proofs: [paymentProof({ status: 'approved' })],
      }),
    )

    expect(await screen.findByText(/nothing left to send/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Name on the account/)).not.toBeInTheDocument()
  })
})

describe('the way in from an order', () => {
  it('puts the next step on an unpaid bank-transfer order', async () => {
    // The confirmation is the one moment a guest is guaranteed to be looking.
    renderPage(
      <OrderView order={order({ paymentMethod: 'bank_transfer', paymentState: 'awaiting_payment' })} />,
      { auth: true },
    )

    const link = await screen.findByRole('link', { name: /Pay now/ })
    // Carries the credential, so the payment page does not ask for one the
    // shopper is already holding.
    expect(link).toHaveAttribute(
      'href',
      '/pay/bank-transfer?order=%231001&email=shopper%40example.test',
    )
  })

  it('says nothing about paying on a cash-on-delivery order', async () => {
    renderPage(<OrderView order={order({ paymentMethod: 'cod' })} />, { auth: true })

    expect(await screen.findByText(/nothing to pay now/i)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Pay now/ })).not.toBeInTheDocument()
  })

  it('says nothing at all once it is paid', async () => {
    renderPage(<OrderView order={order({ paymentMethod: 'bank_transfer', paymentState: 'paid' })} />, {
      auth: true,
    })

    await screen.findByText('Order #1001')
    expect(screen.queryByRole('link', { name: /Pay now/ })).not.toBeInTheDocument()
  })
})
