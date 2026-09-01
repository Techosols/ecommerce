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
 * The limits mirror the server's schema (50 tags, 40 characters each) so the
 * field cannot compose a request the API will reject.
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
  const isInvalid = invalid ?? field?.invalid ?? false

  function commit(raw: string) {
    const tag = raw.trim().slice(0, maxLength)
    if (!tag) return
    // Case-insensitive duplicate check: "Vegan" and "vegan" are one tag to a
    // shopper filtering by it.
    if (value.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      setDraft('')
      return
    }
    if (value.length >= maxTags) return
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

  return (
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
        maxLength={maxLength}
        placeholder={value.length >= maxTags ? `Limit of ${maxTags} tags reached` : placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        // Committing on blur too, so a tag typed and abandoned is not silently
        // lost when the operator clicks Save.
        onBlur={() => commit(draft)}
        className="placeholder:text-faint min-w-40 flex-1 bg-transparent text-sm outline-none"
      />
    </div>
  )
}
