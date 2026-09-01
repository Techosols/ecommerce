import type { RuleSet } from '@/components/rules'

/**
 * Collection shapes, mirrored from `server/src/features/catalogue/catalogue.mapper.ts`.
 *
 * The distinction that drives every screen here: a **manual** collection is a
 * list somebody arranged, and its order is editorial content; a **smart** one
 * is a question, and its membership is whatever the rules match at the moment
 * you ask. The UI must never let those two be edited the same way — adding a
 * product by hand to a smart collection is not a thing that can be true, and
 * the server refuses it in the service and again in the database.
 */

export type CollectionType = 'manual' | 'dynamic'

export interface Collection {
  id: string
  handle: string
  title: string
  description: string | null
  imageId: string | null
  type: CollectionType
  rules: RuleSet
  /** The rules in English. Present only on smart collections. */
  summary?: string
  position: number
  isActive: boolean
  isArchived: boolean
  seo: { title: string | null; description: string | null }
  createdAt: string
  updatedAt: string
}

export interface CollectionSummary extends Collection {
  /** Counted live for a smart collection; there is no stored number. */
  productCount: number
}

export interface CollectionDetail extends Collection {
  productIds: string[]
}

/** A collection as it appears on a product page. */
export interface ProductCollection extends Collection {
  /** True when the product is in it because the rules match, not by hand. */
  matchedByRules: boolean
}

export interface CollectionPreview {
  productCount: number
  summary: string
  /** Named, so the preview answers "did I mean these?" and not just "how many". */
  products: Array<{ id: string; title: string; handle: string }>
}

export interface CreateCollectionInput {
  title: string
  handle?: string
  description?: string | null
  imageId?: string | null
  type?: CollectionType
  rules?: RuleSet
  seoTitle?: string | null
  seoDescription?: string | null
  productIds?: string[]
}

export interface UpdateCollectionInput {
  title?: string
  handle?: string
  description?: string | null
  imageId?: string | null
  type?: CollectionType
  rules?: RuleSet
  position?: number
  isActive?: boolean
  seoTitle?: string | null
  seoDescription?: string | null
}

// ── Bulk product actions ────────────────────────────────────────────────────

export type BulkAction =
  | 'setStatus'
  | 'publish'
  | 'unpublish'
  | 'addTags'
  | 'removeTags'
  | 'addToCollection'
  | 'removeFromCollection'

export interface BulkActionInput {
  productIds: string[]
  action: BulkAction
  status?: 'draft' | 'active' | 'archived'
  channelKey?: string
  tags?: string[]
  collectionId?: string
}

/**
 * The outcome, per product.
 *
 * The server does not fail the batch when one product refuses the change — a
 * draft cannot be published — so the screen has to be able to say which ones
 * did not go through and why.
 */
export interface BulkActionResult {
  results: Array<{ productId: string; ok: boolean; error?: string }>
  succeeded: number
  failed: number
}
