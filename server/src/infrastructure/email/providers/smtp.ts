/**
 * SMTP provider (§10.2). Works with any SMTP service and with Mailhog locally.
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
      pool: true,
      maxConnections: 3,
      connectionTimeout: 10_000,
    })
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: message.from,
        to: message.to,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.headers ? { headers: message.headers } : {}),
      })
      return { providerMessageId: info.messageId }
    } catch (error) {
      log.warn({ err: error, to: message.to }, 'smtp send failed')
      throw new ExternalServiceError(
        ERROR_CODES.EMAIL_PROVIDER_ERROR,
        'The email provider rejected the message',
        { cause: error },
      )
    }
  }

  async verify(): Promise<void> {
    await this.transporter.verify()
  }

  close(): void {
    this.transporter.close()
  }
}
