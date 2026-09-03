/**
 * Cash the courier collected at the door, and whether it adds up.
 *
 * ── The problem this replaces ────────────────────────────────────────────────
 *
 * In a cash-on-delivery shop the courier is the cashier. It takes the money at
 * the door, keeps its fee, and pays the rest over days or weeks later as a
 * batch with a list of parcels attached. Somebody then sits down with that list
 * and the order book and works out which orders have actually been paid for —
 * and, far more importantly, which ones the courier says it delivered but has
 * not paid for. That afternoon with a spreadsheet is what this is.
 *
 * ── The three findings, and why it is not a boolean ──────────────────────────
 *
 *   matched     the line names an order of ours and the amount agrees
 *   mismatched  it names one of ours and the amount does not
 *   unmatched   no parcel of ours has that tracking number
 *
 * The middle one is the entire reason for doing this. A shop that only asked
 * "did the courier pay us for this parcel, yes or no" would tick off a line
 * that paid two hundred against an order for two thousand.
 *
 * ── What an import does not do ───────────────────────────────────────────────
 *
 * **It does not mark anything paid.** Importing records what the courier
 * claims; settling is a separate, deliberate act per line, through the payments
 * service, by somebody with the permission to capture money. A parsed CSV that
 * silently confirmed orders and committed stock would make a courier's
 * spreadsheet an unauthenticated write to the payments table — and a courier's
 * spreadsheet is wrong often enough that this is not theoretical.
 *
 * ── Why the expected amount is frozen at import ──────────────────────────────
 *
 * `expected_cents` records what the order owed *when the statement was read*.
 * A refund issued next week must not quietly turn last week's mismatch into a
 * match: the reconciliation is a statement about a moment, and rewriting it
 * later would destroy the only evidence that anything was ever wrong.
 */
import { v7 as uuidv7 } from 'uuid'
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { registerConstraintError } from '../../infrastructure/database/errors.js'
import { getCarrier } from '../../infrastructure/carriers/index.js'
import type { CarrierRemittanceLine } from '../../infrastructure/carriers/index.js'
import type { Actor } from '../../shared/auth/actor.js'
import {
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/index.js'

const log = createLogger('shipping.cod')

/*
 * The constraint speaks for itself, at the data boundary where every other one
 * does. A statement imported twice is the mistake this catches — and doing it
 * here rather than with a `SELECT` first means two operators uploading the same
 * file at the same moment still get one statement.
 */
registerConstraintError(
  'cod_remittances_reference_once',
  ERROR_CODES.ALREADY_EXISTS,
  'That statement has already been imported',
)
registerConstraintError(
  'cod_remittance_lines_once',
  ERROR_CODES.ALREADY_EXISTS,
  'That parcel appears twice in the same statement',
)

export type CodMatchStatus = 'matched' | 'mismatched' | 'unmatched'

export interface CodRemittanceLine {
  id: string
  trackingNumber: string
  shipmentId: string | null
  orderId: string | null
  orderNumber: string | null
  collectedCents: number
  feeCents: number
  netCents: number
  currency: string
  collectedAt: Date | null
  reference: string | null
  matchStatus: CodMatchStatus
  expectedCents: number | null
  /** True once a payment has been recorded against the order for this line. */
  settled: boolean
}

export interface CodRemittance {
  id: string
  provider: string
  reference: string | null
  declaredNetCents: number
  currency: string
  statementDate: Date | null
  sourceFilename: string | null
  importedAt: Date
  totals: {
    lines: number
    matched: number
    mismatched: number
    unmatched: number
    collectedCents: number
    feeCents: number
    netCents: number
  }
}

/**
 * What the caller must tell us about an order, because shipping does not know.
 *
 * The same hook shape `createShipment` uses: this service owns the statement
 * and the matching; the orders side owns what an order is owed and how a
 * payment is recorded.
 */
export interface CodOrderLookup {
  /** The order's outstanding balance in minor units, or null if unknown to us. */
  outstandingFor(orderId: string): Promise<{ outstandingCents: number; currency: string; orderNumber: string } | null>
}

/** Anything the shop should refuse to store, caught before a row is written. */
function assertSane(lines: CarrierRemittanceLine[]): void {
  if (lines.length === 0) {
    throw new ValidationError('That statement has no lines the courier adapter could read')
  }

  const seen = new Set<string>()
  for (const line of lines) {
    if (seen.has(line.trackingNumber)) {
      throw new ValidationError(
        `Tracking number ${line.trackingNumber} appears twice in that statement`,
      )
    }
    seen.add(line.trackingNumber)

    // Negative cash is not a rounding error, it is a parser reading the wrong
    // column — and it would be stored as money owed to us for ever.
    if (line.collectedCents < 0 || line.netCents < 0) {
      throw new ValidationError(
        `Line ${line.trackingNumber} reports a negative amount, which cannot be right`,
      )
    }
  }
}

export const codService = {
  /** Whether a courier is connected that can produce statements at all. */
  canImport(): boolean {
    const carrier = getCarrier()
    return carrier.capabilities.remittance && Boolean(carrier.parseRemittance)
  },

  /**
   * Reads a statement, records it, and says what it found.
   *
   * The whole import is one transaction: a statement half-recorded is worse
   * than one not recorded at all, because the missing half looks like money the
   * courier never paid.
   */
  async import(
    input: {
      file: Buffer
      filename: string
      reference?: string | null
      statementDate?: Date | null
      declaredNetCents?: number | null
      currency?: string | null
    },
    lookup: CodOrderLookup,
    actor: Actor,
  ): Promise<CodRemittance> {
    const carrier = getCarrier()
    if (!carrier.capabilities.remittance || !carrier.parseRemittance) {
      throw new DomainRuleError(
        ERROR_CODES.SHIPPING_UNAVAILABLE,
        `${carrier.label} cannot produce cash-on-delivery statements`,
      )
    }

    let parsed: CarrierRemittanceLine[]
    try {
      parsed = await carrier.parseRemittance(input.file, input.filename)
    } catch (error) {
      log.warn({ err: error, filename: input.filename }, 'remittance parse failed')
      throw new ValidationError(
        'That file could not be read as a statement from this courier',
      )
    }

    assertSane(parsed)

    // The statement's currency is the first line's; a statement mixing
    // currencies is a statement we have misread.
    const currency = input.currency ?? parsed[0]!.currency
    if (parsed.some((line) => line.currency !== currency)) {
      throw new ValidationError('That statement mixes currencies, which cannot be reconciled')
    }

    const remittanceId = uuidv7()

    await withTransaction(async () => {
      await execute(
        `INSERT INTO cod_remittances
           (id, provider, reference, declared_net_cents, currency, statement_date,
            source_filename, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          remittanceId,
          carrier.name,
          input.reference ?? null,
          input.declaredNetCents ?? parsed.reduce((sum, line) => sum + line.netCents, 0),
          currency,
          input.statementDate ?? null,
          input.filename,
          actor.userId,
        ],
        { name: 'cod.insertRemittance' },
      )

      for (const line of parsed) {
        const resolved = await resolve(line, lookup)

        await execute(
          `INSERT INTO cod_remittance_lines
             (id, remittance_id, tracking_number, shipment_id, order_id, collected_cents,
              fee_cents, net_cents, currency, collected_at, reference, match_status,
              expected_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            uuidv7(),
            remittanceId,
            line.trackingNumber,
            resolved.shipmentId,
            resolved.orderId,
            line.collectedCents,
            line.feeCents,
            line.netCents,
            line.currency,
            line.collectedAt,
            line.reference,
            resolved.matchStatus,
            resolved.expectedCents,
          ],
          { name: 'cod.insertLine' },
        )
      }
    })

    const remittance = await this.get(remittanceId)
    log.info(
      {
        remittanceId,
        provider: carrier.name,
        lines: remittance.totals.lines,
        mismatched: remittance.totals.mismatched,
        unmatched: remittance.totals.unmatched,
      },
      'cod statement imported',
    )
    return remittance
  },

  async list(pagination: { limit: number; offset: number }) {
    const rows = await query<RemittanceRow>(
      `${REMITTANCE_SELECT}
        ORDER BY r.statement_date DESC NULLS LAST, r.imported_at DESC
        LIMIT $1 OFFSET $2`,
      [pagination.limit, pagination.offset],
      { name: 'cod.list' },
    )
    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM cod_remittances`,
      [],
      { name: 'cod.count' },
    )
    return { items: rows.map(toRemittance), total: totalRow?.count ?? 0 }
  },

  async get(id: string): Promise<CodRemittance> {
    const row = await queryOne<RemittanceRow>(`${REMITTANCE_SELECT} WHERE r.id = $1`, [id], {
      name: 'cod.get',
    })
    if (!row) throw new NotFoundError('Statement not found')
    return toRemittance(row)
  },

  /**
   * The lines of a statement.
   *
   * Ordered so the ones needing a person come first: an operator opens this to
   * deal with problems, not to admire the parcels that were fine.
   */
  async lines(remittanceId: string): Promise<CodRemittanceLine[]> {
    const rows = await query<LineRow>(
      `SELECT l.*, o.order_number,
              EXISTS (
                SELECT 1 FROM payments p
                 WHERE p.order_id = l.order_id
                   AND p.provider = 'carrier'
                   AND p.provider_payment_id = l.id::text
              ) AS settled
         FROM cod_remittance_lines l
         LEFT JOIN orders o ON o.id = l.order_id
        WHERE l.remittance_id = $1
        ORDER BY CASE l.match_status
                   WHEN 'mismatched' THEN 0
                   WHEN 'unmatched'  THEN 1
                   ELSE 2
                 END,
                 l.tracking_number`,
      [remittanceId],
      { name: 'cod.lines' },
    )
    return rows.map(toLine)
  },

  async getLine(lineId: string): Promise<CodRemittanceLine> {
    const rows = await query<LineRow>(
      `SELECT l.*, o.order_number,
              EXISTS (
                SELECT 1 FROM payments p
                 WHERE p.order_id = l.order_id
                   AND p.provider = 'carrier'
                   AND p.provider_payment_id = l.id::text
              ) AS settled
         FROM cod_remittance_lines l
         LEFT JOIN orders o ON o.id = l.order_id
        WHERE l.id = $1`,
      [lineId],
      { name: 'cod.getLine' },
    )
    const row = rows[0]
    if (!row) throw new NotFoundError('Statement line not found')
    return toLine(row)
  },
}

/**
 * Which order a line is about, and whether the money agrees.
 *
 * Matching is by tracking number because it is the only identifier both sides
 * genuinely share — the courier has never heard of our order numbers, and the
 * reference field on a statement is whatever the depot clerk typed.
 */
async function resolve(
  line: CarrierRemittanceLine,
  lookup: CodOrderLookup,
): Promise<{
  shipmentId: string | null
  orderId: string | null
  matchStatus: CodMatchStatus
  expectedCents: number | null
}> {
  const shipment = await queryOne<{ id: string; order_id: string }>(
    `SELECT id, order_id FROM shipments
      WHERE tracking_number = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [line.trackingNumber],
    { name: 'cod.resolveShipment' },
  )

  if (!shipment) {
    return { shipmentId: null, orderId: null, matchStatus: 'unmatched', expectedCents: null }
  }

  const order = await lookup.outstandingFor(shipment.order_id)
  if (!order) {
    return {
      shipmentId: shipment.id,
      orderId: shipment.order_id,
      matchStatus: 'unmatched',
      expectedCents: null,
    }
  }

  /*
   * A match is the amount *and* the currency.
   *
   * Comparing numbers alone would tick off a line paying 1,500 rupees against
   * an order for 1,500 of something else, which is a real way for a shop with
   * two storefronts to lose money quietly.
   */
  const agrees =
    line.collectedCents === order.outstandingCents && line.currency === order.currency

  return {
    shipmentId: shipment.id,
    orderId: shipment.order_id,
    matchStatus: agrees ? 'matched' : 'mismatched',
    expectedCents: order.outstandingCents,
  }
}

// ── Row mapping ──────────────────────────────────────────────────────────────

const REMITTANCE_SELECT = `
  SELECT r.*,
         (SELECT count(*)::int FROM cod_remittance_lines l WHERE l.remittance_id = r.id) AS line_count,
         (SELECT count(*)::int FROM cod_remittance_lines l WHERE l.remittance_id = r.id AND l.match_status = 'matched') AS matched_count,
         (SELECT count(*)::int FROM cod_remittance_lines l WHERE l.remittance_id = r.id AND l.match_status = 'mismatched') AS mismatched_count,
         (SELECT count(*)::int FROM cod_remittance_lines l WHERE l.remittance_id = r.id AND l.match_status = 'unmatched') AS unmatched_count,
         (SELECT coalesce(sum(l.collected_cents), 0)::bigint FROM cod_remittance_lines l WHERE l.remittance_id = r.id) AS collected_sum,
         (SELECT coalesce(sum(l.fee_cents), 0)::bigint FROM cod_remittance_lines l WHERE l.remittance_id = r.id) AS fee_sum,
         (SELECT coalesce(sum(l.net_cents), 0)::bigint FROM cod_remittance_lines l WHERE l.remittance_id = r.id) AS net_sum
    FROM cod_remittances r`

interface RemittanceRow {
  id: string
  provider: string
  reference: string | null
  declared_net_cents: string
  currency: string
  statement_date: Date | null
  source_filename: string | null
  imported_at: Date
  line_count: number
  matched_count: number
  mismatched_count: number
  unmatched_count: number
  collected_sum: string
  fee_sum: string
  net_sum: string
}

interface LineRow {
  id: string
  tracking_number: string
  shipment_id: string | null
  order_id: string | null
  order_number: string | null
  collected_cents: string
  fee_cents: string
  net_cents: string
  currency: string
  collected_at: Date | null
  reference: string | null
  match_status: CodMatchStatus
  expected_cents: string | null
  settled: boolean
}

/**
 * `bigint` columns arrive from `pg` as strings, because a JS number cannot hold
 * every value one can. These are minor units of money in a shop's takings, well
 * inside a safe integer, so converting here is deliberate rather than careless.
 */
function toRemittance(row: RemittanceRow): CodRemittance {
  return {
    id: row.id,
    provider: row.provider,
    reference: row.reference,
    declaredNetCents: Number(row.declared_net_cents),
    currency: row.currency,
    statementDate: row.statement_date,
    sourceFilename: row.source_filename,
    importedAt: row.imported_at,
    totals: {
      lines: row.line_count,
      matched: row.matched_count,
      mismatched: row.mismatched_count,
      unmatched: row.unmatched_count,
      collectedCents: Number(row.collected_sum),
      feeCents: Number(row.fee_sum),
      netCents: Number(row.net_sum),
    },
  }
}

function toLine(row: LineRow): CodRemittanceLine {
  return {
    id: row.id,
    trackingNumber: row.tracking_number,
    shipmentId: row.shipment_id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    collectedCents: Number(row.collected_cents),
    feeCents: Number(row.fee_cents),
    netCents: Number(row.net_cents),
    currency: row.currency,
    collectedAt: row.collected_at,
    reference: row.reference,
    matchStatus: row.match_status,
    expectedCents: row.expected_cents === null ? null : Number(row.expected_cents),
    settled: row.settled,
  }
}
