import { useEffect, useRef, useState } from 'react'
import { ImageUp, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ACCEPT_ATTRIBUTE, validateReceipt } from '../api/bankTransfer.api'
import { useSubmitReceipt } from '../hooks/bankTransfer.hooks'

const PHASE_LABEL = {
  requesting: 'Getting ready…',
  uploading: 'Sending your receipt…',
  processing: 'Checking the image…',
  submitting: 'Sending it to the shop…',
}

/**
 * "Here is proof I sent the money."
 *
 * ── What this asks for, and why so little ────────────────────────────────────
 *
 * The screenshot, the name on the sending account, the sending bank, and
 * optionally the last four digits. That is what a member of staff needs in
 * order to find the matching line on a bank statement, and nothing more is
 * collected — a full account number typed into a public form is a liability the
 * shop would then be holding on somebody's behalf.
 *
 * ── What it deliberately does not promise ────────────────────────────────────
 *
 * Nothing here marks anything paid. The wording says a person will check,
 * because a person will: approving is a decision in the admin against the real
 * bank statement, and a screenshot is a claim until then.
 */
export function ReceiptUpload({ claim, onSubmitted }) {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [senderName, setSenderName] = useState('')
  const [senderBank, setSenderBank] = useState('')
  const [last4, setLast4] = useState('')
  const [fieldError, setFieldError] = useState(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)
  const previewRef = useRef(null)

  const receipt = useSubmitReceipt()

  /**
   * The preview is made where the file is chosen, not in an effect.
   *
   * A blob URL is a live handle into memory that has to be handed back, so it
   * is created by the event that caused it and the previous one is revoked in
   * the same breath. Deriving it in an effect instead would leak one for every
   * file the shopper tries, and would set state during render's aftermath for
   * something the click already knows.
   */
  function setChosenFile(next) {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = next ? URL.createObjectURL(next) : null
    setPreview(previewRef.current)
    setFile(next)
  }

  // The last one still has to be handed back when the page goes.
  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    },
    [],
  )

  function choose(next) {
    const problem = validateReceipt(next)
    setFieldError(problem)
    setChosenFile(problem ? null : next)
    receipt.reset()
  }

  async function submit(event) {
    event.preventDefault()

    if (!file) {
      setFieldError('Choose a screenshot of the transfer.')
      return
    }
    if (!senderName.trim() || !senderBank.trim()) {
      setFieldError('Tell us the name on the account and which bank it was sent from.')
      return
    }
    if (last4 && !/^[0-9]{4}$/.test(last4.trim())) {
      // The server refuses anything but four digits rather than truncating, so
      // saying that here is kinder than letting it round-trip.
      setFieldError('The last four digits should be exactly four numbers, or leave it empty.')
      return
    }
    setFieldError(null)

    try {
      const proof = await receipt.submit(claim, file, {
        senderName: senderName.trim(),
        senderBank: senderBank.trim(),
        ...(last4.trim() ? { accountLast4: last4.trim() } : {}),
      })
      onSubmitted?.(proof)
    } catch {
      // `receipt.error` already carries the sentence; the form stays as it is
      // so nothing the shopper typed is lost.
    }
  }

  return (
    <form
      onSubmit={submit}
      // Validation is this component's, not the browser's. The one thing that
      // must be there — the screenshot — is a file the browser cannot check
      // for, so leaving native validation on means the form silently refuses
      // to submit with no message about the only field that is actually
      // missing. `required` stays on the inputs for what it tells a screen
      // reader; the messages below are the ones a person sees.
      noValidate
      className="border-line bg-surface rounded-card flex flex-col border"
    >
      <header className="border-line border-b px-5 py-3">
        <h2 className="text-base font-semibold">Send us the receipt</h2>
        <p className="text-muted mt-0.5 text-sm">
          A screenshot from your banking app is fine. Someone will check it against our statement
          and confirm your order.
        </p>
      </header>

      <div className="flex flex-col gap-4 px-5 py-4">
        {/* ── The image ────────────────────────────────────────────────── */}
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            const dropped = event.dataTransfer.files?.[0]
            if (dropped) choose(dropped)
          }}
          className={[
            'rounded-card flex flex-col items-center gap-2 border border-dashed px-4 py-6 text-center transition-colors',
            dragging ? 'border-brand-500 bg-brand-50' : 'border-line',
          ].join(' ')}
        >
          {preview ? (
            <>
              {/* `object-contain`: a receipt cropped to fill its box is a
                  receipt with the amount cut off. */}
              <img
                src={preview}
                alt="The receipt you chose"
                className="bg-sunken max-h-56 w-auto rounded-lg object-contain"
              />
              <div className="flex items-center gap-2">
                <span className="text-muted max-w-[14rem] truncate text-xs">{file.name}</span>
                <button
                  type="button"
                  className="text-faint hover:text-ink inline-flex items-center gap-1 text-xs"
                  onClick={() => {
                    setChosenFile(null)
                    if (inputRef.current) inputRef.current.value = ''
                  }}
                >
                  <X className="size-3" aria-hidden="true" /> Choose another
                </button>
              </div>
            </>
          ) : (
            <>
              <ImageUp className="text-faint size-7" aria-hidden="true" />
              <p className="text-muted text-sm">Drop your screenshot here, or</p>
              <Button size="sm" onClick={() => inputRef.current?.click()}>
                Choose an image
              </Button>
              <p className="text-faint text-xs">JPEG, PNG, WebP, AVIF or GIF, up to 10 MB.</p>
            </>
          )}

          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            className="sr-only"
            aria-label="Receipt image"
            onChange={(event) => {
              const picked = event.target.files?.[0]
              if (picked) choose(picked)
            }}
          />
        </div>

        {/* ── The claim ────────────────────────────────────────────────── */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="sender-name"
            label="Name on the account you sent from"
            value={senderName}
            onChange={setSenderName}
            autoComplete="name"
            required
          />
          <Field
            id="sender-bank"
            label="Which bank"
            value={senderBank}
            onChange={setSenderBank}
            required
          />
        </div>

        <Field
          id="last4"
          label="Last four digits of your account"
          hint="Optional, but it makes your payment much easier to find."
          value={last4}
          onChange={(next) => setLast4(next.replace(/[^0-9]/g, '').slice(0, 4))}
          inputMode="numeric"
          className="sm:max-w-[12rem]"
        />

        {fieldError || receipt.error ? (
          <p className="border-bad/30 bg-bad-soft text-bad rounded-lg border px-3 py-2 text-sm">
            {fieldError ?? receipt.error}
          </p>
        ) : null}

        {receipt.isBusy ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">{PHASE_LABEL[receipt.phase]}</span>
              {receipt.phase === 'uploading' ? (
                <span className="text-faint tabular">{receipt.percent}%</span>
              ) : null}
            </div>
            <div className="bg-sunken h-1.5 w-full overflow-hidden rounded-full">
              <div
                className="bg-brand-600 h-full rounded-full transition-[width] duration-200"
                style={{ width: `${receipt.phase === 'uploading' ? receipt.percent : 100}%` }}
              />
            </div>
          </div>
        ) : null}
      </div>

      <footer className="border-line flex items-center gap-2 border-t px-5 py-4">
        <Button type="submit" variant="primary" isLoading={receipt.isBusy}>
          Send the receipt
        </Button>
        {receipt.isBusy ? (
          <Button type="button" variant="ghost" onClick={receipt.cancel}>
            Cancel
          </Button>
        ) : null}
      </footer>
    </form>
  )
}

function Field({ id, label, hint, value, onChange, className, ...props }) {
  return (
    <div className={['flex flex-col gap-1.5', className].filter(Boolean).join(' ')}>
      <label htmlFor={id} className="text-ink text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="border-line bg-surface text-ink placeholder:text-faint focus:border-brand-500 h-10 w-full rounded-lg border px-3 text-sm focus:outline-none"
        {...props}
      />
      {hint ? <p className="text-faint text-xs">{hint}</p> : null}
    </div>
  )
}
