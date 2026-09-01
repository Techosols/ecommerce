/**
 * Development and test provider (§10.2).
 *
 * Writes each message to `tmp/mail/*.eml` — openable in any mail client — so
 * templates can be inspected without a provider account or a mail server.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../../logging/logger.js'
import type { EmailProvider, OutboundMessage, SendResult } from '../provider.js'

const log = createLogger('email.console')

const OUTPUT_DIR = path.resolve(process.cwd(), 'tmp/mail')

export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console'

  async send(message: OutboundMessage): Promise<SendResult> {
    const id = randomUUID()
    await mkdir(OUTPUT_DIR, { recursive: true })

    const eml = [
      `From: ${message.from}`,
      `To: ${message.to}`,
      ...(message.replyTo ? [`Reply-To: ${message.replyTo}`] : []),
      `Subject: ${message.subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${id}@localhost>`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      message.html,
    ].join('\r\n')

    const file = path.join(OUTPUT_DIR, `${Date.now()}-${id}.eml`)
    await writeFile(file, eml, 'utf8')

    log.info({ to: message.to, subject: message.subject, file }, 'email written to disk')
    return { providerMessageId: id }
  }

  async verify(): Promise<void> {
    await mkdir(OUTPUT_DIR, { recursive: true })
  }
}
