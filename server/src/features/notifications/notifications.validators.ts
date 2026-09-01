/**
 * Notification request schemas (§17.2). Strict throughout.
 *
 * A caller may read their notifications, mark them read and set their own
 * preferences. There is deliberately no endpoint that *creates* one: a
 * notification is a consequence of something that happened, raised by a
 * subscriber, never something a client can post to another person.
 */
import { z } from 'zod'
import { offsetPaginationQuery } from '../../shared/http/pagination.js'

export const notificationListQuery = offsetPaginationQuery.extend({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
})

export const setPreferenceSchema = z.strictObject({
  type: z.string().trim().min(1).max(80),
  channel: z.enum(['in_app', 'email', 'realtime']),
  enabled: z.boolean(),
})

export const idParam = z.strictObject({ id: z.uuid() })
