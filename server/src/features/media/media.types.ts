export type MediaStatus = 'pending' | 'processing' | 'ready' | 'failed'

export interface MediaVariantInfo {
  key: string
  width: number
  height: number
  byteSize: number
}

export interface MediaAsset {
  id: string
  storageKey: string
  bucket: string
  status: MediaStatus
  declaredMime: string
  mimeType: string | null
  byteSize: number | null
  width: number | null
  height: number | null
  checksumSha256: string | null
  originalFilename: string | null
  alt: string | null
  variants: Record<string, MediaVariantInfo>
  failureReason: string | null
  uploadedBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateMediaAssetInput {
  id: string
  storageKey: string
  bucket: string
  declaredMime: string
  originalFilename: string | null
  alt: string | null
  uploadedBy: string | null
}

export interface MediaListFilter {
  status?: MediaStatus
  limit: number
  offset: number
}
