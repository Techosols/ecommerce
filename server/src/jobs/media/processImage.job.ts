/**
 * `media.process_image` (§8.1).
 *
 * The step that turns an uploaded object into something safe to serve.
 *
 * **Re-encoding is the security control, not a nicety.** Decoding the bytes and
 * writing fresh ones with sharp destroys anything that was not actually image
 * data: EXIF payloads, appended archives, polyglot files that are simultaneously
 * a valid GIF and a valid HTML page. The original is replaced, not kept
 * alongside, because a "pristine original" is exactly the file an attacker
 * wants left on the disk.
 *
 * Idempotent: it claims the asset with a compare-and-swap and a redelivered job
 * finds it already `ready` and stops.
 */
import sharp from 'sharp'
import type { Metadata, Sharp } from 'sharp'
import { env } from '../../config/index.js'
import { mediaService } from '../../features/media/index.js'
import { getStorage } from '../../infrastructure/storage/index.js'
import { SNIFF_BYTES, sniffImageType } from '../../infrastructure/storage/sniff.js'
import { extensionFor } from '../../infrastructure/storage/keys.js'
import type { JobContext } from '../../infrastructure/queue/index.js'
import type { MediaVariantInfo } from '../../features/media/index.js'

/** Refuse absurd dimensions: a 60000×60000 PNG is a decompression bomb. */
const MAX_DIMENSION = 12_000
const MAX_PIXELS = 50_000_000

export async function processImageHandler(
  payload: { mediaAssetId: string },
  ctx: JobContext,
): Promise<void> {
  const asset = await mediaService.getById(payload.mediaAssetId)

  if (!asset) {
    ctx.logger.warn({ mediaAssetId: payload.mediaAssetId }, 'media asset missing; nothing to do')
    return
  }
  if (asset.status !== 'processing') {
    ctx.logger.debug({ mediaAssetId: asset.id, status: asset.status }, 'asset already handled')
    return
  }

  const storage = getStorage()
  const original = await storage.download(asset.storageKey)

  // Sniff again. The worker may run minutes after the upload was accepted, and
  // it must not trust a decision made against bytes it has not seen.
  const sniffed = sniffImageType(original.subarray(0, SNIFF_BYTES))
  if (!sniffed) {
    await mediaService.fail(asset.id, 'content is not a recognised image format')
    return
  }

  let metadata: Metadata
  try {
    metadata = await sharp(original, { failOn: 'error' }).metadata()
  } catch (error) {
    await mediaService.fail(asset.id, 'image could not be decoded')
    ctx.logger.warn({ err: error, mediaAssetId: asset.id }, 'sharp could not decode the upload')
    return
  }

  const width = metadata.width ?? 0
  const height = metadata.height ?? 0

  if (width <= 0 || height <= 0) {
    await mediaService.fail(asset.id, 'image has no usable dimensions')
    return
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    await mediaService.fail(asset.id, `image is too large to process (${width}×${height})`)
    return
  }

  // `.rotate()` with no argument applies the EXIF orientation and then drops
  // the metadata, so the stored image is upright and carries no GPS or camera
  // data (§16.3).
  const pipeline = sharp(original, { failOn: 'error' }).rotate()

  const reencoded = await encodeAs(pipeline.clone(), sniffed)
  if (reencoded.byteLength > env.MEDIA_MAX_BYTES) {
    await mediaService.fail(asset.id, 're-encoded image exceeds the size limit')
    return
  }

  await storage.put({
    key: asset.storageKey,
    body: reencoded,
    contentType: sniffed,
    upsert: true,
    cacheSeconds: 31_536_000,
  })

  // Derivatives are WebP: one format, good compression, universally supported.
  const variants: Record<string, MediaVariantInfo> = {}
  for (const plan of mediaService.variantPlan(asset.storageKey)) {
    // Never upscale — a 100px logo does not become a better 1600px logo.
    if (plan.size > Math.max(width, height) && plan.variant !== 'thumb') continue

    const body = await sharp(reencoded)
      .resize({ width: plan.size, height: plan.size, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true })

    await storage.put({
      key: plan.key,
      body: body.data,
      contentType: 'image/webp',
      upsert: true,
      cacheSeconds: 31_536_000,
    })

    variants[plan.variant] = {
      key: plan.key,
      width: body.info.width,
      height: body.info.height,
      byteSize: body.data.byteLength,
    }
  }

  const marked = await mediaService.markReady(asset.id, {
    mimeType: sniffed,
    byteSize: reencoded.byteLength,
    width,
    height,
    checksum: mediaService.checksum(reencoded),
    variants,
  })

  ctx.logger.info(
    {
      mediaAssetId: asset.id,
      mimeType: sniffed,
      extension: extensionFor(sniffed),
      width,
      height,
      variants: Object.keys(variants),
      bytes: reencoded.byteLength,
      marked,
    },
    'image processed',
  )
}

/** Re-encodes in the format the bytes actually are, at a sensible quality. */
async function encodeAs(pipeline: Sharp, mime: string): Promise<Buffer> {
  switch (mime) {
    case 'image/jpeg':
      return pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer()
    case 'image/png':
      return pipeline.png({ compressionLevel: 9 }).toBuffer()
    case 'image/webp':
      return pipeline.webp({ quality: 85 }).toBuffer()
    case 'image/avif':
      return pipeline.avif({ quality: 60 }).toBuffer()
    case 'image/gif':
      // Animated GIFs would lose their frames through a still pipeline, so they
      // are re-encoded as GIF with animation preserved.
      return sharp(await pipeline.toBuffer(), { animated: true }).gif().toBuffer()
    default:
      return pipeline.jpeg({ quality: 85 }).toBuffer()
  }
}
