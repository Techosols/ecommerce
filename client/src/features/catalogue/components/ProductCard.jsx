import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/lib/cn'
import { formatPriceRange } from '@/lib/format'
import { QuickAdd } from './QuickAdd'

const FLAGS = [
  { tag: 'bestseller', label: 'Bestseller' },
  { tag: 'signature', label: 'Signature' },
]

/**
 * One product in a grid.
 *
 * Everything shown is the server's answer. `priceRange` in particular is
 * computed there over only the variants that can actually be bought, so a
 * product whose cheapest size sold out advertises a price a shopper can
 * actually pay — a "from" price worked out in the browser would not know that.
 *
 * The card is one link with two controls layered over it — a quick-add button
 * and, when the shopper opens it, a panel. Those are siblings of the link
 * rather than children of it: a button inside an anchor is invalid HTML, and
 * browsers resolve it by following the link on every click.
 */
export function ProductCard({ product }) {
  const [quickAdd, setQuickAdd] = useState(false)
  const soldOut = !product.available
  // `publicProductCardDto` carries no compare-at price, so a grid cannot show
  // "20% off" — see the note in README.md. What it does carry is tags, and one
  // of those is worth a badge.
  const flag = FLAGS.find((tag) => product.tags?.includes(tag.tag))

  return (
    <div
      className={cn(
        'group border-line bg-surface rounded-card relative flex flex-col overflow-hidden border',
        'shadow-card hover:shadow-lift transition-shadow duration-200',
        soldOut && 'opacity-75',
      )}
    >
      <Link
        to={`/products/${product.handle}`}
        className="flex flex-1 flex-col"
        aria-label={product.title}
      >
      <div className="bg-sunken relative aspect-[4/3] overflow-hidden">
        {product.image ? (
          <img
            src={product.image.url}
            alt={product.image.alt ?? ''}
            loading="lazy"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          // No photograph yet. A neutral panel with the initial reads as
          // deliberate; a broken image icon reads as a broken shop.
          <div
            aria-hidden="true"
            className="text-brand-300 font-display flex size-full items-center justify-center text-5xl select-none"
          >
            {product.title.slice(0, 1)}
          </div>
        )}

        {soldOut ? (
          <span className="absolute top-3 left-3">
            <Badge tone="bad">Sold out</Badge>
          </span>
        ) : flag ? (
          <span className="absolute top-3 left-3">
            <Badge tone="copper">{flag.label}</Badge>
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-4">
        <h3 className="text-ink group-hover:text-brand-700 text-base leading-snug font-semibold transition-colors">
          {product.title}
        </h3>

        {product.subtitle ? (
          <p className="text-muted line-clamp-2 text-sm">{product.subtitle}</p>
        ) : null}

        {/* `priceRange` is computed over purchasable variants only, so a
            sold-out product has none at all. An em dash in the price slot
            reads as a bug; saying it plainly does not. */}
        {/* The colours it comes in, straight from the server — the same hexes
            the merchant set, never a guess from the name. Capped, because a
            card is not a swatch library; the rest are counted rather than
            crammed in. */}
        {product.colours?.length > 0 ? (
          <ul aria-label="Available colours" className="flex flex-wrap items-center gap-1 pt-2">
            {product.colours.slice(0, 5).map((colour) => (
              <li key={colour.value}>
                <span
                  role="img"
                  aria-label={colour.value}
                  title={colour.value}
                  style={{ backgroundColor: colour.swatchHex }}
                  className="block size-3.5 rounded-full border border-black/15"
                />
              </li>
            ))}
            {product.colours.length > 5 ? (
              <li className="text-faint tabular text-xs">+{product.colours.length - 5}</li>
            ) : null}
          </ul>
        ) : null}

        <p className="mt-auto pt-3 font-medium">
          {product.priceRange ? (
            <span className="text-ink tabular">{formatPriceRange(product.priceRange)}</span>
          ) : (
            <span className="text-muted text-sm">Currently unavailable</span>
          )}
        </p>
      </div>
      </Link>

      {/* Only where it can lead somewhere. A quick-add on a sold-out product
          is a button whose only outcome is a refusal. */}
      {!soldOut && !quickAdd ? (
        <button
          type="button"
          aria-label={`Quick add ${product.title}`}
          onClick={() => setQuickAdd(true)}
          className={cn(
            'bg-surface/95 text-ink shadow-card hover:bg-brand-600 absolute top-3 right-3 grid size-9 place-items-center rounded-full transition-all hover:text-white',
            // Out of the way on a mouse until the card is hovered; always there
            // on touch, where there is no hover and a hidden control is simply
            // a missing one.
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
          )}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      ) : null}

      {quickAdd ? (
        <QuickAdd
          handle={product.handle}
          title={product.title}
          onClose={() => setQuickAdd(false)}
        />
      ) : null}
    </div>
  )
}

/** The card's own shape, so the grid does not reflow when the data lands. */
export function ProductCardSkeleton() {
  return (
    <div className="border-line bg-surface rounded-card overflow-hidden border">
      <Skeleton className="aspect-[4/3] rounded-none" />
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="mt-3 h-4 w-20" />
      </div>
    </div>
  )
}
