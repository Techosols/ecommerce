import { useState } from 'react'
import { PackageCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { messageOf } from '@/lib/api'
import { RETURN_REASONS } from '../returnVocabulary'
import { useOpenReturn, useReturnable } from '../hooks/returns.hooks'

/**
 * Starting a return from an order.
 *
 * **What can go back is asked, never worked out here.** The server answers with
 * a `returnableQuantity` per line that already accounts for everything sent
 * back before, and whether the order is at a stage where returning makes sense
 * at all. A screen that subtracted its own idea of "returned so far" would
 * offer quantities the server then refuses — at the end, after the customer has
 * filled the form in.
 *
 * When nothing is returnable the server says why, and that sentence is shown
 * verbatim rather than replaced with a generic one.
 */
export function ReturnRequest({ orderId, enabled }) {
  const returnable = useReturnable(orderId, enabled)
  const open = useOpenReturn(orderId)
  const [quantities, setQuantities] = useState({})
  const [reason, setReason] = useState('no_longer_wanted')
  const [note, setNote] = useState('')
  const [expanded, setExpanded] = useState(false)

  if (returnable.isPending) return <Skeleton className="h-24 w-full" />
  if (returnable.error) return null

  const data = returnable.data
  const lines = (data?.lines ?? []).filter((line) => line.returnableQuantity > 0)

  if (!data?.eligible || lines.length === 0) {
    // Only worth saying once there is an order to say it about. The server's
    // own sentence — "Nothing has gone out on this order yet" — is more useful
    // than any generic replacement.
    return data?.reason ? <p className="text-muted text-sm">{data.reason}</p> : null
  }

  const chosen = Object.entries(quantities)
    .filter(([, quantity]) => quantity > 0)
    .map(([orderItemId, quantity]) => ({ orderItemId, quantity }))

  if (open.isSuccess) {
    return (
      <div className="border-good/25 bg-good-soft rounded-card flex items-start gap-3 border px-5 py-4">
        <PackageCheck className="text-good mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="text-ink font-medium">Return {open.data.returnNumber} is open</p>
          <p className="text-muted text-sm">
            We will email you what to do next. You can follow it under Returns.
          </p>
        </div>
      </div>
    )
  }

  return (
    <section className="border-line rounded-card border border-dashed p-5">
      <h2 className="text-ink mb-1 text-base font-semibold">Need to send something back?</h2>

      {!expanded ? (
        <>
          <p className="text-muted mb-3 text-sm">
            Tell us what is going back and why, and we will send you the details.
          </p>
          <Button onClick={() => setExpanded(true)}>Start a return</Button>
        </>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (chosen.length === 0) return
            open.mutate({
              reason,
              customerNote: note.trim() || null,
              lines: chosen,
            })
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="text-ink mb-1 text-sm font-medium">What is going back?</legend>
            {lines.map((line) => (
              <label
                key={line.orderItemId}
                className="border-line flex items-center gap-3 rounded-lg border px-3 py-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="text-ink block text-sm">{line.productTitle}</span>
                  {line.variantTitle ? (
                    <span className="text-muted block text-xs">{line.variantTitle}</span>
                  ) : null}
                  <span className="text-faint block text-xs">
                    {line.returnableQuantity} of {line.quantity} can go back
                    {line.returnedQuantity > 0
                      ? ` · ${line.returnedQuantity} already returned`
                      : ''}
                  </span>
                </span>

                <input
                  type="number"
                  min={0}
                  max={line.returnableQuantity}
                  aria-label={`How many ${line.productTitle} to return`}
                  value={quantities[line.orderItemId] ?? 0}
                  disabled={open.isPending}
                  onChange={(event) => {
                    // Clamped to what the server said is possible. It checks
                    // again regardless; this only avoids offering a number that
                    // is going to be refused.
                    const wanted = Number(event.target.value)
                    const safe = Math.max(0, Math.min(line.returnableQuantity, wanted || 0))
                    setQuantities((current) => ({ ...current, [line.orderItemId]: safe }))
                  }}
                  className="border-line bg-surface text-ink tabular h-9 w-16 rounded-lg border px-2 text-center text-sm focus:outline-none"
                />
              </label>
            ))}
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="return-reason" className="text-ink text-sm font-medium">
              Why?
            </label>
            <select
              id="return-reason"
              value={reason}
              disabled={open.isPending}
              onChange={(event) => setReason(event.target.value)}
              className="border-line bg-surface text-ink h-10 w-full max-w-xs rounded-lg border px-3 text-sm focus:outline-none"
            >
              {Object.entries(RETURN_REASONS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="return-note" className="text-ink text-sm font-medium">
              Anything else
            </label>
            <textarea
              id="return-note"
              rows={2}
              maxLength={1000}
              placeholder="The seal was broken when it arrived."
              value={note}
              disabled={open.isPending}
              onChange={(event) => setNote(event.target.value)}
              className="border-line bg-surface text-ink placeholder:text-faint w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
            />
          </div>

          {open.error ? (
            <p className="border-bad/30 bg-bad-soft text-bad rounded-lg border px-3 py-2 text-sm">
              {messageOf(open.error)}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="primary"
              isLoading={open.isPending}
              disabled={chosen.length === 0 || open.isPending}
            >
              Request this return
            </Button>
            <Button type="button" onClick={() => setExpanded(false)} disabled={open.isPending}>
              Not now
            </Button>
          </div>

          {chosen.length === 0 ? (
            <p className="text-faint text-xs">Choose at least one thing to send back.</p>
          ) : null}
        </form>
      )}
    </section>
  )
}
