/**
 * Store settings (§23.14).
 *
 * Read on nearly every request that renders money, a date or the store's name,
 * and changed a handful of times a year — so it is cached in process for 60
 * seconds and invalidated explicitly on write and on the `settings.updated`
 * event. The event matters because the API and the worker are separate
 * processes: each reacts to it and drops its own copy.
 */
import { publish } from '../../events/index.js'
import { TtlCache } from '../../infrastructure/cache/memory.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import type { Actor } from '../../shared/auth/actor.js'
import { ValidationError } from '../../shared/errors/index.js'
import { auditService, diffChanged } from '../audit/index.js'
import { settingsRepository } from './settings.repository.js'
import type { BankTransferDetails, PublicStoreSettings, StoreSettings, StoreSettingsUpdate } from './settings.types.js'

const log = createLogger('settings.service')

const CACHE_KEY = 'store'
const cache = new TtlCache<StoreSettings>({ ttlMs: 60_000, maxEntries: 1 })

export const settingsService = {
  async get(): Promise<StoreSettings> {
    return cache.getOrLoad(CACHE_KEY, () => settingsRepository.get())
  },

  /** Bypasses the cache. For a caller that has just written. */
  async getFresh(): Promise<StoreSettings> {
    const settings = await settingsRepository.get()
    cache.set(CACHE_KEY, settings)
    return settings
  },

  /**
   * Updates settings, audits the diff and publishes the change — all in one
   * transaction, so an audit row never exists for a change that rolled back.
   */
  async update(
    patch: StoreSettingsUpdate,
    actor: Actor,
    context: { ip?: string | null } = {},
  ): Promise<StoreSettings> {
    if (Object.keys(patch).length === 0) {
      throw new ValidationError('No settings were supplied to update')
    }

    const updated = await withTransaction(async () => {
      const before = await settingsRepository.getForUpdate()
      const changed = diffChanged(before as unknown as Record<string, unknown>, patch)

      const after = await settingsRepository.update(patch, actor.userId)

      if (changed) {
        await auditService.record({
          actor,
          action: 'settings.updated',
          resourceType: 'store_settings',
          resourceId: '1',
          before: changed.before,
          after: changed.after,
          ip: context.ip ?? null,
        })
        await publish('settings.updated', {
          changed: Object.keys(changed.after),
          actorId: actor.userId,
        })
      }

      return after
    })

    cache.set(CACHE_KEY, updated)
    log.info({ actorId: actor.userId, changed: Object.keys(patch) }, 'store settings updated')
    return updated
  },

  /**
   * The storefront's view. An explicit allowlist, so adding an admin-only
   * setting cannot leak it by omission.
   */
  toPublic(settings: StoreSettings, logoUrl: string | null): PublicStoreSettings {
    return {
      storeName: settings.storeName,
      contactEmail: settings.contactEmail,
      supportUrl: settings.supportUrl,
      currency: settings.currency,
      timezone: settings.timezone,
      weightUnit: settings.weightUnit,
      guestCheckoutEnabled: settings.guestCheckoutEnabled,
      logoUrl,
      // Whether COD is offered at all — a storefront needs this to decide
      // whether to show the option. The thresholds and the abuse controls
      // behind it stay private (§23.1).
      codEnabled: settings.codEnabled,
      bankTransferEnabled: settings.bankTransferEnabled,
    }
  },

  /**
   * The account an unpaid bank-transfer order should be paid into.
   *
   * Returns null when the method is off. The database CHECK guarantees that an
   * enabled method has a name, a bank and at least one of account number or
   * IBAN, so a caller that gets a value gets a usable one — there is no
   * half-filled panel to render around.
   */
  bankDetails(settings: StoreSettings): BankTransferDetails | null {
    if (!settings.bankTransferEnabled) return null
    return {
      accountName: settings.bankAccountName ?? '',
      bankName: settings.bankName ?? '',
      accountNumber: settings.bankAccountNumber,
      iban: settings.bankIban,
      swift: settings.bankSwift,
      instructions: settings.bankInstructions,
    }
  },

  /** Branding for the email layout, replacing the foundation's placeholder. */
  async getBranding(): Promise<{ storeName: string; supportEmail?: string }> {
    const settings = await this.get()
    return {
      storeName: settings.storeName,
      ...(settings.contactEmail ? { supportEmail: settings.contactEmail } : {}),
    }
  },

  invalidate(): void {
    cache.invalidate(CACHE_KEY)
  },
}
