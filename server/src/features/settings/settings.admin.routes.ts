/**
 * Store settings administration (§23.14).
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { accepted, ok, paginated } from '../../shared/http/respond.js'
import { buildPaginationMeta, toOffset } from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { ipLimiter } from '../../shared/middleware/rateLimit.js'
import { env } from '../../config/index.js'
import { emailService } from '../../infrastructure/email/index.js'
import { emailSettingsService } from '../../infrastructure/email/emailSettings.service.js'
import { emailLogService, type EmailLogStatus } from '../../infrastructure/email/emailLog.service.js'
import { idParam } from '../orders/orders.validators.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { ValidationError } from '../../shared/errors/index.js'
import { mediaService } from '../media/index.js'
import { settingsService } from './settings.service.js'
import {
  emailLogQuery,
  sendTestEmailSchema,
  updateSettingsSchema,
} from './settings.validators.js'
import type { StoreSettings } from './settings.types.js'

function toDto(settings: StoreSettings) {
  return {
    storeName: settings.storeName,
    contactEmail: settings.contactEmail,
    supportUrl: settings.supportUrl,
    supportPhone: settings.supportPhone,
    currency: settings.currency,
    timezone: settings.timezone,
    weightUnit: settings.weightUnit,
    taxRateBps: settings.taxRateBps,
    pricesIncludeTax: settings.pricesIncludeTax,
    defaultLowStockThreshold: settings.defaultLowStockThreshold,
    orderNumberPrefix: settings.orderNumberPrefix,
    reservationTtlMinutes: settings.reservationTtlMinutes,
    guestCheckoutEnabled: settings.guestCheckoutEnabled,

    // The cash-on-delivery policy. Writable through this same route, so leaving
    // it out of the response made it settable but never readable — a settings
    // form could save a new ceiling and had no way to show the current one.
    codEnabled: settings.codEnabled,
    codMinSubtotalCents: settings.codMinSubtotalCents,
    codMaxSubtotalCents: settings.codMaxSubtotalCents,
    codFeeCents: settings.codFeeCents,
    codCountryCodes: settings.codCountryCodes,
    bankTransferEnabled: settings.bankTransferEnabled,
    bankAccountName: settings.bankAccountName,
    bankName: settings.bankName,
    bankAccountNumber: settings.bankAccountNumber,
    bankIban: settings.bankIban,
    bankSwift: settings.bankSwift,
    bankInstructions: settings.bankInstructions,
    adminNotificationEmails: settings.adminNotificationEmails,
    codRequiresAccount: settings.codRequiresAccount,
    codMaxOpenOrders: settings.codMaxOpenOrders,
    orderReservationHours: settings.orderReservationHours,

    logoMediaId: settings.logoMediaId,
    metadata: settings.metadata,
    updatedAt: settings.updatedAt.toISOString(),
    updatedBy: settings.updatedBy,
  }
}

const templateParam = z.strictObject({ template: z.string().max(64) })
const toggleEmailSchema = z.strictObject({ enabled: z.boolean() })

export const settingsAdminRoutes: ExpressRouter = Router()

settingsAdminRoutes.get(
  '/settings',
  requirePermission('settings:read'),
  async (_req: Request, res: Response) => {
    return ok(res, toDto(await settingsService.get()))
  },
)

/**
 * Which emails the shop sends.
 *
 * Driven by the registry rather than the table, so a template nobody has ever
 * touched still appears with its default. The always-on ones are returned too,
 * carrying the reason they cannot be switched off — hiding them would send
 * somebody looking for a switch that was quietly removed.
 */
settingsAdminRoutes.get(
  '/settings/emails',
  requirePermission('settings:read'),
  async (_req: Request, res: Response) => {
    const templates = await emailSettingsService.list()
    return ok(
      res,
      templates.map((entry) => ({
        template: entry.template,
        enabled: entry.enabled,
        alwaysOn: entry.alwaysOnReason !== null,
        alwaysOnReason: entry.alwaysOnReason,
        updatedAt: entry.updatedAt?.toISOString() ?? null,
      })),
    )
  },
)

/**
 * What the shop has actually sent, and what became of it.
 *
 * Everything needed to answer "why did nobody get that email" has always been
 * recorded and never shown, so the question could only be settled from a psql
 * prompt. Each status is a different problem with a different fix, and from an
 * empty inbox they are indistinguishable:
 *
 *   `sent` means the provider took it, so a missing email is a delivery
 *   problem — SPF, DKIM, DMARC, or a spam folder. `queued` or `failed` with a
 *   `lastError` means the provider refused it, and the error is the provider's
 *   own words. `disabled` means somebody switched that template off on this
 *   very page.
 *
 * `settings:read`, because this is the delivery half of the settings above it
 * and the same people need both. It deliberately carries no message bodies and
 * no props — an operations screen about delivery should not become a second
 * place to read customers' addresses.
 */
settingsAdminRoutes.get(
  '/settings/emails/log',
  requirePermission('settings:read'),
  validate({ query: emailLogQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof emailLogQuery>>(req)
    const { limit, offset } = toOffset(filter)

    const { rows, total } = await emailLogService.list({
      ...(filter.status ? { status: filter.status as EmailLogStatus } : {}),
      ...(filter.to ? { to: filter.to } : {}),
      limit,
      offset,
    })

    return paginated(res, rows, buildPaginationMeta(filter, total), {
      // The counts the list cannot show: a page of successes looks the same
      // whether nine messages are stuck behind it or none are.
      summary: await emailLogService.summary(24),
    })
  },
)

/**
 * "Does email work at all?"
 *
 * The `system-check` template has always existed for this — it is the one
 * template that carries no business meaning, and its own registry entry says
 * "sent only by you, to test delivery" — and nothing has ever been able to
 * trigger it. So the only way to test a mail configuration was to place a real
 * order and see whether anything arrived.
 *
 * ── Why it asks where to send it ─────────────────────────────────────────────
 *
 * Sending to the store's own contact address proves only that the shop can mail
 * itself. On a typical shared mail server, local delivery always succeeds while
 * relaying to an outside address is refused — which is precisely the failure
 * where staff alerts arrive and every customer email silently does not. Testing
 * against an outside address (a personal Gmail, say) is the test that
 * distinguishes them, so the address is a required field.
 *
 * It goes through `enqueue` like everything else, so it lands in the delivery
 * log beside the real mail and its failure is recorded in the same words.
 * `system-check` is always-on, so this cannot be defeated by a switch.
 */
settingsAdminRoutes.post(
  '/settings/emails/test',
  requirePermission('settings:write'),
  // Generous enough to iterate on a broken SMTP configuration, tight enough
  // that this cannot be turned into a way to mail strangers from the shop.
  ipLimiter({ windowMs: 60 * 60_000, limit: 20 }),
  validate({ body: sendTestEmailSchema }),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof sendTestEmailSchema>

    const result = await emailService.enqueue({
      to: body.to,
      template: 'system-check',
      props: {
        environment: env.APP_ENV,
        triggeredAt: new Date().toISOString(),
        ...(body.note ? { note: body.note } : {}),
      },
      // Deliberately none: an operator testing a fix needs to send to the same
      // address again a minute later, and a dedupe key would swallow the
      // second attempt as a duplicate.
    })

    // 202, not 200: the message is queued. Whether it was *delivered* is a
    // question only the log can answer, which is where this points.
    return accepted(res, { id: result.id, status: result.status })
  },
)

/**
 * Sends one message again.
 *
 * `failed` is supposed to mean "retrying cannot help", and often it does. But
 * some of the ways a message lands there are about the shop at that moment
 * rather than the message: an SMTP password that was wrong for an hour, a
 * worker still running a build that did not have the template yet. Once the
 * cause is fixed those messages are perfectly sendable — and without this the
 * only way to deliver one is to ask the customer to order again.
 *
 * `settings:write`, because it puts mail on the wire. Already-sent messages are
 * refused rather than resent: a second copy of an order confirmation is a worse
 * outcome than none.
 */
settingsAdminRoutes.post(
  '/settings/emails/log/:id/retry',
  requirePermission('settings:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const entry = await emailLogService.retry(req.params.id as string)
    return accepted(res, entry)
  },
)

settingsAdminRoutes.patch(
  '/settings/emails/:template',
  requirePermission('settings:write'),
  validate({ params: templateParam, body: toggleEmailSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof toggleEmailSchema>
    // Refuses an always-on template with a 422 that says why, rather than
    // silently ignoring a switch the operator watched move.
    await emailSettingsService.setEnabled(req.params.template as string, body.enabled, actor.userId)
    return ok(res, { template: req.params.template, enabled: body.enabled })
  },
)

settingsAdminRoutes.patch(
  '/settings',
  requirePermission('settings:write'),
  validate({ body: updateSettingsSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const patch = req.body as z.infer<typeof updateSettingsSchema>

    // A logo must be a real, fully-processed asset. Pointing settings at a
    // pending upload would publish bytes nothing has inspected.
    if (patch.logoMediaId) {
      const asset = await mediaService.getById(patch.logoMediaId)
      if (!asset) throw new ValidationError('That media asset does not exist')
      mediaService.assertReady(asset)
    }

    const updated = await settingsService.update(patch, actor, { ip: req.ip ?? null })
    return ok(res, toDto(updated))
  },
)
