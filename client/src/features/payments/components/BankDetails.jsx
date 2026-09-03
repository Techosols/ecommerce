import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { formatMoney } from '@/lib/format'

/**
 * Where to send the money.
 *
 * Every field is copyable, because the alternative is somebody reading an IBAN
 * off one screen and typing it into their banking app on another — which is
 * how money goes to the wrong account. The amount is copyable for the same
 * reason, and it is the order's own total, formatted by the shop.
 *
 * The instructions are HTML written by the shop in the admin's rich text
 * editor. The server sanitises them against a fixed allowlist on the way in
 * (`shared/validation/richText.ts`), which is what makes rendering them here
 * safe — the same guarantee the product description leans on.
 */
export function BankDetails({ bank, total, orderNumber }) {
  return (
    <section className="border-line bg-surface rounded-card border">
      <header className="border-line border-b px-5 py-3">
        <h2 className="text-base font-semibold">Send the payment</h2>
        <p className="text-muted mt-0.5 text-sm">
          Transfer the exact amount, then send us the receipt below.
        </p>
      </header>

      <dl className="divide-line divide-y">
        <Field label="Amount" value={formatMoney(total)} emphasis />
        {/* The reference is what lets staff match a line on a bank statement to
            an order, so it is given the same weight as the amount. */}
        <Field label="Reference" value={orderNumber} emphasis />
        <Field label="Account name" value={bank.accountName} />
        <Field label="Bank" value={bank.bankName} />
        {bank.accountNumber ? <Field label="Account number" value={bank.accountNumber} /> : null}
        {bank.iban ? <Field label="IBAN" value={bank.iban} /> : null}
        {bank.swift ? <Field label="SWIFT / BIC" value={bank.swift} /> : null}
      </dl>

      {bank.instructions ? (
        <div
          className="rte-content border-line text-muted border-t px-5 py-4 text-sm"
          dangerouslySetInnerHTML={{ __html: bank.instructions }}
        />
      ) : null}
    </section>
  )
}

function Field({ label, value, emphasis }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3">
      <dt className="text-muted shrink-0 text-sm">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <span
          className={
            emphasis
              ? 'text-ink tabular truncate text-sm font-semibold'
              : 'text-ink tabular truncate text-sm'
          }
        >
          {value}
        </span>
        <CopyButton value={value} label={label} />
      </dd>
    </div>
  )
}

function CopyButton({ value, label }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      // Named for what it copies, so a screen reader user hears "Copy IBAN"
      // rather than seven identical "Copy" buttons.
      aria-label={`Copy ${label.toLowerCase()}`}
      className="text-faint hover:text-ink hover:bg-sunken shrink-0 rounded p-1 transition-colors"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(String(value))
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          // Clipboard access can be refused — an insecure origin, a browser
          // setting. The number is on the screen either way, so this stays
          // silent rather than throwing an error at somebody who can read it.
        }
      }}
    >
      {copied ? (
        <Check className="text-good size-4" aria-hidden="true" />
      ) : (
        <Copy className="size-4" aria-hidden="true" />
      )}
      <span className="sr-only">{copied ? 'Copied' : ''}</span>
    </button>
  )
}
