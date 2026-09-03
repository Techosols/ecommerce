import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ChevronRight, PackageSearch } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { ProductCard } from '../components/ProductCard'
import { ProductGridSkeleton } from './ProductListPage'
import { EVENTS } from '@/lib/analytics'
import { useTrackOnce } from '@/lib/useTrack'
import { useCategories, useCategory, useProducts } from '../hooks/catalogue.hooks'
import { findCategory } from '../categoryTree'

const PER_PAGE = 12

/**
 * One category, its products, and the way further down.
 *
 * ── Why a category page is not just a collection page ────────────────────────
 *
 * A category is a node in a tree the merchant maintains, and a shopper standing
 * on one needs two things a flat listing does not give them: where they are,
 * and where they can go next. So this page carries the breadcrumb the server
 * builds — the trail back to the root — and the category's own children as
 * links, which is what makes a deep taxonomy walkable a level at a time instead
 * of collapsing into a menu with a thousand entries.
 *
 * ── Two requests, on purpose ─────────────────────────────────────────────────
 *
 * The category and its products change at completely different rates. The
 * category is the merchant's structure and is cached for ten minutes; the
 * products carry live availability and are not cached at all, because somebody
 * looking at a size that has just sold out should find that out here.
 *
 * The children come from the tree rather than from the detail response, which
 * returns the node without them. One tree fetch is shared with the header
 * navigation, so walking down three levels costs no extra requests.
 */
export function CategoryPage() {
  const { handle } = useParams()
  const [params, setParams] = useSearchParams()
  const page = Number(params.get('page') ?? '1')

  const category = useCategory(handle)
  const tree = useCategories()
  const products = useProducts({ page, limit: PER_PAGE, category: handle })

  // The server's vocabulary has no `category_viewed`, and inventing one would
  // be a 422. A category page is a collection of products being browsed, which
  // is what this event means — the properties say which kind it was.
  useTrackOnce(EVENTS.COLLECTION_VIEWED, category.data ? handle : null, {
    kind: 'category',
    handle,
    name: category.data?.name,
  })

  const node = tree.data ? findCategory(tree.data, handle) : null
  const children = node?.children ?? []

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
        {category.data ? (
          <header className="flex flex-col gap-3">
            <Breadcrumb trail={category.data.breadcrumb ?? []} />
            <h1 className="text-3xl sm:text-4xl">{category.data.name}</h1>
            {category.data.description ? (
              // HTML from the admin's rich text editor. Sanitised server side
              // against a fixed allowlist on the way in, which is what makes
              // rendering it here safe.
              <div
                className="rte-content text-muted max-w-2xl text-lg"
                dangerouslySetInnerHTML={{ __html: category.data.description }}
              />
            ) : null}
          </header>
        ) : null}
      </QueryBoundary>

      {children.length > 0 ? (
        <nav aria-label="Categories within this one" className="flex flex-wrap gap-2">
          {children.map((child) => (
            <Link
              key={child.handle}
              to={`/categories/${child.handle}`}
              className="border-line bg-surface text-ink hover:border-brand-300 hover:text-brand-700 rounded-full border px-3.5 py-1.5 text-sm transition-colors"
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
        {products.data?.items.length === 0 ? (
          <EmptyState
            icon={<PackageSearch className="size-6" />}
            title="Nothing here yet"
            description={
              children.length > 0
                ? 'This part of the shop is organised into the groups above — try one of those.'
                : 'Nothing is filed under this category at the moment. Have a look at the rest of the shop.'
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
              {products.data?.items.map((product) => (
                <ProductCard key={product.handle} product={product} />
              ))}
            </div>

            {products.data?.pagination ? (
              <Pagination pagination={products.data.pagination} onChange={setPage} />
            ) : null}
          </>
        )}
      </QueryBoundary>
    </div>
  )
}

/**
 * The trail back to the root.
 *
 * The last entry is where you are, so it is text rather than a link — a
 * breadcrumb whose final crumb navigates to the page you are on is a control
 * that appears to do something and does nothing.
 */
function Breadcrumb({ trail }) {
  if (trail.length <= 1) return null

  return (
    <nav aria-label="Breadcrumb">
      <ol className="text-muted flex flex-wrap items-center gap-1 text-sm">
        <li>
          <Link to="/products" className="hover:text-ink">
            Shop
          </Link>
        </li>
        {trail.map((entry, index) => {
          const last = index === trail.length - 1
          return (
            <li key={entry.handle} className="flex items-center gap-1">
              <ChevronRight className="text-faint size-3.5" aria-hidden="true" />
              {last ? (
                <span aria-current="page" className="text-ink">
                  {entry.name}
                </span>
              ) : (
                <Link to={`/categories/${entry.handle}`} className="hover:text-ink">
                  {entry.name}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
