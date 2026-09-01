import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ChevronRight, PackageSearch } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { ProductCard } from '../components/ProductCard'
import { ProductGridSkeleton } from './ProductListPage'
import { useCategories, useCategory, useProducts } from '../hooks/catalogue.hooks'
import { findChildren } from '../categoryTree'

const PER_PAGE = 12

/**
 * One category, its children, and what is in it.
 *
 * Two requests rather than one, because they answer different questions and
 * change at different rates: the category itself (with the breadcrumb the
 * server assembles) is cached for minutes, while the products in it carry
 * live availability and are not.
 *
 * The child categories are read out of the cached tree rather than fetched:
 * `/storefront/categories/:handle` returns the node and its breadcrumb but not
 * its children, and the tree is already in hand.
 */
export function CategoryPage() {
  const { handle } = useParams()
  const [params, setParams] = useSearchParams()
  const page = Number(params.get('page') ?? '1')

  const category = useCategory(handle)
  const tree = useCategories()
  const products = useProducts({ page, limit: PER_PAGE, category: handle })

  const children = findChildren(tree.data ?? [], handle)

  function setPage(next) {
    const updated = new URLSearchParams(params)
    updated.set('page', String(next))
    setParams(updated)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="flex flex-col gap-8">
      <QueryBoundary
        isLoading={category.isPending}
        error={category.error}
        onRetry={() => void category.refetch()}
        fallback={<Skeleton className="h-16 w-2/3" />}
      >
        {category.data ? <CategoryHeader category={category.data} /> : null}
      </QueryBoundary>

      {children.length > 0 ? (
        <nav aria-label="Subcategories" className="flex flex-wrap gap-2">
          {children.map((child) => (
            <Link
              key={child.handle}
              to={`/categories/${child.handle}`}
              className="border-line bg-surface text-ink-soft hover:border-brand-300 hover:text-brand-700 rounded-full border px-3.5 py-1.5 text-sm transition-colors"
            >
              {child.name}
            </Link>
          ))}
        </nav>
      ) : null}

      <QueryBoundary
        isLoading={products.isPending}
        error={products.error}
        onRetry={() => void products.refetch()}
        fallback={<ProductGridSkeleton />}
      >
        {(products.data?.items ?? []).length === 0 ? (
          <EmptyState
            icon={<PackageSearch className="size-6" />}
            title="Nothing in here yet"
            description={
              children.length > 0
                ? 'Try one of the subcategories above.'
                : 'This category has no products at the moment.'
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {products.data.items.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
            <Pagination pagination={products.data?.pagination} onPageChange={setPage} />
          </>
        )}
      </QueryBoundary>
    </div>
  )
}

function CategoryHeader({ category }) {
  // The breadcrumb includes the category itself as its last entry, so the tail
  // is dropped rather than rendered as a link to the page you are on.
  const ancestors = (category.breadcrumb ?? []).slice(0, -1)

  return (
    <header className="flex flex-col gap-3">
      {ancestors.length > 0 ? (
        <nav aria-label="Breadcrumb" className="text-muted flex flex-wrap items-center gap-1 text-sm">
          <Link to="/products" className="hover:text-ink">
            Shop
          </Link>
          {ancestors.map((entry) => (
            <span key={entry.handle} className="flex items-center gap-1">
              <ChevronRight className="size-3.5" aria-hidden="true" />
              <Link to={`/categories/${entry.handle}`} className="hover:text-ink">
                {entry.name}
              </Link>
            </span>
          ))}
        </nav>
      ) : null}

      <h1 className="text-3xl sm:text-4xl">{category.name}</h1>
      {category.description ? (
        <p className="text-muted max-w-2xl text-lg">{category.description}</p>
      ) : null}
    </header>
  )
}
