import { useEffect, useRef, useState } from 'react'
import { Check, Pipette, X } from 'lucide-react'
import { Button } from './Button'
import { cn } from '@/lib/cn'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useOnClickOutside } from '@/hooks/useOnClickOutside'

/**
 * What a colour value looks like, and how a merchant sets it.
 *
 * Two pieces, deliberately: a **chip** anybody can read at a glance, and a
 * **popover** only the person editing opens. A grid of always-open colour
 * inputs turns a six-shade lipstick into a wall of controls.
 *
 * The native `<input type="color">` does the actual picking. It is the one
 * control every platform already knows how to render well — an eyedropper on
 * macOS, the system picker on Windows — and a hand-rolled HSV square would be
 * worse on all of them. Beside it is a text field, because a brand hex arrives
 * copied from a style guide far more often than it arrives eyeballed.
 */

/** A hex the browser will accept in `<input type="color">`, which needs one. */
const FALLBACK = '#888888'

export function isHex(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim())
}

/**
 * Expands and normalises what a person typed, or returns null if it is not a
 * colour. The same three spellings the server accepts, so what passes here
 * passes there.
 */
export function normaliseHex(raw: string): string | null {
  const body = raw.trim().replace(/^#/, '')
  const expanded =
    body.length === 3
      ? body
          .split('')
          .map((char) => char + char)
          .join('')
      : body
  const candidate = `#${expanded.toLowerCase()}`
  return isHex(candidate) ? candidate : null
}

/**
 * Black or white text, whichever is readable on the given colour.
 *
 * The sRGB relative-luminance formula rather than a naive average: #00ff00 and
 * #0000ff have the same average and wildly different brightness, and picking
 * white text on bright green is exactly the case an average gets wrong.
 */
export function readableInkOn(hex: string): string {
  const value = normaliseHex(hex) ?? FALLBACK
  const channel = (offset: number) => {
    const srgb = parseInt(value.slice(offset, offset + 2), 16) / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  return luminance > 0.4 ? '#1a1a1a' : '#ffffff'
}

export interface SwatchChipProps {
  hex: string | null
  /** Named for a screen reader, which cannot see the circle. */
  label: string
  className?: string
}

/**
 * The circle itself.
 *
 * With no colour it is an empty dashed ring rather than a grey dot: "nobody has
 * said" and "this value is grey" are different facts, and a filled circle would
 * state the second.
 */
export function SwatchChip({ hex, label, className }: SwatchChipProps) {
  return (
    <span
      role="img"
      aria-label={hex ? `${label}, ${hex}` : `${label}, no colour set`}
      title={hex ?? 'No colour set'}
      className={cn(
        'inline-block size-4 shrink-0 rounded-full border',
        hex ? 'border-black/15' : 'border-line-strong border-dashed',
        className,
      )}
      style={hex ? { backgroundColor: hex } : undefined}
    />
  )
}

export interface SwatchPickerProps {
  hex: string | null
  label: string
  disabled?: boolean
  onChange: (hex: string | null) => void
}

export function SwatchPicker({ hex, label, disabled, onChange }: SwatchPickerProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(hex ?? '')
  const container = useRef<HTMLDivElement>(null)

  // Reopening shows what is stored, not what was abandoned last time.
  useEffect(() => {
    if (open) setText(hex ?? '')
  }, [open, hex])

  useOnClickOutside(container, () => setOpen(false))
  useEscapeKey(() => setOpen(false), open)

  const typed = normaliseHex(text)
  const canApply = text.trim() === '' || typed !== null

  function apply() {
    if (!canApply) return
    onChange(text.trim() === '' ? null : typed)
    setOpen(false)
  }

  return (
    <div ref={container} className="relative inline-flex">
      <button
        type="button"
        disabled={disabled}
        aria-label={hex ? `Change the colour of ${label}` : `Set a colour for ${label}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="hover:bg-surface-sunken rounded p-0.5 transition-colors disabled:pointer-events-none disabled:opacity-50"
      >
        <SwatchChip hex={hex} label={label} />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={`Colour for ${label}`}
          className="bg-surface-raised border-line shadow-overlay animate-pop-in absolute top-full left-0 z-40 mt-1.5 flex w-56 flex-col gap-2 rounded-lg border p-3"
        >
          <div className="flex items-center gap-2">
            {/* The system picker. `value` needs a real hex even when nothing is
                set, so an unset value opens on a neutral grey rather than the
                black every browser would otherwise default to. */}
            <input
              type="color"
              aria-label={`Pick a colour for ${label}`}
              value={typed ?? hex ?? FALLBACK}
              onChange={(event) => setText(event.target.value)}
              className="border-line size-8 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
            />
            <input
              aria-label={`Hex colour for ${label}`}
              placeholder="#b4622d"
              maxLength={7}
              spellCheck={false}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  apply()
                }
              }}
              className={cn(
                'border-line bg-surface text-ink h-8 w-full rounded border px-2 font-mono text-xs',
                'focus:border-accent focus:outline-none',
                !canApply && 'border-danger',
              )}
            />
          </div>

          {!canApply ? (
            <p className="text-danger text-xs">A colour looks like #b4622d.</p>
          ) : (
            <p className="text-muted text-xs">
              Leave it empty to show the name instead.
            </p>
          )}

          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="primary"
              disabled={!canApply}
              leadingIcon={<Check className="size-3" />}
              onClick={apply}
            >
              Apply
            </Button>
            {hex ? (
              <Button
                size="xs"
                variant="subtle"
                leadingIcon={<X className="size-3" />}
                onClick={() => {
                  onChange(null)
                  setOpen(false)
                }}
              >
                Clear
              </Button>
            ) : null}
            <Pipette aria-hidden="true" className="text-faint ml-auto size-3.5" />
          </div>
        </div>
      ) : null}
    </div>
  )
}
