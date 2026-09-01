/**
 * Mirrors `adminCategoryDto` and the category validators.
 *
 * Categories are a **tree**: `parentId` is real, the server refuses a move that
 * would put a category inside its own subtree, and it caps depth. A product
 * belongs to exactly one category — there is no junction table, which the
 * server's own test asserts — so the UI offers a single picker, never a
 * multi-select.
 */
export interface Category {
  id: string
  parentId: string | null
  name: string
  handle: string
  description: string | null
  imageId: string | null
  position: number
  isActive: boolean
  isArchived: boolean
  createdAt: string
  updatedAt: string
}

/** A category with its children resolved, built in the browser from the flat list. */
export interface CategoryNode extends Category {
  children: CategoryNode[]
  depth: number
}

export interface CreateCategoryInput {
  name: string
  handle?: string
  parentId?: string | null
  description?: string | null
  imageId?: string | null
  position?: number
}

export interface UpdateCategoryInput {
  name?: string
  handle?: string
  parentId?: string | null
  description?: string | null
  imageId?: string | null
  position?: number
  /** Hides a category without archiving it — the reversible half of retirement. */
  isActive?: boolean
}
