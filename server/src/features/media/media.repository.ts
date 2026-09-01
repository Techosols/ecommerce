/**
 * Media data access (§1.2). SQL only.
 *
 * Status transitions are compare-and-swap updates, so a redelivered job or a
 * duplicated `complete` call cannot move an asset backwards or process it twice
 * (§8.3).
 */
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import type {
  CreateMediaAssetInput,
  MediaAsset,
  MediaListFilter,
  MediaStatus,
  MediaVariantInfo,
} from './media.types.js'

interface MediaRow {
  id: string
  storage_key: string
  bucket: string
  status: MediaStatus
  declared_mime: string
  mime_type: string | null
  byte_size: number | null
  width: number | null
  height: number | null
  checksum_sha256: string | null
  original_filename: string | null
  alt: string | null
  variants: Record<string, MediaVariantInfo>
  failure_reason: string | null
  uploaded_by: string | null
  created_at: Date
  updated_at: Date
}

function toAsset(row: MediaRow): MediaAsset {
  return {
    id: row.id,
    storageKey: row.storage_key,
    bucket: row.bucket,
    status: row.status,
    declaredMime: row.declared_mime,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    checksumSha256: row.checksum_sha256,
    originalFilename: row.original_filename,
    alt: row.alt,
    variants: row.variants ?? {},
    failureReason: row.failure_reason,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const mediaRepository = {
  async create(input: CreateMediaAssetInput): Promise<MediaAsset> {
    const row = await queryOne<MediaRow>(
      `INSERT INTO media_assets
         (id, storage_key, bucket, declared_mime, original_filename, alt, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.id,
        input.storageKey,
        input.bucket,
        input.declaredMime,
        input.originalFilename,
        input.alt,
        input.uploadedBy,
      ],
      { name: 'media.create' },
    )
    if (!row) throw new Error('Failed to create media asset')
    return toAsset(row)
  },

  async findById(id: string): Promise<MediaAsset | undefined> {
    const row = await queryOne<MediaRow>(`SELECT * FROM media_assets WHERE id = $1`, [id], {
      name: 'media.findById',
    })
    return row ? toAsset(row) : undefined
  },

  /**
   * Claims a pending asset for inspection. Zero rows means somebody already
   * completed it — which the service reads as "already done", not an error.
   */
  async claimForProcessing(id: string): Promise<boolean> {
    const affected = await execute(
      `UPDATE media_assets SET status = 'processing'
        WHERE id = $1 AND status = 'pending'`,
      [id],
      { name: 'media.claimForProcessing' },
    )
    return affected === 1
  },

  async markReady(
    id: string,
    details: {
      mimeType: string
      byteSize: number
      width: number
      height: number
      checksum: string
      variants: Record<string, MediaVariantInfo>
    },
  ): Promise<boolean> {
    const affected = await execute(
      `UPDATE media_assets
          SET status = 'ready', mime_type = $2, byte_size = $3, width = $4, height = $5,
              checksum_sha256 = $6, variants = $7, failure_reason = NULL
        WHERE id = $1 AND status = 'processing'`,
      [
        id,
        details.mimeType,
        details.byteSize,
        details.width,
        details.height,
        details.checksum,
        JSON.stringify(details.variants),
      ],
      { name: 'media.markReady' },
    )
    return affected === 1
  },

  async markFailed(id: string, reason: string): Promise<void> {
    await execute(
      `UPDATE media_assets
          SET status = 'failed', failure_reason = $2
        WHERE id = $1 AND status <> 'ready'`,
      [id, reason.slice(0, 500)],
      { name: 'media.markFailed' },
    )
  },

  async setAlt(id: string, alt: string | null): Promise<void> {
    await execute(`UPDATE media_assets SET alt = $2 WHERE id = $1`, [id, alt], {
      name: 'media.setAlt',
    })
  },

  async remove(id: string): Promise<void> {
    await execute(`DELETE FROM media_assets WHERE id = $1`, [id], { name: 'media.remove' })
  },

  async list(filter: MediaListFilter): Promise<{ rows: MediaAsset[]; total: number }> {
    const where = filter.status ? `WHERE status = $3` : ''
    const params: unknown[] = filter.status
      ? [filter.limit, filter.offset, filter.status]
      : [filter.limit, filter.offset]

    const rows = await query<MediaRow>(
      `SELECT * FROM media_assets ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $1 OFFSET $2`,
      params,
      { name: 'media.list' },
    )

    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM media_assets ${filter.status ? 'WHERE status = $1' : ''}`,
      filter.status ? [filter.status] : [],
      { name: 'media.count' },
    )

    return { rows: rows.map(toAsset), total: totalRow?.count ?? 0 }
  },

  /** Uploads that were requested but never completed. Swept by a daily job. */
  async findAbandoned(olderThanHours: number, limit: number): Promise<MediaAsset[]> {
    const rows = await query<MediaRow>(
      `SELECT * FROM media_assets
        WHERE status = 'pending'
          AND created_at < now() - ($1 || ' hours')::interval
        ORDER BY created_at
        LIMIT $2`,
      [olderThanHours, limit],
      { name: 'media.findAbandoned' },
    )
    return rows.map(toAsset)
  },
}
