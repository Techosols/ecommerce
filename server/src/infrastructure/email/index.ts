/**
 * Provider selection happens once, here. Nothing else in the codebase knows
 * which provider is active (§10.2).
 */
import { env } from '../../config/index.js'
import { createLogger } from '../logging/logger.js'
import type { EmailProvider } from './provider.js'
import { ConsoleEmailProvider } from './providers/console.js'
import { SmtpEmailProvider } from './providers/smtp.js'

const log = createLogger('email')

let provider: EmailProvider | undefined

export function getEmailProvider(): EmailProvider {
  if (!provider) {
    provider = env.EMAIL_PROVIDER === 'smtp' ? new SmtpEmailProvider() : new ConsoleEmailProvider()
    log.debug({ provider: provider.name }, 'email provider selected')
  }
  return provider
}

/** Test seam: substitute a fake provider. */
export function setEmailProvider(next: EmailProvider | undefined): void {
  provider = next
}

export { emailService } from './email.service.js'
export type { EnqueueEmailInput, EnqueuedEmail } from './email.service.js'
export { renderTemplate, clearTemplateCache } from './renderer.js'
export type { Branding, RenderedEmail } from './renderer.js'
export { EMAIL_TEMPLATES, isKnownTemplate } from './templates/registry.js'
export type { TemplateName, TemplateProps } from './templates/registry.js'
export type { EmailProvider, OutboundMessage, SendResult } from './provider.js'
