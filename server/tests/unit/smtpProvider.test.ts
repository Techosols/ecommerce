import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The SMTP provider.
 *
 * Two behaviours here are the difference between "the email did not arrive" and
 * "the email did not arrive **and the shop's own table says it did**".
 *
 *   **A resolved `sendMail` is not an accepted recipient.** Nodemailer throws
 *   only when every recipient fails. A server that takes the message at DATA
 *   and then refuses the address — "relaying denied", "no such user" — puts it
 *   in `rejected` and resolves. Recorded as `sent`, that is indistinguishable
 *   from a message that arrived.
 *
 *   **No connection pool by default.** Shared and cPanel-style hosts routinely
 *   close an authenticated connection after one message or allow only one at a
 *   time, and a pooled transport then fails every send after the first — so the
 *   first email of an order lands and the rest do not.
 */

const created: Array<Record<string, unknown>> = []
const sendMail = vi.fn()

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      created.push(options)
      return { sendMail, verify: vi.fn(), close: vi.fn() }
    },
  },
}))

const { SmtpEmailProvider } = await import('../../src/infrastructure/email/providers/smtp.js')

const message = {
  to: 'buyer@example.test',
  from: 'shop@example.test',
  subject: 'Order #1001 received',
  html: '<p>Thanks</p>',
  text: 'Thanks',
}

beforeEach(() => {
  created.length = 0
  sendMail.mockReset()
})

describe('accepting a message', () => {
  it('returns the provider’s message id', async () => {
    sendMail.mockResolvedValue({ messageId: '<abc@shop>', rejected: [], response: '250 OK' })

    const result = await new SmtpEmailProvider().send(message)

    expect(result.providerMessageId).toBe('<abc@shop>')
  })
})

describe('a recipient the server refused', () => {
  it('fails the send instead of reporting success', async () => {
    // The exact shape of "the customer never got it but the table says sent".
    sendMail.mockResolvedValue({
      messageId: '<abc@shop>',
      accepted: [],
      rejected: ['buyer@example.test'],
      response: '550 5.7.1 Relaying denied',
    })

    await expect(new SmtpEmailProvider().send(message)).rejects.toThrow(/Relaying denied/)
  })

  it('names the address and repeats the server’s words', async () => {
    // Both halves matter: which address, and why. "Could not send" is neither.
    sendMail.mockResolvedValue({
      messageId: '<abc@shop>',
      rejected: ['buyer@example.test'],
      response: '550 5.1.1 No such user',
    })

    await expect(new SmtpEmailProvider().send(message)).rejects.toThrow(
      /buyer@example\.test.*No such user/,
    )
  })
})

describe('a send the transport rejected outright', () => {
  it('is reported as a provider failure', async () => {
    sendMail.mockRejectedValue(new Error('535 authentication failed'))

    await expect(new SmtpEmailProvider().send(message)).rejects.toThrow(
      /email provider rejected/i,
    )
  })
})

describe('the transport', () => {
  it('does not pool unless it is asked to', async () => {
    // The default that stops "only the first email of the order arrives".
    new SmtpEmailProvider()

    expect(created[0]?.pool).toBeUndefined()
  })
})
