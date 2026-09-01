/**
 * Media (§23.4, §16.3).
 *
 * The upload flow, and why it has three steps:
 *
 * ```
 *  1. POST /admin/media/uploads
 *       server validates the *claim* (type, size), generates the key,
 *       writes a `pending` row, returns a short-lived signed upload URL
 *  2. client PUTs the bytes straight to object storage
 *       our API never carries them — and correspondingly has not seen them
 *  3. POST /admin/media/:id/complete
 *       server HEADs the object, downloads it, sniffs the real magic bytes,
 *       and only then hands it to the worker to re-encode
 * ```
 *
 * Step 3 exists because a signed upload URL is a promise about *where*, not
 * about *what*. Until the server has looked at the bytes the object is
 * untrusted input, which is why nothing may reference an asset before it
 * reaches `ready`.
 */
import { createHash } from 'node:crypto'
import { env } from '../../config/index.js'
import { publish } from '../../events/index.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { QUEUES, enqueue } from '../../infrastructure/queue/index.js'
import {
  generateMediaKey,
  getStorage,
  isAllowedImageType,
  prefixOf,
  sanitiseFilename,
  variantKey,
  VARIANT_SIZES,
  type MediaVariant,
} from '../../infrastructure/storage/index.js'
import { SNIFF_BYTES, sniffImageType } from '../../infrastructure/storage/sniff.js'
import type { Actor } from '../../shared/auth/actor.js'
import {
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/index.js'
import { auditService } from '../audit/index.js'
import { mediaRepository } from './media.repository.js'
import type { MediaAsset, MediaListFilter, MediaVariantInfo } from './media.types.js'

const log = createLogger('media.service')

export interface UploadTicket {
  assetId: string
  uploadUrl: string
  uploadToken: string | undefined
  method: 'PUT' | 'POST'
  expiresAt: Date
  storageKey: string
}

export const mediaService = {
  /**
   * Step 1. Validates what the client *says* it is about to upload and reserves
   * a key for it. Nothing here trusts the client beyond deciding whether to
   * bother issuing a URL at all.
   */
  async requestUpload(input: {
    filename?: string
    contentType: string
    byteSize: number
    alt?: string
    actor: Actor
  }): Promise<UploadTicket> {
    if (!isAllowedImageType(input.contentType)) {
      throw new DomainRuleError(
        ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
        `"${input.contentType}" is not an accepted image type`,
      )
    }
    if (input.byteSize <= 0 || input.byteSize > env.MEDIA_MAX_BYTES) {
      throw new DomainRuleError(
        ERROR_CODES.MEDIA_TOO_LARGE,
        `Files must be between 1 byte and ${env.MEDIA_MAX_BYTES} bytes`,
      )
    }

    const storage = getStorage()
    // The server generates the key. A client never chooses a bucket, a path or
    // a filename (§16.3).
    const { assetId, key } = generateMediaKey({ mimeType: input.contentType })

    const asset = await mediaRepository.create({
      id: assetId,
      storageKey: key,
      bucket: storage.bucket,
      declaredMime: input.contentType,
      originalFilename: sanitiseFilename(input.filename),
      alt: input.alt?.slice(0, 500) ?? null,
      uploadedBy: input.actor.userId,
    })

    const upload = await storage.createSignedUploadUrl(key, {
      contentType: input.contentType,
      expiresInSeconds: env.MEDIA_UPLOAD_URL_TTL_SECONDS,
    })

    log.debug({ assetId: asset.id, key, actorId: input.actor.userId }, 'upload ticket issued')

    return {
      assetId: asset.id,
      uploadUrl: upload.url,
      uploadToken: upload.token,
      method: upload.method,
      expiresAt: upload.expiresAt,
      storageKey: key,
    }
  },

  /**
   * Step 3. Inspects what actually arrived, then queues processing.
   *
   * Rejects here are terminal and recorded: an asset that fails inspection is
   * marked `failed` with a reason rather than retried, because retrying will
   * inspect the same bytes and reach the same conclusion.
   */
  async completeUpload(assetId: string, actor: Actor): Promise<MediaAsset> {
    const asset = await mediaRepository.findById(assetId)
    if (!asset) throw new NotFoundError('Media asset not found')

    // Idempotent: a duplicated call on an asset already past `pending` is a
    // no-op that returns current state.
    if (asset.status !== 'pending') {
      log.debug({ assetId, status: asset.status }, 'completeUpload on a non-pending asset')
      return asset
    }

    const storage = getStorage()

    const info = await storage.head(asset.storageKey)
    if (!info) {
      throw new DomainRuleError(
        ERROR_CODES.MEDIA_NOT_UPLOADED,
        'No object has been uploaded for this asset yet',
      )
    }
    if (info.byteSize === 0 || info.byteSize > env.MEDIA_MAX_BYTES) {
      await this.fail(assetId, `uploaded object is ${info.byteSize} bytes`)
      throw new DomainRuleError(
        ERROR_CODES.MEDIA_TOO_LARGE,
        'The uploaded file is empty or exceeds the size limit',
      )
    }

    // The declared type was a claim; the leading bytes are the fact.
    const bytes = await storage.download(asset.storageKey)
    const sniffed = sniffImageType(bytes.subarray(0, SNIFF_BYTES))

    if (!sniffed) {
      await this.fail(assetId, 'file content is not a recognised image format')
      throw new DomainRuleError(
        ERROR_CODES.MEDIA_REJECTED,
        'The uploaded file is not a recognised image',
      )
    }
    if (!isAllowedImageType(sniffed)) {
      await this.fail(assetId, `content is ${sniffed}, which is not accepted`)
      throw new DomainRuleError(ERROR_CODES.MEDIA_REJECTED, 'That image format is not accepted')
    }
    if (sniffed !== asset.declaredMime) {
      // Not necessarily an attack — browsers mislabel files — but the real type
      // is what we record and re-encode from.
      log.warn(
        { assetId, declared: asset.declaredMime, actual: sniffed },
        'uploaded content type does not match the declared type',
      )
    }

    const claimed = await mediaRepository.claimForProcessing(assetId)
    if (!claimed) {
      const current = await mediaRepository.findById(assetId)
      return current ?? asset
    }

    await enqueue(QUEUES.MEDIA_PROCESS_IMAGE, { mediaAssetId: assetId })
    await publish(
      'media.uploaded',
      { mediaAssetId: assetId, mimeType: sniffed, byteSize: info.byteSize },
      { aggregateId: assetId, actorUserId: actor.userId },
    )

    log.info({ assetId, mimeType: sniffed, byteSize: info.byteSize }, 'upload accepted for processing')

    const updated = await mediaRepository.findById(assetId)
    return updated ?? asset
  },

  async fail(assetId: string, reason: string): Promise<void> {
    await mediaRepository.markFailed(assetId, reason)
    await publish('media.failed', { mediaAssetId: assetId, reason }, { aggregateId: assetId })
    log.warn({ assetId, reason }, 'media asset rejected')
  },

  async getById(id: string): Promise<MediaAsset | undefined> {
    return mediaRepository.findById(id)
  },

  async list(filter: MediaListFilter) {
    return mediaRepository.list(filter)
  },

  async updateAlt(id: string, alt: string | null, actor: Actor): Promise<MediaAsset> {
    const asset = await mediaRepository.findById(id)
    if (!asset) throw new NotFoundError('Media asset not found')

    await withTransaction(async () => {
      await mediaRepository.setAlt(id, alt)
      await auditService.record({
        actor,
        action: 'media.updated',
        resourceType: 'media_asset',
        resourceId: id,
        before: { alt: asset.alt },
        after: { alt },
      })
    })

    const updated = await mediaRepository.findById(id)
    if (!updated) throw new NotFoundError('Media asset not found')
    return updated
  },

  /**
   * Deletes the row and every object under the asset's prefix.
   *
   * Storage is removed *after* the row commits: an orphaned object costs
   * pennies and is swept later, whereas a row pointing at a deleted object is a
   * broken image on a product page.
   */
  async delete(id: string, actor: Actor): Promise<void> {
    const asset = await mediaRepository.findById(id)
    if (!asset) throw new NotFoundError('Media asset not found')

    await withTransaction(async () => {
      await mediaRepository.remove(id)
      await auditService.record({
        actor,
        action: 'media.deleted',
        resourceType: 'media_asset',
        resourceId: id,
        before: { storageKey: asset.storageKey, originalFilename: asset.originalFilename },
      })
      await publish(
        'media.deleted',
        { mediaAssetId: id, storageKey: asset.storageKey },
        { aggregateId: id, actorUserId: actor.userId },
      )
    })

    await this.removeObjects(asset)
    log.info({ assetId: id, actorId: actor.userId }, 'media asset deleted')
  },

  /** Best-effort object removal. A failure here leaves a sweepable orphan. */
  async removeObjects(asset: MediaAsset): Promise<void> {
    const keys = [asset.storageKey, ...Object.values(asset.variants).map((v) => v.key)]
    try {
      await getStorage().remove(keys)
    } catch (error) {
      log.error({ err: error, assetId: asset.id, keys }, 'failed to remove storage objects')
    }
  },

  /**
   * Readable URLs for an asset. On a public bucket these are stable and
   * CDN-cacheable; on a private one they are signed and expire.
   */
  async urlsFor(asset: MediaAsset): Promise<{ url: string; variants: Record<string, string> }> {
    const storage = getStorage()
    const url = await storage.getUrl(asset.storageKey)

    const variants: Record<string, string> = {}
    for (const [name, info] of Object.entries(asset.variants)) {
      variants[name] = await storage.getUrl(info.key)
    }
    return { url, variants }
  },

  /** Convenience for callers that hold only an id, e.g. the store logo. */
  async urlForId(id: string | null): Promise<string | null> {
    if (!id) return null
    const asset = await mediaRepository.findById(id)
    if (!asset || asset.status !== 'ready') return null
    return getStorage().getUrl(asset.storageKey)
  },

  // ── Used by the processing worker ─────────────────────────────────────────

  variantPlan(storageKey: string): { variant: MediaVariant; key: string; size: number }[] {
    const prefix = prefixOf(storageKey)
    return (Object.keys(VARIANT_SIZES) as MediaVariant[]).map((variant) => ({
      variant,
      key: variantKey(prefix, variant),
      size: VARIANT_SIZES[variant],
    }))
  },

  async markReady(
    assetId: string,
    details: {
      mimeType: string
      byteSize: number
      width: number
      height: number
      checksum: string
      variants: Record<string, MediaVariantInfo>
    },
  ): Promise<boolean> {
    const changed = await mediaRepository.markReady(assetId, details)
    if (changed) {
      await publish(
        'media.ready',
        { mediaAssetId: assetId, width: details.width, height: details.height },
        { aggregateId: assetId },
      )
    }
    return changed
  },

  checksum(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex')
  },

  async findAbandoned(olderThanHours: number, limit: number) {
    return mediaRepository.findAbandoned(olderThanHours, limit)
  },

  async purgeAbandoned(asset: MediaAsset): Promise<void> {
    await this.removeObjects(asset)
    await mediaRepository.remove(asset.id)
  },

  assertReady(asset: MediaAsset): void {
    if (asset.status !== 'ready') {
      throw new ValidationError('That media asset is not ready to be used yet')
    }
  },
}
