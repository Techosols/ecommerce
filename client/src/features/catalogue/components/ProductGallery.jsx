import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * The product's photographs.
 *
 * A controlled component on purpose: the product page owns which image is
 * showing, because choosing a colour has to move the gallery, and a gallery
 * holding its own index would fight the picker for control of it.
 *
 * The arrows appear only on hover and only when there is somewhere to go, and
 * they are real buttons rather than overlaid divs so the whole thing works from
 * a keyboard. Below the frame is a filmstrip — the current image is marked with
 * a ring, and `aria-current` says which one it is to a screen reader that
 * cannot see the ring.
 */
export function ProductGallery({ images, title, index, onIndex }) {
  if (images.length === 0) {
    return (
      <div className="bg-sunken rounded-card flex aspect-square items-center justify-center overflow-hidden">
        <span
          aria-hidden="true"
          className="text-brand-300 font-display text-8xl select-none"
        >
          {title.slice(0, 1)}
        </span>
      </div>
    )
  }

  const safe = Math.min(Math.max(index, 0), images.length - 1)
  const current = images[safe]
  const step = (delta) => onIndex((safe + delta + images.length) % images.length)

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-sunken rounded-card group relative aspect-square overflow-hidden">
        <img
          src={current.url}
          alt={current.alt ?? title}
          className="size-full object-cover"
          // The first image is what somebody arriving from a search sees, so it
          // loads eagerly; the rest wait until the filmstrip is reached.
          loading={safe === 0 ? 'eager' : 'lazy'}
        />

        {images.length > 1 ? (
          <>
            <GalleryArrow side="left" onClick={() => step(-1)} />
            <GalleryArrow side="right" onClick={() => step(1)} />
            <p className="bg-ink/60 tabular absolute right-3 bottom-3 rounded-full px-2 py-0.5 text-xs text-white">
              {safe + 1} / {images.length}
            </p>
          </>
        ) : null}
      </div>

      {images.length > 1 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Product images">
          {images.map((image, position) => (
            <li key={image.url ?? position}>
              <button
                type="button"
                aria-label={`Show image ${position + 1}`}
                aria-current={position === safe ? 'true' : undefined}
                onClick={() => onIndex(position)}
                className={cn(
                  'bg-sunken size-16 overflow-hidden rounded-lg border transition-all',
                  position === safe
                    ? 'border-brand-600 ring-brand-600/30 ring-2'
                    : 'border-line hover:border-line-strong opacity-80 hover:opacity-100',
                )}
              >
                <img
                  src={image.url}
                  alt=""
                  loading="lazy"
                  className="size-full object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function GalleryArrow({ side, onClick }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === 'left' ? 'Previous image' : 'Next image'}
      className={cn(
        'bg-surface/90 text-ink absolute top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full shadow-sm transition-opacity',
        // Hidden until wanted on a mouse, always present on touch — where there
        // is no hover and a hidden control is simply a missing one.
        'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
        side === 'left' ? 'left-3' : 'right-3',
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  )
}
