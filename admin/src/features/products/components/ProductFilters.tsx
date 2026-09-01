import { FilterBar } from '@/components/ui/FilterBar'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { useCategoryTree } from '@/features/categories/hooks/categories.hooks'
import type { ProductStatus } from '../types/products.types'

export interface ProductFiltersValue {
  q: string
  status: ProductStatus | ''
  categoryId: string
}

export interface ProductFiltersProps {
  value: ProductFiltersValue
  onChange: (value: ProductFiltersValue) => void
  trailing?: React.ReactNode
}

/**
 * Search and the two filters the server actually supports.
 *
 * Status and category are the ones `adminProductListQuery` accepts, so they are
 * the ones offered. A vendor or tag filter would look plausible and quietly do
 * nothing, because the API has no parameter for either.
 *
 * The category options are indented by depth so a child reads as a child; the
 * value is still a flat id, which is what the endpoint takes.
 */
export function ProductFilters({ value, onChange, trailing }: ProductFiltersProps) {
  const { flat, isPending } = useCategoryTree()
  const isFiltered = value.q !== '' || value.status !== '' || value.categoryId !== ''

  function set(patch: Partial<ProductFiltersValue>) {
    onChange({ ...value, ...patch })
  }

  return (
    <FilterBar
      isFiltered={isFiltered}
      onClear={() => onChange({ q: '', status: '', categoryId: '' })}
      trailing={trailing}
      search={
        <SearchInput
          size="sm"
          aria-label="Search products"
          placeholder="Search by title or description…"
          value={value.q}
          onChange={(event) => set({ q: event.target.value })}
          onClear={() => set({ q: '' })}
        />
      }
      filters={
        <>
          <Select
            size="sm"
            aria-label="Filter by status"
            className="w-36"
            value={value.status}
            onChange={(event) => set({ status: event.target.value as ProductStatus | '' })}
            options={[
              { value: '', label: 'Any status' },
              { value: 'draft', label: 'Draft' },
              { value: 'active', label: 'Active' },
              { value: 'archived', label: 'Archived' },
            ]}
          />

          <Select
            size="sm"
            aria-label="Filter by category"
            className="w-48"
            disabled={isPending}
            value={value.categoryId}
            onChange={(event) => set({ categoryId: event.target.value })}
            options={[
              { value: '', label: 'Any category' },
              ...flat.map((category) => ({
                value: category.id,
                label: `${'  '.repeat(category.depth)}${category.name}`,
              })),
            ]}
          />
        </>
      }
    />
  )
}
