/**
 * SMTP provider (§10.2). Works with any SMTP service and with Mailhog locally.
 *
 * ── Why this does not pool by default ────────────────────────────────────────
 *
 * A pool keeps a TCP connection open between messages. That is a win for a
 * service sending thousands an hour, and a trap for a shop sending a handful:
 * shared and cPanel-style hosts routinely close an authenticated connection
 * after one message, or cap concurrent connections at one, and nodemailer then
 * hands the next send a socket the far end has already hung up.
 *
 * The failure that produces is very specific and very confusing — **the first
 * email of a burst arrives and the rest do not.** An order places one message
 * for the customer and one per staff address; with a pool against such a host,
 * exactly one of them lands.
 *
 * So the default is a fresh connection per message. It costs a TLS handshake
 * per email, which for this volume is nothing, and it removes a whole class of
 * "some of the emails arrive" problems. `SMTP_POOL=true` turns pooling back on
 * for a provider that genuinely wants it (SES, Postmark, a self-run Postfix).
 */
import nodemailer, { type Transporter } from 'nodemailer'
import { env } from '../../../config/index.js'
import { ERROR_CODES, ExternalServiceError } from '../../../shared/errors/index.js'
import { createLogger } from '../../logging/logger.js'
import type { EmailProvider, OutboundMessage, SendResult } from '../provider.js'

const log = createLogger('email.smtp')

export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp'
  private transporter: Transporter

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: env.SMTP_SECURE,
      ...(env.SMTP_USER && env.SMTP_PASSWORD
        ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
        : {}),
      ...(env.SMTP_POOL ? { pool: true, maxConnections: env.SMTP_MAX_CONNECTIONS ?? 3 } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    })
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    let info: Awaited<ReturnType<Transporter['sendMail']>>
    try {
      info = await this.transporter.sendMail({
        from: message.from,
        to: message.to,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.headers ? { headers: message.headers } : {}),
      })
    } catch (error) {
      log.warn({ err: error, to: message.to }, 'smtp send failed')
      throw new ExternalServiceError(
        ERROR_CODES.EMAIL_PROVIDER_ERROR,
        'The email provider rejected the message',
        { cause: error },
      )
    }

    /**
     * A resolved `sendMail` is not the same as an accepted recipient.
     *
     * Nodemailer throws only when *every* recipient fails. A server that
     * accepts the message at DATA and refuses the address — "relaying denied",
     * "no such user" — leaves it in `rejected` and resolves. Recording that as
     * `sent` is how an email nobody received ends up looking, in the shop's own
     * table, exactly like one that arrived.
     */
    if (info.rejected?.length) {
      const reason = info.response ?? 'the server refused the recipient'
      log.warn(
        { to: message.to, rejected: info.rejected, response: info.response },
        'smtp accepted the message but refused the recipient',
      )
      throw new ExternalServiceError(
        ERROR_CODES.EMAIL_PROVIDER_ERROR,
        `The mail server refused ${String(info.rejected[0])}: ${reason}`,
      )
    }

    // The server's own words, kept on the row rather than only in a debug log —
    // a "250 OK queued as ..." is what a postmaster asks for when a message was
    // accepted here and never arrived there, and a log line rotated away a
    // fortnight ago cannot answer that.
    log.debug({ to: message.to, response: info.response }, 'smtp accepted')

    return {
      providerMessageId: info.messageId,
      ...(info.response ? { providerResponse: info.response } : {}),
    }
  }

  async verify(): Promise<void> {
    await this.transporter.verify()
  }

  close(): void {
    this.transporter.close()
  }
}
