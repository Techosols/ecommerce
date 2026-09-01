import { Button } from './Button'
import { cn } from '@/lib/cn'

export interface SaveBarProps {
  /** Rendered only when there is something to save. */
  isDirty: boolean
  isSaving?: boolean
  /** Disables Save without hiding the bar — a form that is dirty *and* invalid. */
  canSave?: boolean
  onDiscard: () => void
  onSave: () => void
  /** Overrides "Unsaved changes" — e.g. "Unsaved product". */
  message?: string
  /** The id of the form Save submits, when Save is a submit button. */
  form?: string
}

/**
 * The bar that appears over the top bar the moment a form is dirty.
 *
 * Two things it does that a Save button in a page header does not:
 *
 *   • **It says there is something to lose.** A page header's Save looks the
 *     same whether or not anything has been typed, so the only way to find out
 *     is to navigate away and see whether anything was lost.
 *   • **It offers Discard.** Reverting is otherwise a reload, which a person
 *     has to know is safe.
 *
 * It sits *over* the top bar rather than under it, so it never adds a row: the
 * page does not shift down when the first character is typed, which would move
 * the field under the cursor.
 *
 * Deliberately not a global context. A save bar belongs to one form on one
 * screen, and a context would let two screens argue about whose changes the bar
 * is describing.
 */
export function SaveBar({
  isDirty,
  isSaving = false,
  canSave = true,
  onDiscard,
  onSave,
  message = 'Unsaved changes',
  form,
}: SaveBarProps) {
  if (!isDirty) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'bg-topbar animate-slide-down fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-3 px-3 sm:px-4',
      )}
    >
      <span className="text-topbar-ink min-w-0 flex-1 truncate text-[0.8125rem] font-medium">
        {message}
      </span>

      <Button
        size="sm"
        onClick={onDiscard}
        disabled={isSaving}
        className="bg-topbar-hover border-0 text-white ring-1 ring-white/15 ring-inset hover:bg-white/15"
      >
        Discard
      </Button>

      {/* White on near-black: the inverse of the primary button everywhere
          else, because on this bar the dark button would disappear. */}
      <Button
        size="sm"
        form={form}
        type={form ? 'submit' : 'button'}
        isLoading={isSaving}
        disabled={!canSave || isSaving}
        onClick={form ? undefined : onSave}
        className="bg-white text-ink hover:bg-white/90 disabled:bg-white/40 disabled:text-white"
      >
        Save
      </Button>
    </div>
  )
}
