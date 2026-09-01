import { useState } from 'react'
import { Link, NavLink, Outlet, useSearchParams } from 'react-router-dom'
import { Menu, Search, ShoppingBag, User, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useStoreSettings } from '@/features/settings/useSettings'
import { useCollections } from '@/features/catalogue/hooks/catalogue.hooks'
import { cartCount, useCart } from '@/features/cart/hooks/cart.hooks'

/**
 * The frame every page sits in.
 *
 * The navigation is built from **collections**, not categories. The two answer
 * different questions: a category is where a product *files* — one each, in a
 * deep tree the merchant maintains, which with a seeded taxonomy runs to
 * thousands of mostly-empty nodes — while a collection is where products
 * *appear together*, because somebody decided they should. A shopfront wants
 * the second.
 */
export function Layout() {
  const settings = useStoreSettings()
  const [isMenuOpen, setIsMenuOpen] = useState(false)

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="bg-brand-600 sr-only rounded-md px-4 py-2 text-white focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50"
      >
        Skip to content
      </a>

      <Header
        storeName={settings?.storeName ?? 'Shop'}
        isMenuOpen={isMenuOpen}
        onToggleMenu={() => setIsMenuOpen((open) => !open)}
      />

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <Outlet />
      </main>

      <Footer storeName={settings?.storeName ?? 'Shop'} contactEmail={settings?.contactEmail} />
    </div>
  )
}

function Header({ storeName, isMenuOpen, onToggleMenu }) {
  const { data: collections } = useCollections()
  const { data: cart } = useCart()
  const items = cartCount(cart)
  const nav = (collections ?? []).slice(0, 5)

  return (
    <header className="border-line bg-surface/95 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        {/* Truncates rather than pushing the header wider: a long store name
            must not be the reason a phone scrolls sideways. */}
        <Link to="/" className="font-display text-ink min-w-0 truncate text-xl font-semibold">
          {storeName}
        </Link>

        <nav aria-label="Collections" className="ml-4 hidden items-center gap-1 md:flex">
          {nav.map((collection) => (
            <NavLink
              key={collection.handle}
              to={`/collections/${collection.handle}`}
              className={({ isActive }) =>
                cn(
                  'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive ? 'text-brand-700 bg-brand-50' : 'text-ink-soft hover:bg-sunken',
                )
              }
            >
              {collection.title}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <HeaderSearch />

          <Link
            to="/account/orders"
            aria-label="Your account"
            className="text-ink-soft hover:bg-sunken hidden rounded-md p-2 sm:inline-flex"
          >
            <User className="size-5" />
          </Link>

          {/* The count is the server's `itemCount`, never a length summed here:
              a basket line is a quantity, not one item. */}
          <Link
            to="/cart"
            aria-label={items > 0 ? `Basket, ${items} items` : 'Basket'}
            className="text-ink-soft hover:bg-sunken relative inline-flex rounded-md p-2"
          >
            <ShoppingBag className="size-5" />
            {items > 0 ? (
              <span className="bg-brand-600 tabular absolute -top-0.5 -right-0.5 flex size-4.5 items-center justify-center rounded-full text-[10px] font-semibold text-white">
                {items > 99 ? '99+' : items}
              </span>
            ) : null}
          </Link>

          <button
            type="button"
            onClick={onToggleMenu}
            aria-expanded={isMenuOpen}
            aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
            className="text-ink-soft hover:bg-sunken rounded-md p-2 md:hidden"
          >
            {isMenuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>

      {isMenuOpen ? (
        <nav aria-label="Collections" className="border-line border-t px-4 py-2 md:hidden">
          {nav.map((collection) => (
            <NavLink
              key={collection.handle}
              to={`/collections/${collection.handle}`}
              onClick={onToggleMenu}
              className="text-ink-soft hover:bg-sunken block rounded-md px-3 py-2 text-sm font-medium"
            >
              {collection.title}
            </NavLink>
          ))}
          <NavLink
            to="/account/orders"
            onClick={onToggleMenu}
            className="text-ink-soft hover:bg-sunken block rounded-md px-3 py-2 text-sm font-medium"
          >
            Your orders
          </NavLink>
        </nav>
      ) : null}
    </header>
  )
}

/**
 * Search, which navigates rather than filtering in place.
 *
 * The query lives in the URL because a search result is a page someone should
 * be able to link to, reload and come back to. Holding it in component state
 * would make the back button lie.
 */
function HeaderSearch() {
  const [params] = useSearchParams()
  const [term, setTerm] = useState(params.get('q') ?? '')

  return (
    <form action="/products" role="search" className="relative">
      <label htmlFor="site-search" className="sr-only">
        Search products
      </label>
      <Search
        className="text-faint pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
        aria-hidden="true"
      />
      <input
        id="site-search"
        name="q"
        type="search"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Search…"
        className="border-line bg-paper text-ink placeholder:text-faint focus:border-brand-500 h-9 w-28 rounded-lg border pr-2 pl-8 text-sm transition-[width,border-color] focus:outline-none sm:w-44 sm:focus:w-64"
      />
      {term ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => setTerm('')}
          className="text-faint hover:text-ink absolute top-1/2 right-2 -translate-y-1/2"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </form>
  )
}

function Footer({ storeName, contactEmail }) {
  return (
    <footer className="border-line bg-surface mt-16 border-t">
      <div className="text-muted mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-8 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          © {new Date().getFullYear()} {storeName}
        </p>
        <span className="flex flex-wrap items-center gap-4">
          <Link to="/orders/lookup" className="hover:text-ink">
            Track an order
          </Link>
          {contactEmail ? (
            <a href={`mailto:${contactEmail}`} className="text-brand-600 hover:underline">
              {contactEmail}
            </a>
          ) : null}
        </span>
      </div>
    </footer>
  )
}
