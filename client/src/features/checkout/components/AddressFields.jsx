/**
 * The address form, used for delivery and — when it differs — for billing.
 *
 * Deliberately plain. Every constraint here mirrors the server's own schema,
 * so a form that passes locally is one the server will accept: names and city
 * are required, the country is two letters, and everything else is optional
 * because addresses in much of the world do not have it.
 *
 * The country field is where a checkout most often goes wrong, so it is the
 * one that drives the quote: changing it re-rates delivery immediately.
 */
export function AddressFields({ prefix, value, errors = {}, disabled, onChange }) {
  const set = (key) => (event) => onChange({ ...value, [key]: event.target.value })
  const id = (key) => `${prefix}-${key}`

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id={id('firstName')} label="First name" required error={errors.firstName}>
        <input
          id={id('firstName')}
          autoComplete="given-name"
          className={input}
          value={value.firstName}
          disabled={disabled}
          onChange={set('firstName')}
        />
      </Field>

      <Field id={id('lastName')} label="Last name" required error={errors.lastName}>
        <input
          id={id('lastName')}
          autoComplete="family-name"
          className={input}
          value={value.lastName}
          disabled={disabled}
          onChange={set('lastName')}
        />
      </Field>

      <Field id={id('company')} label="Company" className="sm:col-span-2">
        <input
          id={id('company')}
          autoComplete="organization"
          className={input}
          value={value.company}
          disabled={disabled}
          onChange={set('company')}
        />
      </Field>

      <Field id={id('line1')} label="Address" required error={errors.line1} className="sm:col-span-2">
        <input
          id={id('line1')}
          autoComplete="address-line1"
          className={input}
          value={value.line1}
          disabled={disabled}
          onChange={set('line1')}
        />
      </Field>

      <Field id={id('line2')} label="Address line 2" className="sm:col-span-2">
        <input
          id={id('line2')}
          autoComplete="address-line2"
          className={input}
          value={value.line2}
          disabled={disabled}
          onChange={set('line2')}
        />
      </Field>

      <Field id={id('city')} label="City" required error={errors.city}>
        <input
          id={id('city')}
          autoComplete="address-level2"
          className={input}
          value={value.city}
          disabled={disabled}
          onChange={set('city')}
        />
      </Field>

      <Field id={id('region')} label="County or state">
        <input
          id={id('region')}
          autoComplete="address-level1"
          className={input}
          value={value.region}
          disabled={disabled}
          onChange={set('region')}
        />
      </Field>

      <Field id={id('postalCode')} label="Postcode">
        <input
          id={id('postalCode')}
          autoComplete="postal-code"
          className={input}
          value={value.postalCode}
          disabled={disabled}
          onChange={set('postalCode')}
        />
      </Field>

      <Field
        id={id('countryCode')}
        label="Country"
        required
        error={errors.countryCode}
        hint="Two letters, e.g. GB."
      >
        <input
          id={id('countryCode')}
          autoComplete="country"
          maxLength={2}
          className={`${input} uppercase`}
          value={value.countryCode}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, countryCode: event.target.value.toUpperCase() })
          }
        />
      </Field>
    </div>
  )
}

const input =
  'border-line bg-surface text-ink placeholder:text-faint focus:border-brand-500 h-10 w-full rounded-lg border px-3 text-sm transition-colors focus:outline-none disabled:opacity-60'

function Field({ id, label, required, hint, error, className = '', children }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-ink text-sm font-medium">
        {label}
        {required ? (
          <span className="text-bad ml-0.5" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {error ? (
        <p className="text-bad text-xs font-medium">{error}</p>
      ) : hint ? (
        <p className="text-muted text-xs">{hint}</p>
      ) : null}
    </div>
  )
}
