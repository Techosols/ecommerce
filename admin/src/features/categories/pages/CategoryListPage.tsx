import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CornerDownRight, FolderTree, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { DropdownItem, DropdownMenu } from '@/components/ui/DropdownMenu'
import { FilterBar } from '@/components/ui/FilterBar'
import { PageHeader } from '@/components/ui/PageHeader'
import { SearchInput } from '@/components/ui/SearchInput'
import { DataTable, type Column } from '@/components/ui/Table'
import { useToast } from '@/components/ui/toast.context'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { RequirePermission } from '@/features/auth/RequirePermission'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { isApiError, messageOf } from '@/lib/api/errors'
import { formatDate } from '@/lib/format'
import { CategoryFormModal } from '../components/CategoryFormModal'
import { useArchiveCategory, useCategoryTree } from '../hooks/categories.hooks'
import type { Category, CategoryNode } from '../types/categories.types'

/**
 * Categories, as the tree they are.
 *
 * `GET /admin/categories` returns every category in one flat array with no
 * pagination and no search parameter, so both happen here — over a list that
 * was going to be fetched in full anyway, because a tree cannot be assembled
 * from a page of it. Searching keeps a matching row's ancestors visible, since
 * a child shown without its parent stops being a tree.
 *
 * Archiving is `DELETE`, and the server refuses it while products or child
 * categories still point at the category. That refusal is surfaced as it comes
 * back rather than guessed at, because the admin has no product count to check
 * against — see the note in the phase summary.
 */
export function CategoryListPage() {
  const navigate = useNavigate()
  const { toast } = useToast()
  const { can } = useAuth()
  const query = useCategoryTree()
  const archive = useArchiveCategory()
  useDocumentTitle('Categories')

  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Category | null>(null)
  const [creatingUnder, setCreatingUnder] = useState<string | null | undefined>(undefined)
  const [archiving, setArchiving] = useState<CategoryNode | null>(null)

  const canWrite = can('catalog:write')
  const isFormOpen = editing !== null || creatingUnder !== undefined

  const rows = useMemo(() => {
    if (!search.trim()) return query.flat

    const needle = search.trim().toLowerCase()
    const matches = new Set(
      query.flat
        .filter((node) => node.name.toLowerCase().includes(needle) || node.handle.includes(needle))
        .map((node) => node.id),
    )

    // Keep the ancestors of every match, so the hierarchy still reads correctly.
    const keep = new Set(matches)
    for (const node of query.flat) {
      if (!matches.has(node.id)) continue
      let parentId = node.parentId
      while (parentId) {
        keep.add(parentId)
        parentId = query.byId.get(parentId)?.parentId ?? null
      }
    }
    return query.flat.filter((node) => keep.has(node.id))
  }, [query.flat, query.byId, search])

  const columns = useMemo<Array<Column<CategoryNode>>>(
    () => [
      {
        id: 'name',
        header: 'Category',
        cell: (row) => (
          <div
            className="flex min-w-0 items-center gap-1.5"
            style={{ paddingLeft: row.depth * 20 }}
          >
            {row.depth > 0 ? (
              <CornerDownRight aria-hidden="true" className="text-faint size-3.5 shrink-0" />
            ) : null}
            <div className="min-w-0">
              <span className="text-ink block truncate font-medium">{row.name}</span>
              <span className="text-faint block truncate font-mono text-xs">/{row.handle}</span>
            </div>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        width: '9rem',
        cell: (row) =>
          row.isArchived ? (
            <Badge tone="warning" dot>
              Archived
            </Badge>
          ) : row.isActive ? (
            <Badge tone="positive" dot>
              Visible
            </Badge>
          ) : (
            <Badge tone="neutral" dot>
              Hidden
            </Badge>
          ),
      },
      {
        id: 'children',
        header: 'Sub-categories',
        align: 'right',
        hideBelow: 'md',
        cell: (row) =>
          row.children.length > 0 ? row.children.length : <span className="text-faint">—</span>,
      },
      {
        id: 'position',
        header: 'Position',
        align: 'right',
        hideBelow: 'lg',
        cell: (row) => row.position,
      },
      {
        id: 'updated',
        header: 'Updated',
        align: 'right',
        hideBelow: 'lg',
        cell: (row) => <span className="text-muted text-xs">{formatDate(row.updatedAt)}</span>,
      },
      {
        id: 'actions',
        header: '',
        width: '3rem',
        cell: (row) =>
          canWrite ? (
            <DropdownMenu
              width="w-52"
              trigger={({ ref, ...props }) => (
                <button
                  ref={ref}
                  type="button"
                  aria-label={`Actions for ${row.name}`}
                  {...props}
                  className="text-muted hover:bg-surface-hover hover:text-ink flex size-8 items-center justify-center rounded-md transition-colors"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              )}
            >
              <DropdownItem icon={<Pencil className="size-4" />} onSelect={() => setEditing(row)}>
                Edit
              </DropdownItem>
              <DropdownItem
                icon={<Plus className="size-4" />}
                onSelect={() => setCreatingUnder(row.id)}
              >
                Add a sub-category
              </DropdownItem>
              <DropdownItem
                tone="danger"
                icon={<Trash2 className="size-4" />}
                onSelect={() => setArchiving(row)}
              >
                Archive
              </DropdownItem>
            </DropdownMenu>
          ) : null,
      },
    ],
    [canWrite],
  )

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Categories"
        description="A product belongs to exactly one category."
        actions={
          <RequirePermission permission="catalog:write">
            <Button
              variant="primary"
              leadingIcon={<Plus className="size-4" />}
              onClick={() => setCreatingUnder(null)}
            >
              Add category
            </Button>
          </RequirePermission>
        }
      />

      <Card>
        <div className="border-line border-b px-4 py-3 sm:px-5">
          <FilterBar
            isFiltered={search !== ''}
            onClear={() => setSearch('')}
            search={
              <SearchInput
                size="sm"
                aria-label="Search categories"
                placeholder="Search by name or handle…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onClear={() => setSearch('')}
              />
            }
            trailing={
              query.data ? (
                <span className="text-muted text-xs">
                  {query.data.length} {query.data.length === 1 ? 'category' : 'categories'}
                </span>
              ) : null
            }
          />
        </div>

        <QueryBoundary
          isLoading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
        >
          <DataTable
            columns={columns}
            rows={rows}
            getRowId={(row) => row.id}
            caption="Categories"
            onRowClick={(row) => void navigate(`/products?categoryId=${row.id}`)}
            emptyState={
              search ? (
                <EmptyState
                  icon={<FolderTree className="size-5" />}
                  title="No categories match that search"
                  actions={
                    <Button variant="secondary" onClick={() => setSearch('')}>
                      Clear search
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<FolderTree className="size-5" />}
                  title="No categories yet"
                  description="Categories group products for customers browsing the storefront."
                  actions={
                    <RequirePermission permission="catalog:write">
                      <Button variant="primary" onClick={() => setCreatingUnder(null)}>
                        New category
                      </Button>
                    </RequirePermission>
                  }
                />
              )
            }
          />
        </QueryBoundary>
      </Card>

      <CategoryFormModal
        isOpen={isFormOpen}
        category={editing}
        defaultParentId={creatingUnder ?? null}
        onClose={() => {
          setEditing(null)
          setCreatingUnder(undefined)
        }}
      />

      <ConfirmDialog
        isOpen={archiving !== null}
        onCancel={() => setArchiving(null)}
        onConfirm={() => {
          if (!archiving) return
          archive.mutate(archiving.id, {
            onSuccess: () => {
              toast({ tone: 'success', title: `${archiving.name} archived` })
              setArchiving(null)
            },
            onError: (error) => {
              // CATEGORY_IN_USE is the expected refusal, not a fault: the
              // server will not silently re-classify the products inside.
              const inUse = isApiError(error) && error.code === 'CATEGORY_IN_USE'
              toast({
                tone: inUse ? 'warning' : 'error',
                title: inUse ? 'That category is still in use' : 'Could not archive the category',
                description: messageOf(error),
              })
              setArchiving(null)
            },
          })
        }}
        title={`Archive “${archiving?.name ?? ''}”?`}
        confirmLabel="Archive category"
        tone="danger"
        isLoading={archive.isPending}
      >
        The server refuses this while any product or sub-category still points at it — move those
        first. Nothing is deleted either way.
      </ConfirmDialog>
    </div>
  )
}
