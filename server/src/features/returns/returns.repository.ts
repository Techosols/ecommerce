/**
 * Returns data access (§1.2). SQL only.
 */
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import type {
  ReturnCondition,
  ReturnLineItem,
  ReturnListFilter,
  ReturnReason,
  ReturnRequest,
  ReturnStatus,
} from './returns.types.js'

interface ReturnRow {
  id: string
  return_number: string
  order_id: string
  customer_id: string | null
  status: ReturnStatus
  reason: ReturnReason
  customer_note: string | null
  staff_note: string | null
  refund_id: string | null
  requested_at: Date
  approved_at: Date | null
  received_at: Date | null
  closed_at: Date | null
  created_at: Date
  updated_at: Date
}

interface LineRow {
  id: string
  return_id: string
  order_item_id: string
  quantity: number
  received_quantity: number
  restocked_quantity: number
  condition: ReturnCondition | null
  created_at: Date
}

function toReturn(row: ReturnRow): ReturnRequest {
  return {
    id: row.id,
    returnNumber: row.return_number,
    orderId: row.order_id,
    customerId: row.customer_id,
    status: row.status,
    reason: row.reason,
    customerNote: row.customer_note,
    staffNote: row.staff_note,
    refundId: row.refund_id,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    receivedAt: row.received_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toLine(row: LineRow): ReturnLineItem {
  return {
    id: row.id,
    returnId: row.return_id,
    orderItemId: row.order_item_id,
    quantity: row.quantity,
    receivedQuantity: row.received_quantity,
    restockedQuantity: row.restocked_quantity,
    condition: row.condition,
    createdAt: row.created_at,
  }
}

export const returnsRepository = {
  /** A sequence, not a row count: two returns opened at once must not collide. */
  async nextReturnNumber(): Promise<string> {
    const row = await queryOne<{ n: string }>(`SELECT nextval('return_number_seq') AS n`, [], {
      name: 'returns.nextReturnNumber',
    })
    return `R${row?.n ?? '0'}`
  },

  async create(input: {
    id: string
    returnNumber: string
    orderId: string
    customerId: string | null
    reason: ReturnReason
    customerNote: string | null
  }): Promise<ReturnRequest> {
    const row = await queryOne<ReturnRow>(
      `INSERT INTO return_requests
         (id, return_number, order_id, customer_id, reason, customer_note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        input.id,
        input.returnNumber,
        input.orderId,
        input.customerId,
        input.reason,
        input.customerNote,
      ],
      { name: 'returns.create' },
    )
    if (!row) throw new Error('Failed to create return')
    return toReturn(row)
  },

  async insertLine(input: {
    id: string
    returnId: string
    orderItemId: string
    quantity: number
  }): Promise<void> {
    await execute(
      `INSERT INTO return_line_items (id, return_id, order_item_id, quantity)
       VALUES ($1,$2,$3,$4)`,
      [input.id, input.returnId, input.orderItemId, input.quantity],
      { name: 'returns.insertLine' },
    )
  },

  async findById(id: string): Promise<ReturnRequest | undefined> {
    const row = await queryOne<ReturnRow>(`SELECT * FROM return_requests WHERE id = $1`, [id], {
      name: 'returns.findById',
    })
    return row ? toReturn(row) : undefined
  },

  /** Locks the return, so two staff actions on it serialise (§18.3). */
  async lock(id: string): Promise<ReturnRequest | undefined> {
    const row = await queryOne<ReturnRow>(
      `SELECT * FROM return_requests WHERE id = $1 FOR UPDATE`,
      [id],
      { name: 'returns.lock' },
    )
    return row ? toReturn(row) : undefined
  },

  async lines(returnId: string): Promise<ReturnLineItem[]> {
    const rows = await query<LineRow>(
      `SELECT * FROM return_line_items WHERE return_id = $1 ORDER BY created_at, id`,
      [returnId],
      { name: 'returns.lines' },
    )
    return rows.map(toLine)
  },

  /**
   * Moves the status, and only from the value the caller read.
   *
   * The compare-and-swap is what makes two staff approving at once produce one
   * approval: the second finds the row no longer in `requested` and is told the
   * move is no longer legal, rather than both succeeding and one overwriting
   * the other's timestamp.
   */
  async transition(input: {
    id: string
    from: ReturnStatus
    to: ReturnStatus
    stamp?: 'approved_at' | 'received_at' | 'closed_at' | null
    staffNote?: string | null
  }): Promise<boolean> {
    const sets = ['status = $3']
    const params: unknown[] = [input.id, input.from, input.to]

    if (input.stamp) sets.push(`${input.stamp} = now()`)
    if (input.staffNote !== undefined && input.staffNote !== null) {
      params.push(input.staffNote)
      sets.push(`staff_note = $${params.length}`)
    }

    const affected = await execute(
      `UPDATE return_requests SET ${sets.join(', ')} WHERE id = $1 AND status = $2`,
      params,
      { name: 'returns.transition' },
    )
    return affected === 1
  },

  async setRefund(id: string, refundId: string): Promise<void> {
    await execute(`UPDATE return_requests SET refund_id = $2 WHERE id = $1`, [id, refundId], {
      name: 'returns.setRefund',
    })
  },

  async recordReceipt(input: {
    lineId: string
    receivedQuantity: number
    restockedQuantity: number
    condition: ReturnCondition
  }): Promise<void> {
    await execute(
      `UPDATE return_line_items
          SET received_quantity = $2, restocked_quantity = $3, condition = $4
        WHERE id = $1`,
      [input.lineId, input.receivedQuantity, input.restockedQuantity, input.condition],
      { name: 'returns.recordReceipt' },
    )
  },

  /**
   * Commits units to a return, refusing to over-commit the order line.
   *
   * Conditional, in the same shape as `incrementFulfilled` and
   * `incrementRefunded`: the guard is in the WHERE clause, so two returns
   * opened against the same line at the same moment cannot between them commit
   * more units than were bought.
   */
  async commitUnits(orderItemId: string, quantity: number): Promise<boolean> {
    const affected = await execute(
      `UPDATE order_items
          SET returned_quantity = returned_quantity + $2
        WHERE id = $1 AND returned_quantity + $2 <= quantity`,
      [orderItemId, quantity],
      { name: 'returns.commitUnits' },
    )
    return affected === 1
  },

  /** Gives units back when a return is declined or cancelled before it arrives. */
  async releaseUnits(orderItemId: string, quantity: number): Promise<void> {
    await execute(
      `UPDATE order_items
          SET returned_quantity = greatest(0, returned_quantity - $2)
        WHERE id = $1`,
      [orderItemId, quantity],
      { name: 'returns.releaseUnits' },
    )
  },

  async list(filter: ReturnListFilter): Promise<{ rows: ReturnRequest[]; total: number }> {
    const params: unknown[] = []
    const where: string[] = []
    const add = (sql: string, value: unknown): void => {
      params.push(value)
      where.push(sql.replace('$?', `$${params.length}`))
    }

    if (filter.status) add('status = $?', filter.status)
    if (filter.orderId) add('order_id = $?', filter.orderId)
    if (filter.customerId) add('customer_id = $?', filter.customerId)

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = await query<ReturnRow>(
      `SELECT * FROM return_requests ${clause} ORDER BY created_at DESC, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.limit, filter.offset],
      { name: 'returns.list' },
    )
    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM return_requests ${clause}`,
      params,
      { name: 'returns.count' },
    )
    return { rows: rows.map(toReturn), total: totalRow?.count ?? 0 }
  },

  /** Every return on one order, for the order page. */
  async forOrder(orderId: string): Promise<ReturnRequest[]> {
    const rows = await query<ReturnRow>(
      `SELECT * FROM return_requests WHERE order_id = $1 ORDER BY created_at DESC`,
      [orderId],
      { name: 'returns.forOrder' },
    )
    return rows.map(toReturn)
  },
}
