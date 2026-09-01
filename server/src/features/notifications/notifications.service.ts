/**
 * Notifications (§5.11, CLAUDE.md §27).
 *
 * A notification is **a fact addressed to a person**, distinct from the email
 * that may carry it. One fact, up to three deliveries:
 *
 * ```
 *   Order shipped
 *       ↓
 *   Notification ──┬── in-app  (a row, an unread badge)
 *                  ├── email   (a row in email_messages)
 *                  └── realtime (a socket event, if they are connected)
 * ```
 *
 * Modelling it as "an email we also stored" is what produces duplicates and
 * makes an unread count impossible.
 *
 * Not every notification needs every channel, and a person may opt out of any
 * of them. An absent preference row means enabled, so adding a new notification
 * type does not need a backfill.
 */
import { v7 as uuidv7 } from 'uuid'
import { publish } from '../../events/index.js'
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { emitToUser } from '../../infrastructure/realtime/index.js'
import { REALTIME_EVENTS } from '../../infrastructure/realtime/events.js'
import { DomainRuleError, ERROR_CODES, NotFoundError } from '../../shared/errors/index.js'

const log = createLogger('notifications')

export type NotificationChannel = 'in_app' | 'email' | 'realtime'
export type NotificationAudience = 'customer' | 'staff'

export interface Notification {
  id: string
  userId: string
  audience: NotificationAudience
  type: string
  title: string
  body: string
  data: Record<string, unknown>
  readAt: Date | null
  createdAt: Date
}

interface NotificationRow {
  id: string
  user_id: string
  audience: NotificationAudience
  type: string
  title: string
  body: string
  data: Record<string, unknown>
  read_at: Date | null
  created_at: Date
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    audience: row.audience,
    type: row.type,
    title: row.title,
    body: row.body,
    data: row.data ?? {},
    readAt: row.read_at,
    createdAt: row.created_at,
  }
}

export const notificationsService = {
  /**
   * Creates a notification and delivers it on the channels the person allows.
   *
   * `dedupeKey` is the duplicate defence: outbox dispatch is at-least-once, so
   * a redelivered event must produce one notification rather than two. The
   * uniqueness is enforced by the database, not by a prior check.
   */
  async notify(input: {
    userId: string
    audience: NotificationAudience
    type: string
    title: string
    body: string
    data?: Record<string, unknown>
    dedupeKey?: string
    channels?: NotificationChannel[]
  }): Promise<Notification | undefined> {
    const channels = input.channels ?? ['in_app', 'realtime']
    const id = uuidv7()

    // The in-app preference is consulted *before* the row is written, not after.
    // Checking it only on the socket push — which is what this used to do —
    // meant a person who turned a notification type off still got the row and
    // still got the unread badge: the endpoint accepted their preference and
    // then ignored it, which is worse than not offering the setting at all.
    if (!channels.includes('in_app')) return undefined
    if (!(await this.allows(input.userId, input.type, 'in_app'))) {
      log.debug({ userId: input.userId, type: input.type }, 'in-app notification declined by preference')
      return undefined
    }

    const row = await queryOne<NotificationRow>(
      `INSERT INTO notifications (id, user_id, audience, type, title, body, data, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING *`,
      [
        id, input.userId, input.audience, input.type, input.title, input.body,
        JSON.stringify(input.data ?? {}), input.dedupeKey ?? null,
      ],
      { name: 'notifications.create' },
    )

    // Already delivered by an earlier attempt. Nothing more to do — and
    // crucially, no second socket push either.
    if (!row) {
      log.debug({ dedupeKey: input.dedupeKey }, 'notification already delivered')
      return undefined
    }

    const notification = toNotification(row)
    await publish(
      'notification.created',
      {
        notificationId: notification.id,
        userId: notification.userId,
        type: notification.type,
        audience: notification.audience,
      },
      { aggregateId: notification.id, actorUserId: undefined },
    )

    if (channels.includes('realtime') && (await this.allows(input.userId, input.type, 'realtime'))) {
      // Best effort: a disconnected customer simply reads it next time. The
      // in-app row is the durable copy, which is why realtime is never the only
      // channel for anything that matters.
      emitToUser(notification.userId, REALTIME_EVENTS.NOTIFICATION_CREATED, {
        id: notification.id,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        createdAt: notification.createdAt.toISOString(),
      })
    }

    return notification
  },

  /** An absent preference row means enabled. */
  async allows(userId: string, type: string, channel: NotificationChannel): Promise<boolean> {
    const row = await queryOne<{ enabled: boolean }>(
      `SELECT enabled FROM notification_preferences
        WHERE user_id = $1 AND type = $2 AND channel = $3`,
      [userId, type, channel],
      { name: 'notifications.allows' },
    )
    return row?.enabled ?? true
  },

  /**
   * Notification types whose email a customer may not switch off.
   *
   * These are records of a transaction the person entered into — what they
   * bought, what it cost, that it shipped, that money went back. A store has to
   * be able to say it sent them, and a customer who has genuinely bought
   * something expects the receipt regardless of any marketing preference.
   *
   * Refusing the opt-out is the honest behaviour. Accepting it and then
   * disregarding it — which is what happens if the subscribers simply never
   * check — is a setting that lies.
   */
  transactionalTypes: new Set([
    'order.placed',
    'order.confirmed',
    'order.cancelled',
    'payment.refunded',
    'shipment.shipped',
    'shipment.delivered',
  ]),

  async setPreference(
    userId: string,
    type: string,
    channel: NotificationChannel,
    enabled: boolean,
  ): Promise<void> {
    if (!enabled && channel === 'email' && this.transactionalTypes.has(type)) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'Emails about your own orders cannot be turned off',
      )
    }
    await execute(
      `INSERT INTO notification_preferences (user_id, type, channel, enabled)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, type, channel) DO UPDATE SET enabled = excluded.enabled`,
      [userId, type, channel, enabled],
      { name: 'notifications.setPreference' },
    )
  },

  async listPreferences(userId: string) {
    return query<{ type: string; channel: NotificationChannel; enabled: boolean }>(
      `SELECT type, channel, enabled FROM notification_preferences WHERE user_id = $1`,
      [userId],
      { name: 'notifications.listPreferences' },
    )
  },

  async list(userId: string, filter: { limit: number; offset: number; unreadOnly?: boolean }) {
    const rows = await query<NotificationRow>(
      `SELECT * FROM notifications
        WHERE user_id = $1 ${filter.unreadOnly ? 'AND read_at IS NULL' : ''}
        -- The id breaks ties: two notifications written in the same instant
        -- would otherwise order nondeterministically, and offset pagination
        -- would show one of them twice and skip the other. Ids are uuidv7, so
        -- they already sort by creation time.
        ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [userId, filter.limit, filter.offset],
      { name: 'notifications.list' },
    )
    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM notifications
        WHERE user_id = $1 ${filter.unreadOnly ? 'AND read_at IS NULL' : ''}`,
      [userId],
      { name: 'notifications.count' },
    )
    return { rows: rows.map(toNotification), total: totalRow?.count ?? 0 }
  },

  async unreadCount(userId: string): Promise<number> {
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
      { name: 'notifications.unreadCount' },
    )
    return row?.count ?? 0
  },

  /** Scoped by owner: marking somebody else's notification read is a 404. */
  async markRead(userId: string, notificationId: string): Promise<void> {
    const affected = await execute(
      `UPDATE notifications SET read_at = coalesce(read_at, now())
        WHERE id = $1 AND user_id = $2`,
      [notificationId, userId],
      { name: 'notifications.markRead' },
    )
    if (affected === 0) throw new NotFoundError('Notification not found')
  },

  async markAllRead(userId: string): Promise<number> {
    return execute(
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
      { name: 'notifications.markAllRead' },
    )
  },

  /** Fan-out to every staff member, for operational alerts. */
  async notifyStaff(input: {
    type: string
    title: string
    body: string
    data?: Record<string, unknown>
    dedupeKey?: string
  }): Promise<void> {
    const staff = await query<{ id: string }>(
      `SELECT DISTINCT u.id FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE r.key IN ('staff','admin','owner') AND u.status = 'active'`,
      [],
      { name: 'notifications.staffAudience' },
    )

    for (const member of staff) {
      await this.notify({
        userId: member.id,
        audience: 'staff',
        type: input.type,
        title: input.title,
        body: input.body,
        ...(input.data ? { data: input.data } : {}),
        // Per-recipient, so one member's delivery does not suppress another's.
        ...(input.dedupeKey ? { dedupeKey: `${input.dedupeKey}:${member.id}` } : {}),
      })
    }
  },
}
