import { useId, useRef, useState, type DragEvent } from 'react'
import { ImagePlus, Loader2, Upload } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ACCEPT_ATTRIBUTE, type UploadProgress } from './media.types'

export interface ImageDropzoneProps {
  onFiles: (files: File[]) => void
  progress?: UploadProgress
  disabled?: boolean
  multiple?: boolean
  hint?: string
  className?: string
}

const phaseLabels: Record<UploadProgress['phase'], string> = {
  idle: '',
  requesting: 'Preparing…',
  uploading: 'Uploading',
  processing: 'Processing on the server…',
  ready: 'Done',
  failed: 'Failed',
}

/**
 * The drop target and file picker.
 *
 * A `<label>` wrapping a visually hidden `<input type="file">` rather than a
 * div that calls `.click()`: the native pairing is keyboard-reachable and
 * announced correctly for free, and a click handler on a div is not.
 */
export function ImageDropzone({
  onFiles,
  progress,
  disabled = false,
  multiple = true,
  hint,
  className,
}: ImageDropzoneProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [isOver, setIsOver] = useState(false)

  const busy =
    progress &&
    progress.phase !== 'idle' &&
    progress.phase !== 'ready' &&
    progress.phase !== 'failed'

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    setIsOver(false)
    if (disabled || busy) return
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) onFiles(multiple ? files : files.slice(0, 1))
  }

  return (
    <label
      htmlFor={inputId}
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled && !busy) setIsOver(true)
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={handleDrop}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors',
        isOver
          ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
          : 'border-line-strong hover:border-brand-400 hover:bg-surface-hover',
        (disabled || busy) && 'pointer-events-none opacity-60',
        className,
      )}
    >
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        multiple={multiple}
        disabled={disabled || busy}
        className="sr-only"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          if (files.length > 0) onFiles(files)
          // Clearing lets the same file be chosen twice in a row, which
          // otherwise fires no change event at all.
          event.target.value = ''
        }}
      />

      {busy ? (
        <>
          <Loader2 aria-hidden="true" className="text-brand-600 size-6 animate-spin" />
          <p className="text-ink mt-3 text-sm font-medium">{phaseLabels[progress.phase]}</p>
          {progress.phase === 'uploading' ? (
            <div className="bg-surface-sunken mt-3 h-1.5 w-48 overflow-hidden rounded-full">
              <div
                role="progressbar"
                aria-valuenow={progress.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                className="bg-brand-600 h-full transition-[width] duration-150"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          ) : (
            <p className="text-muted mt-1 text-xs">
              The server is re-encoding the image and generating thumbnails.
            </p>
          )}
        </>
      ) : (
        <>
          <span className="bg-surface-sunken text-faint flex size-10 items-center justify-center rounded-full">
            {multiple ? <ImagePlus className="size-5" /> : <Upload className="size-5" />}
          </span>
          <p className="text-ink mt-3 text-sm font-medium">
            Drop {multiple ? 'images' : 'an image'} here, or{' '}
            <span className="text-brand-600">browse</span>
          </p>
          <p className="text-muted mt-1 text-xs">
            {hint ?? 'JPEG, PNG, WebP, AVIF or GIF, up to 10 MB each.'}
          </p>
        </>
      )}
    </label>
  )
}
