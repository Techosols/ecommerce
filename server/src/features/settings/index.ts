/**
 * Public surface of the `settings` feature (§2.2).
 *
 * Routes are mounted by `router.ts` directly, not re-exported here.
 */
export { settingsService } from './settings.service.js'
export { taxAddedTo, taxOn } from './tax.js'
export type { TaxBasis } from './tax.js'
export type {
  StoreSettings,
  StoreSettingsUpdate,
  PublicStoreSettings,
} from './settings.types.js'
