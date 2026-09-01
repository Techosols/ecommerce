/**
 * Customer and address data access (§1.2). SQL only.
 */
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import type {
  Address,
  CustomerEvent,
  CustomerListFilter,
  CustomerSummary,
  MarketingState,
} from './customers.types.js'

interface AddressRow {
  id: string
  user_id: string
  label: string | null
  first_name: string
  last_name: string
  company: string | null
  line1: string
  line2: string | null
  city: string
  region: string | null
  postal_code: string | null
  country_code: string
  phone: string | null
  is_default: boolean
  created_at: Date
  updated_at: Date
  archived_at: Date | null
}

function toAddress(row: AddressRow): Address {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    firstName: row.first_name,
    lastName: row.last_name,
    company: row.company,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    countryCode: row.country_code,
    phone: row.phone,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

interface CustomerRow {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  status: string
  email_verified_at: Date | null
  accepts_marketing: boolean
  marketing_email_state: MarketingState
  marketing_sms_state: MarketingState
  marketing_opt_in_level: string | null
  tags: string[] | null
  admin_note: string | null
  tax_exempt: boolean
  locale: string | null
  orders_count: number
  total_spent_cents: string | number
  first_order_at: Date | null
  last_order_at: Date | null
  created_at: Date
}

/** The columns every customer read selects. One list, so they cannot drift. */
const CUSTOMER_COLUMNS = `u.id, u.email, u.first_name, u.last_name, u.phone, u.status,
       u.email_verified_at, u.accepts_marketing, u.marketing_email_state,
       u.marketing_sms_state, u.marketing_opt_in_level, u.tags, u.admin_note,
       u.tax_exempt, u.locale, u.orders_count, u.total_spent_cents,
       u.first_order_at, u.last_order_at, u.created_at`

function toCustomer(row: CustomerRow): CustomerSummary {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    status: row.status,
    emailVerified: row.email_verified_at !== null,
    acceptsMarketing: row.accepts_marketing,
    marketingEmailState: row.marketing_email_state,
    marketingSmsState: row.marketing_sms_state,
    marketingOptInLevel: row.marketing_opt_in_level,
    tags: row.tags ?? [],
    adminNote: row.admin_note,
    taxExempt: row.tax_exempt,
    locale: row.locale,
    ordersCount: row.orders_count,
    // bigint arrives as a string from pg; a silent NaN in a money figure is
    // worse than a loud one.
    totalSpentCents: Number(row.total_spent_cents),
    firstOrderAt: row.first_order_at,
    lastOrderAt: row.last_order_at,
    createdAt: row.created_at,
  }
}

interface EventRow {
  id: string
  customer_id: string
  kind: string
  body: string | null
  actor_user_id: string | null
  actor_name: string | null
  metadata: Record<string, unknown>
  created_at: Date
}

function toEvent(row: EventRow): CustomerEvent {
  return {
    id: row.id,
    customerId: row.customer_id,
    kind: row.kind,
    body: row.body,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  }
}

const ADDRESS_COLUMNS: Record<string, string> = {
  label: 'label',
  firstName: 'first_name',
  lastName: 'last_name',
  company: 'company',
  line1: 'line1',
  line2: 'line2',
  city: 'city',
  region: 'region',
  postalCode: 'postal_code',
  countryCode: 'country_code',
  phone: 'phone',
  isDefault: 'is_default',
}

/**
 * Sort key → ORDER BY, as an allowlist.
 *
 * The clause is chosen from this table, never built from the caller's string.
 * Every clause ends in `u.id` so paging is stable: two customers created in the
 * same millisecond must not swap places between page one and page two.
 */
const CUSTOMER_ORDER: Record<string, string> = {
  created: 'u.created_at',
  spend: 'u.total_spent_cents',
  orders: 'u.orders_count',
  lastOrder: 'u.last_order_at',
  name: "coalesce(u.last_name, u.first_name, u.email)",
}

function orderClause(sort: string | undefined, direction: string | undefined): string {
  const column = CUSTOMER_ORDER[sort ?? 'created'] ?? CUSTOMER_ORDER.created
  const order = direction === 'asc' ? 'ASC' : 'DESC'
  // NULLS LAST on either order: a customer who has never ordered belongs at the
  // bottom of "most recent order", not the top.
  return `${column} ${order} NULLS LAST, u.id ${order}`
}

export const customersRepository = {
  // ── Customers ─────────────────────────────────────────────────────────────

  /**
   * Lists customers — people holding the `customer` role and nothing higher.
   *
   * Staff are excluded on purpose: an admin looking at "customers" wants the
   * people who buy, and mixing colleagues into that list makes segment counts
   * quietly wrong.
   */
  async list(
    filter: CustomerListFilter & { segmentWhere?: string; segmentParams?: unknown[] },
  ): Promise<{ rows: CustomerSummary[]; total: number }> {
    // Segment parameters are bound first, because the fragment was compiled
    // against a known starting offset and its placeholders are already numbered.
    const params: unknown[] = [...(filter.segmentParams ?? [])]
    const where: string[] = [
      `EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id AND r.key = 'customer')`,
      `NOT EXISTS (SELECT 1 FROM user_roles ur2 JOIN roles r2 ON r2.id = ur2.role_id
                    WHERE ur2.user_id = u.id AND r2.key IN ('staff','admin','owner'))`,
    ]

    const add = (sql: string, value: unknown): void => {
      params.push(value)
      where.push(sql.replace('$?', `$${params.length}`))
    }

    if (filter.status) add('u.status = $?', filter.status)
    if (filter.acceptsMarketing !== undefined) add('u.accepts_marketing = $?', filter.acceptsMarketing)
    if (filter.hasOrders !== undefined) {
      where.push(filter.hasOrders ? 'u.orders_count > 0' : 'u.orders_count = 0')
    }
    if (filter.marketingEmailState) add('u.marketing_email_state = $?', filter.marketingEmailState)
    if (filter.taxExempt !== undefined) add('u.tax_exempt = $?', filter.taxExempt)
    // `@>` means "carries every one of these", so two tags narrow rather than widen.
    if (filter.tags && filter.tags.length > 0) add('u.tags @> $?', filter.tags)
    if (filter.minSpentCents !== undefined) add('u.total_spent_cents >= $?', filter.minSpentCents)
    if (filter.maxSpentCents !== undefined) add('u.total_spent_cents <= $?', filter.maxSpentCents)
    if (filter.minOrders !== undefined) add('u.orders_count >= $?', filter.minOrders)
    if (filter.maxOrders !== undefined) add('u.orders_count <= $?', filter.maxOrders)
    if (filter.createdAfter) add('u.created_at >= $?', filter.createdAfter)
    if (filter.createdBefore) add('u.created_at <= $?', filter.createdBefore)
    if (filter.lastOrderAfter) add('u.last_order_at >= $?', filter.lastOrderAfter)
    if (filter.noOrderSince) {
      // "Nothing since" has to include people who have never ordered at all —
      // they are the most lapsed customers there are, and a plain `<` on a NULL
      // column silently drops every one of them.
      params.push(filter.noOrderSince)
      where.push(`(u.last_order_at IS NULL OR u.last_order_at < $${params.length})`)
    }
    if (filter.segmentWhere) where.push(filter.segmentWhere)

    if (filter.query) {
      // One parameter, three columns. ILIKE with a leading wildcard cannot use
      // a b-tree index; at single-store scale that is the right trade against
      // maintaining a second tsvector for names.
      params.push(`%${filter.query}%`)
      where.push(
        `(u.email ILIKE $${params.length} OR u.first_name ILIKE $${params.length}
          OR u.last_name ILIKE $${params.length} OR u.phone ILIKE $${params.length})`,
      )
    }

    const clause = `WHERE ${where.join(' AND ')}`
    const rows = await query<CustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS}
         FROM users u ${clause}
        ORDER BY ${orderClause(filter.sort, filter.direction)}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.limit, filter.offset],
      { name: 'customers.list' },
    )

    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM users u ${clause}`,
      params,
      { name: 'customers.count' },
    )
    return { rows: rows.map(toCustomer), total: totalRow?.count ?? 0 }
  },

  async findById(userId: string): Promise<CustomerSummary | undefined> {
    const row = await queryOne<CustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS} FROM users u WHERE u.id = $1`,
      [userId],
      { name: 'customers.findById' },
    )
    return row ? toCustomer(row) : undefined
  },

  async updateProfile(
    userId: string,
    patch: { firstName?: string | null; lastName?: string | null; phone?: string | null; acceptsMarketing?: boolean },
  ): Promise<void> {
    const columns: Record<string, string> = {
      firstName: 'first_name',
      lastName: 'last_name',
      phone: 'phone',
    }
    const params: unknown[] = []
    const sets: string[] = []
    for (const [field, column] of Object.entries(columns)) {
      if (!(field in patch) || patch[field as keyof typeof patch] === undefined) continue
      params.push(patch[field as keyof typeof patch])
      sets.push(`${column} = $${params.length}`)
    }
    if (patch.acceptsMarketing !== undefined) {
      // `accepts_marketing` is a generated column now, so the boolean the
      // storefront sends is written as the state it stands for. Consent needs
      // a timestamp to be defensible; withdrawal clears it.
      params.push(patch.acceptsMarketing ? 'subscribed' : 'unsubscribed')
      sets.push(`marketing_email_state = $${params.length}`)
      sets.push('marketing_updated_at = now()')
      sets.push(patch.acceptsMarketing ? 'marketing_consent_at = now()' : 'marketing_consent_at = NULL')
    }
    if (sets.length === 0) return

    params.push(userId)
    await execute(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params, {
      name: 'customers.updateProfile',
    })
  },

  /**
   * The fields an admin may set on a customer record.
   *
   * A closed allowlist rather than a spread of the request body: `status`,
   * `orders_count` and `total_spent_cents` are all columns on this table, and
   * none of them is something a form should be able to write.
   */
  async updateAdmin(
    userId: string,
    patch: {
      firstName?: string | null
      lastName?: string | null
      phone?: string | null
      adminNote?: string | null
      taxExempt?: boolean
      locale?: string | null
    },
  ): Promise<void> {
    const columns: Record<string, string> = {
      firstName: 'first_name',
      lastName: 'last_name',
      phone: 'phone',
      adminNote: 'admin_note',
      taxExempt: 'tax_exempt',
      locale: 'locale',
    }
    const params: unknown[] = []
    const sets: string[] = []
    for (const [field, column] of Object.entries(columns)) {
      const value = patch[field as keyof typeof patch]
      if (!(field in patch) || value === undefined) continue
      params.push(value)
      sets.push(`${column} = $${params.length}`)
    }
    if (sets.length === 0) return

    params.push(userId)
    await execute(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params, {
      name: 'customers.updateAdmin',
    })
  },

  /**
   * Adds tags without disturbing the ones already there.
   *
   * `array_cat` plus a de-duplicating subquery rather than read-modify-write,
   * so two staff tagging the same customer at once cannot lose one another's
   * tag. Case-insensitive: "VIP" and "vip" are one tag, and the spelling that
   * was there first is the one that stays.
   */
  async addTags(userId: string, tags: string[]): Promise<void> {
    if (tags.length === 0) return
    await execute(
      `UPDATE users
          SET tags = (
            SELECT array_agg(t ORDER BY ord)
              FROM (
                SELECT DISTINCT ON (lower(t)) t, ord
                  FROM unnest(array_cat(users.tags, $2::text[]))
                       WITH ORDINALITY AS x(t, ord)
                 ORDER BY lower(t), ord
              ) deduped
          )
        WHERE id = $1`,
      [userId, tags],
      { name: 'customers.addTags' },
    )
  },

  async removeTags(userId: string, tags: string[]): Promise<void> {
    if (tags.length === 0) return
    await execute(
      `UPDATE users
          SET tags = coalesce((
            SELECT array_agg(t ORDER BY ord)
              FROM unnest(tags) WITH ORDINALITY AS x(t, ord)
             WHERE lower(t) <> ALL (SELECT lower(r) FROM unnest($2::text[]) AS r)
          ), '{}')
        WHERE id = $1`,
      [userId, tags],
      { name: 'customers.removeTags' },
    )
  },

  async setConsent(
    userId: string,
    input: { channel: 'email' | 'sms'; state: string; optInLevel?: string | null },
  ): Promise<void> {
    const column = input.channel === 'sms' ? 'marketing_sms_state' : 'marketing_email_state'
    await execute(
      `UPDATE users
          SET ${column} = $2,
              marketing_opt_in_level = coalesce($3, marketing_opt_in_level),
              marketing_updated_at = now(),
              marketing_consent_at = CASE WHEN $2 = 'subscribed' THEN now()
                                          WHEN $2 = 'unsubscribed' THEN NULL
                                          ELSE marketing_consent_at END
        WHERE id = $1`,
      [userId, input.state, input.optInLevel ?? null],
      { name: 'customers.setConsent' },
    )
  },

  // ── Timeline ──────────────────────────────────────────────────────────────

  async insertEvent(input: {
    id: string
    customerId: string
    kind: string
    body?: string | null
    actorUserId?: string | null
    actorName?: string | null
    metadata?: Record<string, unknown>
  }): Promise<CustomerEvent> {
    const row = await queryOne<EventRow>(
      `INSERT INTO customer_events (id, customer_id, kind, body, actor_user_id, actor_name, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        input.id,
        input.customerId,
        input.kind,
        input.body ?? null,
        input.actorUserId ?? null,
        input.actorName ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
      { name: 'customers.insertEvent' },
    )
    if (!row) throw new Error('Failed to write the customer event')
    return toEvent(row)
  },

  async events(customerId: string, limit = 100): Promise<CustomerEvent[]> {
    const rows = await query<EventRow>(
      `SELECT * FROM customer_events WHERE customer_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [customerId, limit],
      { name: 'customers.events' },
    )
    return rows.map(toEvent)
  },

  /** Scoped to the customer, and to notes: system events are not deleteable. */
  async deleteNote(customerId: string, eventId: string): Promise<number> {
    return execute(
      `DELETE FROM customer_events WHERE id = $1 AND customer_id = $2 AND kind = 'note'`,
      [eventId, customerId],
      { name: 'customers.deleteNote' },
    )
  },

  // ── Merge ─────────────────────────────────────────────────────────────────

  /**
   * Moves everything one customer owns onto another.
   *
   * Orders, addresses and timeline entries are re-pointed rather than copied,
   * so nothing is duplicated and no id changes. The rollups are recomputed
   * afterwards rather than added together — adding them would double anything
   * the two records already shared.
   */
  async movePossessions(fromId: string, toId: string): Promise<void> {
    await execute(`UPDATE orders SET customer_id = $2 WHERE customer_id = $1`, [fromId, toId], {
      name: 'customers.moveOrders',
    })
    await execute(
      `UPDATE addresses SET user_id = $2, is_default = false WHERE user_id = $1`,
      [fromId, toId],
      { name: 'customers.moveAddresses' },
    )
    await execute(
      `UPDATE customer_events SET customer_id = $2 WHERE customer_id = $1`,
      [fromId, toId],
      { name: 'customers.moveEvents' },
    )
  },

  async deleteCustomer(userId: string): Promise<void> {
    await execute(`DELETE FROM users WHERE id = $1`, [userId], { name: 'customers.delete' })
  },

  /**
   * Rebuilds the lifetime figures from the orders themselves.
   *
   * The counters are maintained incrementally as orders are confirmed, which is
   * right for the hot path and wrong the moment anything is imported, merged or
   * corrected by hand. This is the answer to "these numbers look off".
   */
  async recomputeMetrics(userId: string): Promise<void> {
    await execute(
      `UPDATE users u
          SET orders_count = coalesce(o.count, 0),
              total_spent_cents = coalesce(o.total, 0),
              first_order_at = o.first_at,
              last_order_at = o.last_at
         FROM (
           SELECT count(*)::int AS count,
                  coalesce(sum(total_cents - refunded_total_cents), 0) AS total,
                  min(placed_at) AS first_at,
                  max(placed_at) AS last_at
             FROM orders
            -- Drafts excluded: a draft is an order somebody is still typing,
            -- and counting one would give a customer a lifetime value they
            -- have not spent.
            WHERE customer_id = $1 AND status NOT IN ('cancelled', 'draft')
         ) o
        WHERE u.id = $1`,
      [userId],
      { name: 'customers.recomputeMetrics' },
    )
  },

  /** Every customer id, for a full rebuild. */
  async allCustomerIds(): Promise<string[]> {
    const rows = await query<{ id: string }>(
      `SELECT u.id FROM users u
        WHERE EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                       WHERE ur.user_id = u.id AND r.key = 'customer')`,
      [],
      { name: 'customers.allIds' },
    )
    return rows.map((row) => row.id)
  },

  /**
   * Records a completed purchase against the customer's lifetime figures.
   *
   * A single atomic statement rather than read-modify-write, so concurrent
   * orders for one customer cannot lose an increment.
   */
  async recordPurchase(userId: string, totalCents: number, placedAt: Date): Promise<void> {
    await execute(
      `UPDATE users
          SET orders_count = orders_count + 1,
              total_spent_cents = total_spent_cents + $2,
              first_order_at = least(coalesce(first_order_at, $3), $3),
              last_order_at = greatest(coalesce(last_order_at, $3), $3)
        WHERE id = $1`,
      [userId, totalCents, placedAt],
      { name: 'customers.recordPurchase' },
    )
  },

  // ── Addresses ─────────────────────────────────────────────────────────────

  async listAddresses(userId: string): Promise<Address[]> {
    const rows = await query<AddressRow>(
      `SELECT * FROM addresses WHERE user_id = $1 AND archived_at IS NULL
        ORDER BY is_default DESC, created_at DESC`,
      [userId],
      { name: 'customers.listAddresses' },
    )
    return rows.map(toAddress)
  },

  async findAddress(id: string): Promise<Address | undefined> {
    const row = await queryOne<AddressRow>(`SELECT * FROM addresses WHERE id = $1`, [id], {
      name: 'customers.findAddress',
    })
    return row ? toAddress(row) : undefined
  },

  async createAddress(input: {
    id: string
    userId: string
    label: string | null
    firstName: string
    lastName: string
    company: string | null
    line1: string
    line2: string | null
    city: string
    region: string | null
    postalCode: string | null
    countryCode: string
    phone: string | null
    isDefault: boolean
  }): Promise<Address> {
    const row = await queryOne<AddressRow>(
      `INSERT INTO addresses
         (id, user_id, label, first_name, last_name, company, line1, line2, city,
          region, postal_code, country_code, phone, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        input.id, input.userId, input.label, input.firstName, input.lastName, input.company,
        input.line1, input.line2, input.city, input.region, input.postalCode,
        input.countryCode, input.phone, input.isDefault,
      ],
      { name: 'customers.createAddress' },
    )
    if (!row) throw new Error('Failed to create address')
    return toAddress(row)
  },

  async updateAddress(id: string, patch: Record<string, unknown>): Promise<Address | undefined> {
    const params: unknown[] = []
    const sets: string[] = []
    for (const [field, column] of Object.entries(ADDRESS_COLUMNS)) {
      if (!(field in patch) || patch[field] === undefined) continue
      params.push(patch[field])
      sets.push(`${column} = $${params.length}`)
    }
    if (sets.length === 0) return this.findAddress(id)

    params.push(id)
    const row = await queryOne<AddressRow>(
      `UPDATE addresses SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
      { name: 'customers.updateAddress' },
    )
    return row ? toAddress(row) : undefined
  },

  async clearDefaultAddress(userId: string): Promise<void> {
    await execute(
      `UPDATE addresses SET is_default = false WHERE user_id = $1 AND is_default`,
      [userId],
      { name: 'customers.clearDefaultAddress' },
    )
  },

  /** Archive rather than delete: an old order may still cite this address. */
  async archiveAddress(id: string): Promise<void> {
    await execute(
      `UPDATE addresses SET archived_at = now(), is_default = false WHERE id = $1`,
      [id],
      { name: 'customers.archiveAddress' },
    )
  },

  async countAddresses(userId: string): Promise<number> {
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM addresses WHERE user_id = $1 AND archived_at IS NULL`,
      [userId],
      { name: 'customers.countAddresses' },
    )
    return row?.count ?? 0
  },
}
