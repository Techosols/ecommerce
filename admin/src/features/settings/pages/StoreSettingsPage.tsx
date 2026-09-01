import { useEffect, useMemo } from 'react'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/components/ui/PageHeader'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { formatDateTime } from '@/lib/format'
import { useFormState } from '@/lib/useFormState'
import { CashOnDeliveryCard } from '../components/CashOnDeliveryCard'
import { StoreLogoCard } from '../components/StoreLogoCard'
import { TaxCard } from '../components/TaxCard'
import { useStoreSettingsAdmin, useUpdateStoreSettings } from '../hooks/settings.hooks'
import type { StoreSettings } from '../types/settings.types'

interface Values extends Record<string, unknown> {
  storeName: string
  contactEmail: string
  supportUrl: string
  supportPhone: string
  currency: string
  timezone: string
  weightUnit: 'g' | 'kg' | 'lb' | 'oz'
  taxRateBps: number
  pricesIncludeTax: boolean
  defaultLowStockThreshold: number
  orderNumberPrefix: string
  reservationTtlMinutes: number
  guestCheckoutEnabled: boolean
  codEnabled: boolean
  codMinSubtotalCents: number
  codMaxSubtotalCents: number | null
  codFeeCents: number
  codCountryCodes: string[]
  codRequiresAccount: boolean
  codMaxOpenOrders: number | null
  orderReservationHours: number
}

function toValues(settings: StoreSettings): Values {
  return {
    storeName: settings.storeName,
    contactEmail: settings.contactEmail,
    supportUrl: settings.supportUrl ?? '',
    supportPhone: settings.supportPhone ?? '',
    currency: settings.currency,
    timezone: settings.timezone,
    weightUnit: settings.weightUnit,
    taxRateBps: settings.taxRateBps,
    pricesIncludeTax: settings.pricesIncludeTax,
    defaultLowStockThreshold: settings.defaultLowStockThreshold,
    orderNumberPrefix: settings.orderNumberPrefix,
    reservationTtlMinutes: settings.reservationTtlMinutes,
    guestCheckoutEnabled: settings.guestCheckoutEnabled,
    codEnabled: settings.codEnabled,
    codMinSubtotalCents: settings.codMinSubtotalCents,
    codMaxSubtotalCents: settings.codMaxSubtotalCents,
    codFeeCents: settings.codFeeCents,
    codCountryCodes: settings.codCountryCodes,
    codRequiresAccount: settings.codRequiresAccount,
    codMaxOpenOrders: settings.codMaxOpenOrders,
    orderReservationHours: settings.orderReservationHours,
  }
}

/** A short list rather than every IANA zone: these are the ones shops pick. */
const TIMEZONES = [
  'UTC',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Istanbul',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
]

/**
 * How the shop is set up.
 *
 * One page and one save, not a save button per card. These settings are read
 * together — the tax basis changes what a price means, the currency changes
 * what every figure on the page is denominated in — and an operator changing
 * two of them should not be able to end up having saved one.
 *
 * Nothing here is applied optimistically. The response is the new state, so a
 * value the server normalised (a trimmed prefix, an upper-cased currency) is
 * what the form shows afterwards rather than what was typed.
 */
export function StoreSettingsPage() {
  const { can } = useAuth()
  const query = useStoreSettingsAdmin()
  useDocumentTitle('Store settings')

  return (
    <QueryBoundary
      isLoading={query.isPending}
      error={query.error}
      onRetry={() => void query.refetch()}
    >
      {query.data ? <SettingsForm settings={query.data} canWrite={can('settings:write')} /> : null}
    </QueryBoundary>
  )
}

function SettingsForm({ settings, canWrite }: { settings: StoreSettings; canWrite: boolean }) {
  const { toast } = useToast()
  const update = useUpdateStoreSettings()
  const form = useFormState<Values>(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useMemo(() => toValues(settings), []),
  )

  // Re-baseline on a refetch, but never over an unsaved edit.
  useEffect(() => {
    if (!form.isDirty) form.reset(toValues(settings))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.updatedAt])

  const disabled = !canWrite || update.isPending
  const blank = (value: string) => (value.trim() === '' ? null : value.trim())

  function save() {
    if (!form.isDirty || update.isPending) return

    update.mutate(
      {
        storeName: form.values.storeName.trim(),
        contactEmail: form.values.contactEmail.trim(),
        supportUrl: blank(form.values.supportUrl),
        supportPhone: blank(form.values.supportPhone),
        currency: form.values.currency.trim().toUpperCase(),
        timezone: form.values.timezone,
        weightUnit: form.values.weightUnit,
        taxRateBps: form.values.taxRateBps,
        pricesIncludeTax: form.values.pricesIncludeTax,
        defaultLowStockThreshold: form.values.defaultLowStockThreshold,
        orderNumberPrefix: form.values.orderNumberPrefix.trim(),
        reservationTtlMinutes: form.values.reservationTtlMinutes,
        guestCheckoutEnabled: form.values.guestCheckoutEnabled,
        codEnabled: form.values.codEnabled,
        codMinSubtotalCents: form.values.codMinSubtotalCents,
        codMaxSubtotalCents: form.values.codMaxSubtotalCents,
        codFeeCents: form.values.codFeeCents,
        codCountryCodes: form.values.codCountryCodes,
        codRequiresAccount: form.values.codRequiresAccount,
        codMaxOpenOrders: form.values.codMaxOpenOrders,
        orderReservationHours: form.values.orderReservationHours,
      },
      {
        onSuccess: (saved) => {
          toast({ tone: 'success', title: 'Settings saved' })
          form.reset(toValues(saved))
        },
        onError: (error) => {
          if (!form.applyServerError(error)) {
            toast({ tone: 'error', title: 'Could not save', description: messageOf(error) })
          }
        },
      },
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Store settings"
        description={
          settings.updatedAt
            ? `Last changed ${formatDateTime(settings.updatedAt)}`
            : 'How the shop is set up.'
        }
        actions={
          canWrite ? (
            <div className="flex items-center gap-2">
              {form.isDirty ? (
                <Button variant="ghost" onClick={() => form.reset(toValues(settings))}>
                  Discard
                </Button>
              ) : null}
              <Button
                variant="primary"
                disabled={!form.isDirty}
                isLoading={update.isPending}
                onClick={save}
              >
                Save changes
              </Button>
            </div>
          ) : undefined
        }
      />

      {form.formError ? (
        <p className="text-danger text-sm" role="alert">
          {form.formError}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader
              title="Store"
              description="What customers see on the storefront and in every email."
            />
            <CardBody className="flex flex-col gap-4">
              <Field label="Name" required error={form.errors.storeName}>
                <Input
                  disabled={disabled}
                  value={form.values.storeName}
                  onChange={(event) => form.setValue('storeName', event.target.value)}
                />
              </Field>

              <Field
                label="Contact email"
                required
                hint="Where customers reply. It signs every email the shop sends."
                error={form.errors.contactEmail}
              >
                <Input
                  type="email"
                  disabled={disabled}
                  value={form.values.contactEmail}
                  onChange={(event) => form.setValue('contactEmail', event.target.value)}
                />
              </Field>

              <Field label="Support page" error={form.errors.supportUrl}>
                <Input
                  type="url"
                  disabled={disabled}
                  placeholder="https://…"
                  value={form.values.supportUrl}
                  onChange={(event) => form.setValue('supportUrl', event.target.value)}
                />
              </Field>

              <Field label="Support phone" error={form.errors.supportPhone}>
                <Input
                  disabled={disabled}
                  value={form.values.supportPhone}
                  onChange={(event) => form.setValue('supportPhone', event.target.value)}
                />
              </Field>
            </CardBody>
          </Card>

          <StoreLogoCard logoMediaId={settings.logoMediaId} canWrite={canWrite} />

          <Card>
            <CardHeader
              title="Region and units"
              description="The currency every price is in, and the clock every timestamp is read against."
            />
            <CardBody className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Currency"
                  required
                  hint="Three letters, ISO 4217. Changing it does not convert existing prices."
                  error={form.errors.currency}
                >
                  <Input
                    disabled={disabled}
                    maxLength={3}
                    value={form.values.currency}
                    onChange={(event) =>
                      form.setValue('currency', event.target.value.toUpperCase())
                    }
                  />
                </Field>

                <Field label="Weight unit" hint="What product weights are entered in.">
                  <Select
                    disabled={disabled}
                    value={form.values.weightUnit}
                    onChange={(event) =>
                      form.setValue('weightUnit', event.target.value as Values['weightUnit'])
                    }
                    options={[
                      { value: 'g', label: 'Grams' },
                      { value: 'kg', label: 'Kilograms' },
                      { value: 'lb', label: 'Pounds' },
                      { value: 'oz', label: 'Ounces' },
                    ]}
                  />
                </Field>
              </div>

              <Field label="Time zone" error={form.errors.timezone}>
                <Select
                  disabled={disabled}
                  value={form.values.timezone}
                  onChange={(event) => form.setValue('timezone', event.target.value)}
                  options={[
                    ...(TIMEZONES.includes(form.values.timezone)
                      ? []
                      : [{ value: form.values.timezone, label: form.values.timezone }]),
                    ...TIMEZONES.map((zone) => ({ value: zone, label: zone.replace('_', ' ') })),
                  ]}
                />
              </Field>
            </CardBody>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <TaxCard
            taxRateBps={form.values.taxRateBps}
            pricesIncludeTax={form.values.pricesIncludeTax}
            currency={form.values.currency}
            disabled={disabled}
            onChange={(patch) => form.setValues(patch)}
          />

          <Card>
            <CardHeader
              title="Orders and checkout"
              description="How orders are numbered, and how long stock is held for someone who has not paid yet."
            />
            <CardBody className="flex flex-col gap-4">
              <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
                <div>
                  <p className="text-ink text-sm font-medium">Guest checkout</p>
                  <p className="text-muted mt-0.5 text-xs">
                    Off means a shopper must have an account before they can buy.
                  </p>
                </div>
                <Switch
                  checked={form.values.guestCheckoutEnabled}
                  disabled={disabled}
                  label="Guest checkout"
                  onCheckedChange={(checked) => form.setValue('guestCheckoutEnabled', checked)}
                />
              </div>

              <Field
                label="Order number prefix"
                hint="Prepended to every order number. Existing orders keep theirs."
                error={form.errors.orderNumberPrefix}
              >
                <Input
                  disabled={disabled}
                  maxLength={8}
                  placeholder="#"
                  value={form.values.orderNumberPrefix}
                  onChange={(event) => form.setValue('orderNumberPrefix', event.target.value)}
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Basket holds stock for"
                  hint="Minutes. A basket in checkout reserves its items this long."
                  error={form.errors.reservationTtlMinutes}
                >
                  <Input
                    type="number"
                    min={1}
                    max={43_200}
                    step={1}
                    disabled={disabled}
                    value={String(form.values.reservationTtlMinutes)}
                    onChange={(event) =>
                      form.setValue('reservationTtlMinutes', Number(event.target.value))
                    }
                  />
                </Field>

                <Field
                  label="Unpaid order holds stock for"
                  hint="Hours. Longer than the basket hold, or an order loses its stock while still live."
                  error={form.errors.orderReservationHours}
                >
                  <Input
                    type="number"
                    min={1}
                    max={2160}
                    step={1}
                    disabled={disabled}
                    value={String(form.values.orderReservationHours)}
                    onChange={(event) =>
                      form.setValue('orderReservationHours', Number(event.target.value))
                    }
                  />
                </Field>
              </div>

              <Field
                label="Low-stock warning at"
                hint="The default line. An item can override it on its own page."
                error={form.errors.defaultLowStockThreshold}
              >
                <Input
                  type="number"
                  min={0}
                  step={1}
                  disabled={disabled}
                  className="max-w-32"
                  value={String(form.values.defaultLowStockThreshold)}
                  onChange={(event) =>
                    form.setValue('defaultLowStockThreshold', Number(event.target.value))
                  }
                />
              </Field>
            </CardBody>
          </Card>

          <CashOnDeliveryCard
            currency={form.values.currency}
            disabled={disabled}
            values={{
              codEnabled: form.values.codEnabled,
              codMinSubtotalCents: form.values.codMinSubtotalCents,
              codMaxSubtotalCents: form.values.codMaxSubtotalCents,
              codFeeCents: form.values.codFeeCents,
              codCountryCodes: form.values.codCountryCodes,
              codRequiresAccount: form.values.codRequiresAccount,
              codMaxOpenOrders: form.values.codMaxOpenOrders,
            }}
            onChange={(patch) => form.setValues(patch)}
          />
        </div>
      </div>
    </div>
  )
}
