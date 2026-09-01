/**
 * Request schemas for the auth surface (§17.2).
 *
 * Every schema is strict: an unexpected field is a 422, not a silent drop. That
 * is also what stops a caller smuggling `role`, `status` or `emailVerified`
 * into a registration payload (§16.3).
 */
import { z } from 'zod'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../shared/auth/password.js'
import { emailField } from '../../shared/validation/common.js'

/**
 * Only bounds are checked here. Strength is a business rule with its own error
 * code, enforced in the service so that "too common" and "contains your email"
 * come back as WEAK_PASSWORD rather than a generic validation failure.
 */
const passwordField = z.string().min(1).max(PASSWORD_MAX_LENGTH)

const nameField = z.string().trim().min(1).max(100)

/** Opaque credential tokens are 32 random bytes, base64url-encoded. */
const secretTokenField = z
  .string()
  .min(20)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, 'is not a valid token')

export const registerSchema = z
  .strictObject({
    email: emailField,
    password: passwordField,
    firstName: nameField.optional(),
    lastName: nameField.optional(),
  })
  .describe('register')

export const loginSchema = z.strictObject({
  email: emailField,
  password: passwordField,
})

export const refreshSchema = z.strictObject({
  refreshToken: secretTokenField.optional(),
})

export const logoutSchema = refreshSchema

export const verifyEmailSchema = z.strictObject({
  token: secretTokenField,
})

export const resendVerificationSchema = z.strictObject({
  email: emailField,
})

export const forgotPasswordSchema = z.strictObject({
  email: emailField,
})

export const resetPasswordSchema = z.strictObject({
  token: secretTokenField,
  password: passwordField,
})

export const acceptInvitationSchema = z.strictObject({
  token: secretTokenField,
  password: passwordField,
})

export const changePasswordSchema = z.strictObject({
  currentPassword: passwordField,
  newPassword: passwordField,
})

export const sessionIdParam = z.strictObject({
  id: z.uuid(),
})

export const PASSWORD_RULES = {
  minLength: PASSWORD_MIN_LENGTH,
  maxLength: PASSWORD_MAX_LENGTH,
} as const
