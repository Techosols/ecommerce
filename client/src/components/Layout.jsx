import { useState } from 'react'
import { Link, NavLink, Outlet, useSearchParams } from 'react-router-dom'
import { ChevronDown, Menu, Search, ShoppingBag, User, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useStoreSettings } from '@/features/settings/useSettings'
import { useCategories, useCollections } from '@/features/catalogue/hooks/catalogue.hooks'
import { cartCount, useCart } from '@/features/cart/hooks/cart.hooks'

/**
 * The frame every page sits in.
 *
 * ── Two ways to browse, in order of prominence ───────────────────────────────
 *
 * The main navigation is **collections**: a collection is where products appear
 * together because somebody decided they should, which is what a shopper
 * arriving cold wants. **Categories** sit behind one menu beside them — the
 * merchant's taxonomy, where every product files exactly once. With a seeded
 * taxonomy that tree runs to thousands of mostly-empty nodes, so only the top
 * level is a menu; each category page then offers its own children, and the
 * tree is walked a level at a time rather than flattened into the header.
 *
 * ── What the shop shows is what the admin set ────────────────────────────────
 *
 * The name, the logo, the contact address and the support link all come from
 * store settings. Nothing here is hard-coded, and nothing is invented when a
 * setting is empty: an absent logo means the name is the wordmark, an absent
 * support URL means that link is not offered at all.
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
        settings={settings}
        isMenuOpen={isMenuOpen}
        onToggleMenu={() => setIsMenuOpen((open) => !open)}
      />

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <Outlet />
      </main>

      <Footer settings={settings} />
    </div>
  )
}

function Header({ settings, isMenuOpen, onToggleMenu }) {
  const storeName = settings?.storeName ?? 'Shop'
  const { data: collections } = useCollections()
  const { data: categories } = useCategories()
  const { data: cart } = useCart()
  const items = cartCount(cart)
  const nav = (collections ?? []).slice(0, 5)
  const topCategories = categories ?? []

  return (
    <header className="border-line bg-surface/95 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        {/* The shop's own logo when it has uploaded one. `alt` is the store
            name, not "logo": a screen reader announcing the wordmark should
            hear what the others read. */}
        <Link to="/" className="flex min-w-0 items-center gap-2">
          {settings?.logoUrl ? (
            <img
              src={settings.logoUrl}
              alt={storeName}
              className="h-8 w-auto max-w-[10rem] object-contain"
            />
          ) : (
            // Truncates rather than pushing the header wider: a long store
            // name must not be the reason a phone scrolls sideways.
            <span className="font-display text-ink truncate text-xl font-semibold">
              {storeName}
            </span>
          )}
        </Link>

        <nav aria-label="Main" className="ml-4 hidden items-center gap-1 md:flex">
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

          {topCategories.length > 0 ? <CategoryMenu categories={topCategories} /> : null}
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
        <nav aria-label="Main" className="border-line border-t px-4 py-2 md:hidden">
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

          {topCategories.length > 0 ? (
            <>
              <p className="text-faint px-3 pt-3 pb-1 text-xs font-semibold tracking-wide uppercase">
                Shop by category
              </p>
              {topCategories.map((category) => (
                <NavLink
                  key={category.handle}
                  to={`/categories/${category.handle}`}
                  onClick={onToggleMenu}
                  className="text-ink-soft hover:bg-sunken block rounded-md px-3 py-2 text-sm font-medium"
                >
                  {category.name}
                </NavLink>
              ))}
            </>
          ) : null}

          <NavLink
            to="/account/orders"
            onClick={onToggleMenu}
            className="border-line text-ink-soft hover:bg-sunken mt-2 block border-t px-3 py-2 text-sm font-medium"
          >
            Your orders
          </NavLink>
        </nav>
      ) : null}
    </header>
  )
}

/**
 * The categories menu.
 *
 * Only the top level, because the tree below it can be very deep and a menu is
 * not a place to render a taxonomy. Each entry leads to a category page, which
 * offers its own children — so the depth is walked rather than displayed.
 *
 * ── Click, not hover ────────────────────────────────────────────────────────
 *
 * Opening on hover as well as on click means a mouse user hovers the trigger
 * (which opens it), clicks (which toggles it shut), and sees the menu flash
 * closed under their cursor. Hover-opening also has nothing to say to a phone,
 * where there is no hover at all, so the menu would work differently on the
 * device most of these shoppers are using.
 *
 * One interaction, the same everywhere: click to open, click, Escape or moving
 * focus away to close.
 *
 * Closing on blur rather than on a document listener: the panel and its trigger
 * live in one container, so focus leaving the container is exactly the moment
 * it should shut, and that works for the keyboard as well as the mouse.
 */
function CategoryMenu({ categories }) {
  const [open, setOpen] = useState(false)

  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="text-ink-soft hover:bg-sunken flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium transition-colors"
      >
        Categories
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div className="border-line bg-surface shadow-card absolute top-full left-0 z-50 max-h-[70vh] w-56 overflow-y-auto rounded-lg border py-1">
          {categories.map((category) => (
            <Link
              key={category.handle}
              to={`/categories/${category.handle}`}
              onClick={() => setOpen(false)}
              className="text-ink-soft hover:bg-sunken hover:text-ink block px-3 py-2 text-sm"
            >
              {category.name}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
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

function Footer({ settings }) {
  const storeName = settings?.storeName ?? 'Shop'

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
          {/* Offered only when the shop actually takes bank transfers. A link
              to a payment method that is switched off is a dead end. */}
          {settings?.bankTransferEnabled ? (
            <Link to="/pay/bank-transfer" className="hover:text-ink">
              Pay by bank transfer
            </Link>
          ) : null}
          {settings?.supportUrl ? (
            <a
              href={settings.supportUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-ink"
            >
              Help
            </a>
          ) : null}
          {settings?.contactEmail ? (
            <a href={`mailto:${settings.contactEmail}`} className="text-brand-600 hover:underline">
              {settings.contactEmail}
            </a>
          ) : null}
        </span>
      </div>
    </footer>
  )
}
