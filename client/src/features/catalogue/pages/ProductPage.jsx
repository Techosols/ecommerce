import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Check, ChevronRight, ShoppingBag } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { availabilityLabel, formatMoney, hasDiscount } from '@/lib/format'
import { messageOf } from '@/lib/api'
import { useAddToCart } from '@/features/cart/hooks/cart.hooks'
import { useProduct } from '../hooks/catalogue.hooks'
import { OptionPicker } from '../components/OptionPicker'
import { ProductGallery } from '../components/ProductGallery'
import { RelatedProducts } from '../components/RelatedProducts'
import {
  chooseValue,
  galleryIndexFor,
  initialVariant,
  selectionOf,
  variantFor,
} from '../variantSelection'

/**
 * One product, and the choice of which variant to buy.
 *
 * The price shown is always the **selected variant's** price, not the range:
 * once someone has picked a size, "from £11.50" is no longer an honest label
 * for what they would pay.
 *
 * Availability is per variant and comes from the server, resolved on this
 * request rather than cached with the product. A sold-out size stays visible
 * and marked rather than disappearing — somebody choosing between sizes needs
 * to see that the large exists and cannot be had.
 */
export function ProductPage() {
  const { handle } = useParams()
  const query = useProduct(handle)

  return (
    <QueryBoundary
      isLoading={query.isPending}
      error={query.error}
      onRetry={() => void query.refetch()}
      fallback={<ProductSkeleton />}
    >
      {query.data ? <ProductView product={query.data} /> : null}
    </QueryBoundary>
  )
}

function ProductView({ product }) {
  // The first variant a shopper can actually buy, falling back to the first one
  // so a wholly sold-out product still renders a coherent page.
  const initial = useMemo(() => initialVariant(product), [product])

  // The selection is per *option*, not a variant id: a shopper picks a colour
  // and then a size, and the variant is what those answers resolve to.
  const [selection, setSelection] = useState(() => selectionOf(initial))
  // Which image is showing, and which variant's choice put it there.
  const [gallery, setGallery] = useState({ index: 0, forVariant: null })

  const selected = variantFor(product, selection) ?? initial
  const stock = availabilityLabel(selected?.availability)

  // Choosing a colour moves the gallery to that colour's photograph.
  //
  // Adjusted during render rather than in an effect: React re-renders straight
  // away without committing the first pass, so the shopper never sees one frame
  // of the old picture under the new colour. The `forVariant` half is what
  // makes a hand-picked thumbnail stick — it is only overridden when the
  // *variant* changes, not on every render.
  //
  // A variant with no image of its own keeps whatever is showing. Falling back
  // to a fixed index here would send the gallery back to the hero shot every
  // time somebody changed size, which is the bug this shape exists to avoid.
  if (gallery.forVariant !== (selected?.id ?? null)) {
    const linked = galleryIndexFor(product, selected)
    setGallery({ index: linked ?? gallery.index, forVariant: selected?.id ?? null })
  }
  const imageIndex = gallery.index

  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-col gap-8">
        <nav aria-label="Breadcrumb" className="text-muted flex items-center gap-1 text-sm">
          <Link to="/products" className="hover:text-ink">
            Shop
          </Link>
          <ChevronRight className="size-3.5" aria-hidden="true" />
          <span className="text-ink">{product.title}</span>
        </nav>

        <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
          <ProductGallery
            images={product.images}
            title={product.title}
            index={imageIndex}
            // A manual choice is recorded against the current variant, so it
            // survives until the shopper picks a different one.
            onIndex={(next) => setGallery({ index: next, forVariant: selected?.id ?? null })}
          />

          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <h1 className="text-3xl sm:text-4xl">{product.title}</h1>
              {product.subtitle ? <p className="text-muted text-lg">{product.subtitle}</p> : null}
            </div>

            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-ink tabular font-display text-3xl">
                {formatMoney(selected?.price)}
              </span>
              {hasDiscount(selected?.price, selected?.compareAtPrice) ? (
                <span className="text-faint tabular text-lg line-through">
                  {formatMoney(selected.compareAtPrice)}
                </span>
              ) : null}
              <Badge tone={stock.tone}>{stock.label}</Badge>
            </div>

            {/* One picker per axis. A product with a single variant has no
                question to ask, so it gets none. */}
            {product.variants.length > 1
              ? product.options.map((option) => (
                  <OptionPicker
                    key={option.id}
                    product={product}
                    option={option}
                    selection={selection}
                    onChoose={(chosenOption, valueId) =>
                      setSelection((current) =>
                        chooseValue(product, current, chosenOption, valueId),
                      )
                    }
                  />
                ))
              : null}

            <AddToBasket variant={selected} />

            {product.description ? (
              <div className="border-line border-t pt-5">
                <h2 className="text-ink mb-2 text-base font-semibold">About this</h2>
                <p className="text-muted leading-relaxed whitespace-pre-line">
                  {product.description}
                </p>
              </div>
            ) : null}

            {product.tags.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {product.tags.map((tag) => (
                  <li
                    key={tag}
                    className="border-line text-muted rounded-full border px-2.5 py-0.5 text-xs"
                  >
                    {tag}
                  </li>
                ))}
              </ul>
            ) : null}

            {selected?.sku ? (
              <p className="text-faint text-xs">
                SKU <span className="tabular">{selected.sku}</span>
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <RelatedProducts handle={product.handle} />
    </div>
  )
}

/**
 * Adding the chosen variant to the basket.
 *
 * The button reports what happened rather than assuming it worked: stock is
 * checked on the server, and a variant that sold out between the page loading
 * and the click is refused. The refusal is shown in the server's own words —
 * "Only 2 left" is useful, "could not add to basket" is not.
 */
function AddToBasket({ variant }) {
  const add = useAddToCart()
  const [justAdded, setJustAdded] = useState(false)

  if (!variant?.available) {
    return (
      <Button variant="primary" size="lg" fullWidth disabled>
        Sold out
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant={justAdded ? 'copper' : 'primary'}
        size="lg"
        fullWidth
        isLoading={add.isPending}
        leadingIcon={
          justAdded ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <ShoppingBag className="size-4" aria-hidden="true" />
          )
        }
        onClick={() =>
          add.mutate(
            { variantId: variant.id, quantity: 1 },
            {
              onSuccess: () => {
                setJustAdded(true)
                window.setTimeout(() => setJustAdded(false), 2000)
              },
            },
          )
        }
      >
        {justAdded ? 'Added to your basket' : 'Add to basket'}
      </Button>

      {add.error ? (
        <p className="border-bad/30 bg-bad-soft text-bad rounded-lg border px-3 py-2 text-sm">
          {messageOf(add.error)}
        </p>
      ) : null}

      {justAdded ? (
        <Link to="/cart" className="text-brand-600 text-center text-sm hover:underline">
          Go to your basket
        </Link>
      ) : null}
    </div>
  )
}

function ProductSkeleton() {
  return (
    <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
      <Skeleton className="rounded-card aspect-square" />
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  )
}
