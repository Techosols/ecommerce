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
  /**
   * What the provider said when it took the message.
   *
   * Kept because `sent` is a claim about a handover, not about a delivery, and
   * the difference only ever matters at the worst moment — somebody insisting
   * an email never arrived. An SMTP `250 OK id=…` turns that conversation from
   * "our software says it sent it" into a queue id the receiving postmaster can
   * actually look up.
   *
   * Optional: a provider that says nothing useful should return nothing rather
   * than manufacture a reassuring string.
   */
  providerResponse?: string
}

export interface EmailProvider {
  readonly name: string
  send(message: OutboundMessage): Promise<SendResult>
  /** Optional readiness probe used by /readyz when the provider supports one. */
  verify?(): Promise<void>
}
