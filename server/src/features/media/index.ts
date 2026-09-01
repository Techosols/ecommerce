/**
 * Public surface of the `media` feature (§2.2).
 *
 * Routes are mounted by `router.ts` directly, not re-exported here.
 */
export { mediaService } from './media.service.js'
export type { UploadTicket } from './media.service.js'
export type {
  MediaAsset,
  MediaStatus,
  MediaVariantInfo,
  MediaListFilter,
} from './media.types.js'
