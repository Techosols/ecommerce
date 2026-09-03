/**
 * Which emails the shop sends (§10.2).
 *
 * ── Why absence means "on" ───────────────────────────────────────────────────
 *
 * The registry in code lists the templates that exist; this table records only
 * what has been *decided* about them. A template with no row is enabled, so a
 * new one ships working and the shop turns it off if it wants to. The reverse —
 * requiring a row before anything sends — means every new template ships silent
 * and is discovered by a customer who never got their receipt.
 *
 * ── The cache ────────────────────────────────────────────────────────────────
 *
 * Every single email checks this, so it is cached the same way store settings
 * are and invalidated on write. Sixty seconds of a stale switch is the cost; the
 * alternative is a database round trip on the path of every message the shop
 * sends.
 */
import { TtlCache } from '../cache/memory.js'
import { execute, query } from '../database/query.js'
import { createLogger } from '../logging/logger.js'
import { ValidationError } from '../../shared/errors/index.js'
import { ALWAYS_ON, EMAIL_TEMPLATES, isAlwaysOn, type TemplateName } from './templates/registry.js'

const log = createLogger('email.settings')

const cache = new TtlCache<Record<string, boolean>>({ ttlMs: 60_000 })
const CACHE_KEY = 'email-template-settings'

export interface EmailTemplateSetting {
  template: TemplateName
  enabled: boolean
  /** Non-null when this one cannot be switched off, and says why. */
  alwaysOnReason: string | null
  updatedAt: Date | null
}

async function overrides(): Promise<Record<string, boolean>> {
  const cached = cache.get(CACHE_KEY)
  if (cached) return cached

  const rows = await query<{ template: string; enabled: boolean }>(
    `SELECT template, enabled FROM email_template_settings`,
    [],
    { name: 'emailSettings.all' },
  )
  const map: Record<string, boolean> = {}
  for (const row of rows) map[row.template] = row.enabled
  cache.set(CACHE_KEY, map)
  return map
}

export const emailSettingsService = {
  /**
   * Whether this template may be sent at all.
   *
   * The always-on check comes first and does not consult the database. A row
   * saying `password-reset` is disabled — however it got there, a bad migration,
   * a direct UPDATE — must not be able to lock every customer out of their
   * account. Code is the authority on which mails are load-bearing.
   */
  async isEnabled(template: string): Promise<boolean> {
    if (isAlwaysOn(template)) return true
    return (await overrides())[template] ?? true
  },

  /** Every template with its current state, for the settings screen. */
  async list(): Promise<EmailTemplateSetting[]> {
    const rows = await query<{ template: string; enabled: boolean; updated_at: Date }>(
      `SELECT template, enabled, updated_at FROM email_template_settings`,
      [],
      { name: 'emailSettings.list' },
    )
    const byTemplate = new Map(rows.map((row) => [row.template, row]))

    // Driven by the registry, not the table: a template nobody has touched must
    // still appear, and a stale row for a deleted template must not.
    return (Object.keys(EMAIL_TEMPLATES) as TemplateName[]).map((template) => {
      const row = byTemplate.get(template)
      return {
        template,
        enabled: isAlwaysOn(template) ? true : (row?.enabled ?? true),
        alwaysOnReason: ALWAYS_ON[template] ?? null,
        updatedAt: row?.updated_at ?? null,
      }
    })
  },

  async setEnabled(template: string, enabled: boolean, actorUserId: string | null): Promise<void> {
    if (!(template in EMAIL_TEMPLATES)) {
      throw new ValidationError(`Unknown email template: ${template}`)
    }
    if (isAlwaysOn(template)) {
      // A 422 rather than a silent no-op: a switch that appears to move and
      // does nothing is worse than one that refuses and says why.
      throw new ValidationError(
        `"${template}" cannot be switched off. ${ALWAYS_ON[template as TemplateName] ?? ''}`.trim(),
      )
    }

    await execute(
      `INSERT INTO email_template_settings (template, enabled, updated_by)
            VALUES ($1, $2, $3)
       ON CONFLICT (template) DO UPDATE
            SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by`,
      [template, enabled, actorUserId],
      { name: 'emailSettings.setEnabled' },
    )
    cache.invalidate(CACHE_KEY)
    log.info({ template, enabled, actorUserId }, 'email template toggled')
  },

  invalidate(): void {
    cache.invalidate(CACHE_KEY)
  },
}
