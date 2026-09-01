/**
 * Customer administration (§7.1, CLAUDE.md §12).
 *
 * Two permissions do all the work here: `customers:read` to see people and
 * `customers:write` to change anything about them — including consent, which is
 * the one field on this surface a shop is most likely to have to defend, and is
 * therefore written to the timeline and the audit log every time it moves.
 *
 * Segments are declared before `/customers/:id`, because `segments` is not a
 * uuid and would otherwise be matched as one.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { created, noContent, ok, paginated } from '../../shared/http/respond.js'
import { buildPaginationMeta, toOffset } from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { hashPassword } from '../../shared/auth/password.js'
import { authService } from '../auth/index.js'
import { settingsService } from '../settings/index.js'
import { customersService } from './customers.service.js'
import { segmentsService } from './segments.service.js'
import { CUSTOMER_RULE_FIELDS, describeRules, ruleFieldCatalogue } from './segments.rules.js'
import {
  CSV_HEADERS,
  addressDto,
  adminCustomerDto,
  customerCsvRow,
  customerEventDto,
  segmentDto,
} from './customers.mapper.js'
import {
  consentSchema,
  createCustomerSchema,
  createSegmentSchema,
  customerListQuery,
  customerNoteSchema,
  eventParam,
  idParam,
  mergeSchema,
  previewSegmentSchema,
  segmentIdParam,
  setCustomerStatusSchema,
  tagsSchema,
  updateCustomerSchema,
  updateSegmentSchema,
} from './customers.validators.js'
import type { CustomerListFilter } from './customers.types.js'

export const customersAdminRoutes: ExpressRouter = Router()

/**
 * Turns the validated query into the repository's filter, resolving a segment
 * into a SQL fragment when one is named.
 *
 * The fragment is compiled against a starting placeholder of zero and its
 * parameters are bound first, which is the contract `list` expects.
 */
async function toFilter(
  filter: z.infer<typeof customerListQuery>,
  limit: number,
  offset: number,
): Promise<CustomerListFilter & { segmentWhere?: string; segmentParams?: unknown[] }> {
  const segment = filter.segmentId ? await segmentsService.asFilter(filter.segmentId, 0) : null

  return {
    ...(filter.q ? { query: filter.q } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.hasOrders ? { hasOrders: filter.hasOrders === 'true' } : {}),
    ...(filter.acceptsMarketing ? { acceptsMarketing: filter.acceptsMarketing === 'true' } : {}),
    ...(filter.marketingEmailState ? { marketingEmailState: filter.marketingEmailState } : {}),
    ...(filter.taxExempt ? { taxExempt: filter.taxExempt === 'true' } : {}),
    ...(filter.tags ? { tags: filter.tags } : {}),
    ...(filter.minSpent === undefined ? {} : { minSpentCents: filter.minSpent }),
    ...(filter.maxSpent === undefined ? {} : { maxSpentCents: filter.maxSpent }),
    ...(filter.minOrders === undefined ? {} : { minOrders: filter.minOrders }),
    ...(filter.maxOrders === undefined ? {} : { maxOrders: filter.maxOrders }),
    ...(filter.createdAfter ? { createdAfter: filter.createdAfter } : {}),
    ...(filter.createdBefore ? { createdBefore: filter.createdBefore } : {}),
    ...(filter.lastOrderAfter ? { lastOrderAfter: filter.lastOrderAfter } : {}),
    ...(filter.noOrderSince ? { noOrderSince: filter.noOrderSince } : {}),
    ...(filter.sort ? { sort: filter.sort as CustomerListFilter['sort'] } : {}),
    ...(filter.direction ? { direction: filter.direction } : {}),
    ...(segment ? { segmentWhere: segment.where, segmentParams: segment.params } : {}),
    limit,
    offset,
  }
}

// ── Segments (declared first: `segments` is not a uuid) ─────────────────────

/** The field table the admin's rule builder is generated from. */
customersAdminRoutes.get(
  '/customers/segments/fields',
  requirePermission('customers:read'),
  async (_req: Request, res: Response) => {
    return ok(res, ruleFieldCatalogue())
  },
)

customersAdminRoutes.get(
  '/customers/segments',
  requirePermission('customers:read'),
  async (_req: Request, res: Response) => {
    const segments = await segmentsService.list()
    return ok(res, segments.map(segmentDto))
  },
)

/** What an unsaved rule set would match. The only question a preview answers. */
customersAdminRoutes.post(
  '/customers/segments/preview',
  requirePermission('customers:read'),
  validate({ body: previewSegmentSchema }),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof previewSegmentSchema>
    return ok(res, await segmentsService.preview(body.rules))
  },
)

customersAdminRoutes.post(
  '/customers/segments',
  requirePermission('customers:write'),
  validate({ body: createSegmentSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof createSegmentSchema>
    const segment = await segmentsService.create(
      {
        name: body.name,
        rules: body.rules,
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
      },
      actor,
    )
    return created(res, segmentDto({ ...segment, summary: describeRules(segment.rules) }))
  },
)

customersAdminRoutes.get(
  '/customers/segments/:segmentId',
  requirePermission('customers:read'),
  validate({ params: segmentIdParam }),
  async (req: Request, res: Response) => {
    const segment = await segmentsService.getById(req.params.segmentId as string)
    return ok(
      res,
      segmentDto({
        ...segment,
        memberCount: await segmentsService.countMembers(segment.rules),
        summary: describeRules(segment.rules),
      }),
    )
  },
)

customersAdminRoutes.patch(
  '/customers/segments/:segmentId',
  requirePermission('customers:write'),
  validate({ params: segmentIdParam, body: updateSegmentSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof updateSegmentSchema>
    const segment = await segmentsService.update(req.params.segmentId as string, body, actor)
    return ok(res, segmentDto({ ...segment, summary: describeRules(segment.rules) }))
  },
)

customersAdminRoutes.delete(
  '/customers/segments/:segmentId',
  requirePermission('customers:write'),
  validate({ params: segmentIdParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await segmentsService.remove(req.params.segmentId as string, actor)
    return noContent(res)
  },
)

// ── Export (also before `/:id`) ─────────────────────────────────────────────

/**
 * The current view as a CSV.
 *
 * Takes the same filters as the list, so what downloads is what is on screen —
 * an export that quietly returned everything would be a different answer to the
 * question the operator asked. Streamed as text rather than the JSON envelope,
 * because the browser is going to save it, not parse it.
 */
customersAdminRoutes.get(
  '/customers/export',
  requirePermission('customers:read'),
  validate({ query: customerListQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof customerListQuery>>(req)
    // A bounded export: 10,000 rows is a spreadsheet, and anything past it is a
    // database question rather than a download.
    const { rows } = await customersService.list(await toFilter(filter, 10_000, 0))

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="customers.csv"')
    return res.send([CSV_HEADERS.join(','), ...rows.map(customerCsvRow)].join('\n'))
  },
)

/** Rebuilds every customer's lifetime figures from the orders. */
customersAdminRoutes.post(
  '/customers/recompute-metrics',
  requirePermission('customers:write'),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    return ok(res, { customers: await customersService.recomputeAllMetrics(actor) })
  },
)

// ── The list ────────────────────────────────────────────────────────────────

customersAdminRoutes.get(
  '/customers',
  requirePermission('customers:read'),
  validate({ query: customerListQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof customerListQuery>>(req)
    const { limit, offset } = toOffset(filter)
    const { currency } = await settingsService.get()

    const { rows, total } = await customersService.list(await toFilter(filter, limit, offset))

    return paginated(
      res,
      rows.map((customer) => adminCustomerDto(customer, currency)),
      buildPaginationMeta(filter, total),
      // The rule fields travel with the list so the filter drawer and the rule
      // builder are generated from the server's own vocabulary.
      { ruleFields: CUSTOMER_RULE_FIELDS.map((field) => field.key) },
    )
  },
)

customersAdminRoutes.post(
  '/customers',
  requirePermission('customers:write'),
  validate({ body: createCustomerSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof createCustomerSchema>
    const { currency } = await settingsService.get()

    const customer = await customersService.create(
      {
        email: body.email,
        access: body.access,
        ...(body.firstName === undefined ? {} : { firstName: body.firstName }),
        ...(body.lastName === undefined ? {} : { lastName: body.lastName }),
        ...(body.phone === undefined ? {} : { phone: body.phone }),
        ...(body.adminNote === undefined ? {} : { adminNote: body.adminNote }),
        ...(body.tags === undefined ? {} : { tags: body.tags }),
        ...(body.taxExempt === undefined ? {} : { taxExempt: body.taxExempt }),
        ...(body.locale === undefined ? {} : { locale: body.locale }),
        ...(body.marketingEmailState === undefined
          ? {}
          : { marketingEmailState: body.marketingEmailState }),
        ...(body.password === undefined ? {} : { password: body.password }),
      },
      actor,
      {
        hashPassword,
        // The existing reset flow is exactly this shape — "here is a link, set
        // a password" — so an invite reuses it rather than inventing a parallel
        // token, template and accept endpoint that would have to be kept in
        // step with it forever.
        sendSetPasswordLink: (email) => authService.requestPasswordReset(email, {}),
      },
    )
    return created(res, adminCustomerDto(customer, currency))
  },
)

// ── One customer ────────────────────────────────────────────────────────────

customersAdminRoutes.get(
  '/customers/:id',
  requirePermission('customers:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const { currency } = await settingsService.get()
    const customer = await customersService.getById(req.params.id as string)
    const addresses = await customersService.listAddresses(customer.id)

    return ok(res, {
      ...adminCustomerDto(customer, currency),
      addresses: addresses.map(addressDto),
    })
  },
)

customersAdminRoutes.patch(
  '/customers/:id',
  requirePermission('customers:write'),
  validate({ params: idParam, body: updateCustomerSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof updateCustomerSchema>
    const { currency } = await settingsService.get()
    const customer = await customersService.updateAdmin(req.params.id as string, body, actor)
    return ok(res, adminCustomerDto(customer, currency))
  },
)

/**
 * Enabling or disabling an account.
 *
 * Disabling revokes every session, so access ends at once rather than whenever
 * the current access token happens to expire.
 */
customersAdminRoutes.patch(
  '/customers/:id/status',
  requirePermission('customers:write'),
  validate({ params: idParam, body: setCustomerStatusSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const { status } = req.body as z.infer<typeof setCustomerStatusSchema>
    const { currency } = await settingsService.get()

    const customer = await customersService.setStatus(
      req.params.id as string,
      status,
      actor,
      (userId, reason) => authService.revokeAllSessions(userId, reason as never),
    )
    return ok(res, adminCustomerDto(customer, currency))
  },
)

// ── Tags and consent ────────────────────────────────────────────────────────

customersAdminRoutes.post(
  '/customers/:id/tags',
  requirePermission('customers:write'),
  validate({ params: idParam, body: tagsSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof tagsSchema>
    const { currency } = await settingsService.get()
    const customer = await customersService.addTags(req.params.id as string, body.tags, actor)
    return ok(res, adminCustomerDto(customer, currency))
  },
)

customersAdminRoutes.delete(
  '/customers/:id/tags',
  requirePermission('customers:write'),
  validate({ params: idParam, body: tagsSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof tagsSchema>
    const { currency } = await settingsService.get()
    const customer = await customersService.removeTags(req.params.id as string, body.tags, actor)
    return ok(res, adminCustomerDto(customer, currency))
  },
)

customersAdminRoutes.patch(
  '/customers/:id/marketing',
  requirePermission('customers:write'),
  validate({ params: idParam, body: consentSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof consentSchema>
    const { currency } = await settingsService.get()
    const customer = await customersService.setConsent(
      req.params.id as string,
      {
        channel: body.channel,
        state: body.state,
        ...(body.optInLevel === undefined ? {} : { optInLevel: body.optInLevel }),
      },
      actor,
    )
    return ok(res, adminCustomerDto(customer, currency))
  },
)

// ── Timeline ────────────────────────────────────────────────────────────────

customersAdminRoutes.get(
  '/customers/:id/events',
  requirePermission('customers:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const events = await customersService.events(req.params.id as string)
    return ok(res, events.map(customerEventDto))
  },
)

customersAdminRoutes.post(
  '/customers/:id/events',
  requirePermission('customers:write'),
  validate({ params: idParam, body: customerNoteSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof customerNoteSchema>
    const event = await customersService.addNote(req.params.id as string, body.body, actor)
    return created(res, customerEventDto(event))
  },
)

/** Only notes. A system observation is evidence, not somebody's to take back. */
customersAdminRoutes.delete(
  '/customers/:id/events/:eventId',
  requirePermission('customers:write'),
  validate({ params: eventParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await customersService.deleteNote(
      req.params.id as string,
      req.params.eventId as string,
      actor,
    )
    return noContent(res)
  },
)

// ── Merge and rollups ───────────────────────────────────────────────────────

customersAdminRoutes.post(
  '/customers/:id/merge',
  requirePermission('customers:write'),
  validate({ params: idParam, body: mergeSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof mergeSchema>
    const { currency } = await settingsService.get()
    const customer = await customersService.merge(
      req.params.id as string,
      body.duplicateId,
      actor,
    )
    return ok(res, adminCustomerDto(customer, currency))
  },
)

customersAdminRoutes.post(
  '/customers/:id/recompute-metrics',
  requirePermission('customers:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const { currency } = await settingsService.get()
    const customer = await customersService.recomputeMetrics(req.params.id as string)
    return ok(res, adminCustomerDto(customer, currency))
  },
)
