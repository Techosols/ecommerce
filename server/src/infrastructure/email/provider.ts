/**
 * The email provider seam (§10.2, §46 of CLAUDE.md).
 *
 * Business logic never names a provider. Swapping SMTP for a hosted API is one
 * new file implementing this interface plus one config value.
 */
export interface OutboundMessage {
  to: string
  from: string
  replyTo?: string
  subject: string
  html: string
  text: string
  headers?: Record<string, string>
}

export interface SendResult {
  providerMessageId: string
}

export interface EmailProvider {
  readonly name: string
  send(message: OutboundMessage): Promise<SendResult>
  /** Optional readiness probe used by /readyz when the provider supports one. */
  verify?(): Promise<void>
}
