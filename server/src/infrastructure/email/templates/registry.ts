/**
 * Template registry (§10.3).
 *
 * A template is a directory plus an entry here. The entry pins the props schema
 * and the subject line, so `emailService.enqueue` can validate both — a renamed
 * field becomes a type error at the call site instead of a blank
 * `{{customer.name}}` in someone's inbox.
 */
import type { z } from 'zod'
import { systemCheckProps, type SystemCheckProps } from './system-check/props.js'
import { emailVerificationProps, type EmailVerificationProps } from './email-verification/props.js'
import { passwordResetProps, type PasswordResetProps } from './password-reset/props.js'
import { accountExistsProps, type AccountExistsProps } from './account-exists/props.js'
import { passwordChangedProps, type PasswordChangedProps } from './password-changed/props.js'
import { welcomeProps, type WelcomeProps } from './welcome/props.js'
import { staffInvitationProps, type StaffInvitationProps } from './staff-invitation/props.js'
import { orderPlacedProps, type OrderPlacedProps } from './order-placed/props.js'
import { orderConfirmedProps, type OrderConfirmedProps } from './order-confirmed/props.js'
import { orderShippedProps, type OrderShippedProps } from './order-shipped/props.js'
import { orderDeliveredProps, type OrderDeliveredProps } from './order-delivered/props.js'
import { orderCancelledProps, type OrderCancelledProps } from './order-cancelled/props.js'
import { orderRefundedProps, type OrderRefundedProps } from './order-refunded/props.js'
import { cartAbandonedProps, type CartAbandonedProps } from './cart-abandoned/props.js'
import { adminOrderPlacedProps, type AdminOrderPlacedProps } from './admin-order-placed/props.js'
import { adminPaymentProofProps, type AdminPaymentProofProps } from './admin-payment-proof/props.js'

export interface TemplateDefinition<P> {
  /** Directory name under templates/. */
  dir: string
  schema: z.ZodType<P>
  subject: (props: P) => string
  /** Short preheader text shown by mail clients next to the subject. */
  preview?: (props: P) => string
}

/**
 * The emails that cannot be switched off, and why.
 *
 * Each of these is how somebody gets back into an account or is told their
 * account changed. Turning one off does not produce an error anywhere — it
 * produces a shop where password reset silently does nothing, discovered weeks
 * later from a customer who has given up. The settings screen shows them as
 * always on with this reason beside them rather than hiding them, so nobody
 * goes looking for a switch that was quietly removed.
 */
export const ALWAYS_ON: Partial<Record<TemplateName, string>> = {
  'email-verification': 'Without it a new account can never confirm its address.',
  'password-reset': 'The only way back into an account with a forgotten password.',
  'password-changed': 'Tells somebody their password changed — the first sign of a break-in.',
  'account-exists': 'Answers a reset request for an address that has no account.',
  'staff-invitation': 'A colleague cannot accept an invitation they never receive.',
  'system-check': 'Sent only by you, to test delivery.',
}

/** Whether this template may be switched off at all. */
export function isAlwaysOn(template: string): boolean {
  return template in ALWAYS_ON
}

export const EMAIL_TEMPLATES = {
  'system-check': {
    dir: 'system-check',
    schema: systemCheckProps,
    subject: (p: SystemCheckProps) => `Email delivery check — ${p.environment}`,
    preview: () => 'Automated verification that email delivery is configured correctly.',
  } satisfies TemplateDefinition<SystemCheckProps>,

  'email-verification': {
    dir: 'email-verification',
    schema: emailVerificationProps,
    subject: () => 'Confirm your email address',
    preview: () => 'One click to confirm your address and secure your account.',
  } satisfies TemplateDefinition<EmailVerificationProps>,

  'password-reset': {
    dir: 'password-reset',
    schema: passwordResetProps,
    subject: () => 'Reset your password',
    preview: (p: PasswordResetProps) =>
      `Choose a new password. This link expires in ${p.expiresInMinutes} minutes.`,
  } satisfies TemplateDefinition<PasswordResetProps>,

  /**
   * Sent when someone tries to register an address that already has an account.
   * It is the reason registration can answer identically for new and existing
   * addresses without silently swallowing the attempt (§6.4).
   */
  'account-exists': {
    dir: 'account-exists',
    schema: accountExistsProps,
    subject: () => 'You already have an account',
    preview: () => 'Someone tried to sign up with this address.',
  } satisfies TemplateDefinition<AccountExistsProps>,

  'password-changed': {
    dir: 'password-changed',
    schema: passwordChangedProps,
    subject: (p: PasswordChangedProps) => `Your password was ${p.action}`,
    preview: () => 'A security notice about your account.',
  } satisfies TemplateDefinition<PasswordChangedProps>,

  'staff-invitation': {
    dir: 'staff-invitation',
    schema: staffInvitationProps,
    subject: (p: StaffInvitationProps) => `You have been invited to ${p.storeName}`,
    preview: () => 'Set a password to activate your staff account.',
  } satisfies TemplateDefinition<StaffInvitationProps>,

  welcome: {
    dir: 'welcome',
    schema: welcomeProps,
    subject: () => 'Your account is ready',
    preview: () => 'Your email address is confirmed.',
  } satisfies TemplateDefinition<WelcomeProps>,

  // ── Order lifecycle ───────────────────────────────────────────────────────
  //
  // Every one of these is sent from an event subscriber with a deterministic
  // `dedupeKey`, so an at-least-once redelivery of the domain event produces
  // one email rather than two (§10.1).

  'order-placed': {
    dir: 'order-placed',
    schema: orderPlacedProps,
    subject: (p: OrderPlacedProps) => `Order ${p.orderNumber} received`,
    preview: (p: OrderPlacedProps) => `Thank you — we have your order, total ${p.total}.`,
  } satisfies TemplateDefinition<OrderPlacedProps>,

  'order-confirmed': {
    dir: 'order-confirmed',
    schema: orderConfirmedProps,
    subject: (p: OrderConfirmedProps) => `Order ${p.orderNumber} is confirmed`,
    preview: () => 'Payment received; your order is being prepared.',
  } satisfies TemplateDefinition<OrderConfirmedProps>,

  'order-shipped': {
    dir: 'order-shipped',
    schema: orderShippedProps,
    subject: (p: OrderShippedProps) => `Order ${p.orderNumber} is on its way`,
    preview: (p: OrderShippedProps) =>
      p.trackingNumber ? `Tracking ${p.trackingNumber}.` : 'Your parcel has left us.',
  } satisfies TemplateDefinition<OrderShippedProps>,

  'order-delivered': {
    dir: 'order-delivered',
    schema: orderDeliveredProps,
    subject: (p: OrderDeliveredProps) => `Order ${p.orderNumber} has been delivered`,
    preview: () => 'Your parcel has arrived.',
  } satisfies TemplateDefinition<OrderDeliveredProps>,

  'order-cancelled': {
    dir: 'order-cancelled',
    schema: orderCancelledProps,
    subject: (p: OrderCancelledProps) => `Order ${p.orderNumber} has been cancelled`,
    preview: () => 'This order will not be sent.',
  } satisfies TemplateDefinition<OrderCancelledProps>,

  'order-refunded': {
    dir: 'order-refunded',
    schema: orderRefundedProps,
    subject: (p: OrderRefundedProps) => `A refund of ${p.amount} for order ${p.orderNumber}`,
    preview: (p: OrderRefundedProps) => `${p.amount} is on its way back to you.`,
  } satisfies TemplateDefinition<OrderRefundedProps>,

  // ── Alerts to the shop's own staff ────────────────────────────────────────
  //
  // Templates like any other, so they queue, dedupe, record and switch off
  // through exactly the same machinery. The only thing that makes them
  // "internal" is who `to` is, which the subscriber decides.

  'admin-order-placed': {
    dir: 'admin-order-placed',
    schema: adminOrderPlacedProps,
    subject: (p: AdminOrderPlacedProps) => `New order ${p.orderNumber} — ${p.total}`,
    preview: (p: AdminOrderPlacedProps) =>
      p.actionNeeded ?? `${p.paymentMethod} — ${p.paymentStatus}.`,
  } satisfies TemplateDefinition<AdminOrderPlacedProps>,

  'admin-payment-proof': {
    dir: 'admin-payment-proof',
    schema: adminPaymentProofProps,
    subject: (p: AdminPaymentProofProps) => `Receipt to review — order ${p.orderNumber}`,
    preview: (p: AdminPaymentProofProps) =>
      `${p.claimedSenderName} says they sent ${p.total}.`,
  } satisfies TemplateDefinition<AdminPaymentProofProps>,

  /**
   * Marketing, not transactional: this one respects marketing consent and the
   * customer's notification preferences, and the subscriber checks both before
   * enqueuing it.
   */
  'cart-abandoned': {
    dir: 'cart-abandoned',
    schema: cartAbandonedProps,
    subject: (p: CartAbandonedProps) => `You left something at ${p.storeName}`,
    preview: () => 'Your basket is still here.',
  } satisfies TemplateDefinition<CartAbandonedProps>,
} as const

export type TemplateName = keyof typeof EMAIL_TEMPLATES
export type TemplateProps<T extends TemplateName> = z.infer<(typeof EMAIL_TEMPLATES)[T]['schema']>

export function isKnownTemplate(name: string): name is TemplateName {
  return name in EMAIL_TEMPLATES
}
