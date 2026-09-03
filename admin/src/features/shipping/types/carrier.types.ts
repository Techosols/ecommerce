/**
 * The courier, as the server describes it.
 *
 * Every shape here mirrors what `cod.admin.routes.ts` and `carrier.service.ts`
 * publish. Nothing in the admin decides any of it: which courier is connected,
 * what it can do, whether a statement line matched and whether a line may be
 * banked are all the server's answers, read here to decide what to draw.
 */

/**
 * What the connected courier can actually do.
 *
 * This is what decides which buttons exist. A shop on the manual provider gets
 * every flag false and is therefore never offered a "Book with courier" action
 * that could not work — the alternative being a button that fails at the one
 * moment somebody is trying to get a parcel out of the door.
 */
export interface CarrierCapabilities {
  provider: string
  label: string
  quotes: boolean
  booking: boolean
  tracking: boolean
  remittance: boolean
  canImportRemittances: boolean
}

/** The shop's own vocabulary for where a parcel is. */
export type ShipmentStatus =
  | 'pending'
  | 'processing'
  | 'shipped'
  | 'in_transit'
  | 'delivered'
  | 'returned'
  | 'failed'

export interface TrackingEvent {
  id: string
  status: ShipmentStatus
  /** The courier's own words. */
  description: string
  location: string | null
  /** The courier's raw code, shown so a mis-mapping is visible rather than inferred. */
  rawStatus: string | null
  occurredAt: string
  provider: string
}

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
  collectedAt: string | null
  reference: string | null
  matchStatus: CodMatchStatus
  /** What the order was owed when the statement was read, frozen at import. */
  expectedCents: number | null
  settled: boolean
}

export interface CodRemittance {
  id: string
  provider: string
  reference: string | null
  declaredNetCents: number
  currency: string
  statementDate: string | null
  sourceFilename: string | null
  importedAt: string
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

export type CodRemittanceDetail = CodRemittance & { lines: CodRemittanceLine[] }

export interface ImportRemittanceInput {
  filename: string
  /** The statement's bytes, base64-encoded. */
  content: string
  reference?: string | null
  statementDate?: string | null
  currency?: string | null
}
