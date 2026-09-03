import { useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useFieldControl } from './field.context'
import { controlBase, controlInvalid, controlValid } from './Input'

export interface TagsInputProps {
  value: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
  maxTags?: number
  maxLength?: number
  disabled?: boolean
  invalid?: boolean
  className?: string
}

/**
 * A list of short free-text labels.
 *
 * Enter and comma both commit, because people type both. Backspace on an empty
 * field removes the last tag, which is the one interaction that makes a chip
 * list feel like a text field rather than a widget.
 *
 * The limits mirror the server's schema so the field cannot compose a request
 * the API will reject — and the caller sets them, because "50 tags of 40
 * characters" is right for product tags and wrong for a list of email
 * addresses, which are routinely longer than forty characters and capped at ten.
 *
 * An over-long entry is **refused, not truncated**. Silently cutting one to fit
 * turns `accounts.payable@somewhere-long.com` into an address that is not
 * anybody's, which the server then rejects — so the whole save fails and the
 * operator is left looking at a list they believe they just saved.
 */
export function TagsInput({
  value,
  onChange,
  placeholder = 'Add a tag and press Enter',
  maxTags = 50,
  maxLength = 40,
  disabled = false,
  invalid,
  className,
}: TagsInputProps) {
  const field = useFieldControl()
  const [draft, setDraft] = useState('')
  const [rejected, setRejected] = useState<string | null>(null)
  const isInvalid = invalid ?? field?.invalid ?? false

  function commit(raw: string) {
    const tag = raw.trim()
    if (!tag) return
    if (tag.length > maxLength) {
      setRejected(`That is longer than ${maxLength} characters.`)
      return
    }
    // Case-insensitive duplicate check: "Vegan" and "vegan" are one tag to a
    // shopper filtering by it.
    if (value.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      setDraft('')
      return
    }
    if (value.length >= maxTags) {
      setRejected(`You can add ${maxTags} at most.`)
      return
    }
    setRejected(null)
    onChange([...value, tag])
    setDraft('')
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      commit(draft)
      return
    }
    if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  const box = (
    <div
      className={cn(
        controlBase,
        isInvalid ? controlInvalid : controlValid,
        'flex min-h-9.5 flex-wrap items-center gap-1.5 px-2 py-1.5',
        disabled && 'pointer-events-none opacity-60',
        className,
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="bg-surface-sunken text-ink-soft inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(value.filter((entry) => entry !== tag))}
            className="text-faint hover:text-danger transition-colors"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}

      <input
        id={field?.id}
        aria-describedby={field?.describedBy}
        aria-invalid={isInvalid || undefined}
        value={draft}
        disabled={disabled || value.length >= maxTags}
        placeholder={value.length >= maxTags ? `Limit of ${maxTags} reached` : placeholder}
        onChange={(event) => {
          setDraft(event.target.value)
          setRejected(null)
        }}
        onKeyDown={handleKeyDown}
        // Committing on blur too, so a tag typed and abandoned is not silently
        // lost when the operator clicks Save.
        onBlur={() => commit(draft)}
        className="placeholder:text-faint min-w-40 flex-1 bg-transparent text-sm outline-none"
      />
    </div>
  )

  return rejected ? (
    <div className="flex flex-col gap-1">
      {box}
      <p className="text-danger text-xs">{rejected}</p>
    </div>
  ) : (
    box
  )
}
