import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { PageHeader } from '@/components/ui/PageHeader'
import { Switch } from '@/components/ui/Switch'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useStoreCurrency } from '@/features/settings/store.hooks'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { useFormState } from '@/lib/useFormState'
import { DiscountScopeCard } from '../components/DiscountScopeCard'
import { RedemptionsCard } from '../components/RedemptionsCard'
import {
  STATUS_LABELS,
  STATUS_TONES,
  TYPE_LABELS,
  bpsToPercent,
  describeUsage,
  percentToBps,
} from '../components/discountLabels'
import { useArchiveDiscount, useDiscount, useUpdateDiscount } from '../hooks/discounts.hooks'
import type { DiscountDetail } from '../types/discounts.types'

interface Values extends Record<string, unknown> {
  title: string
  percent: string
  amountCents: number | null
  minSubtotalCents: number
  startsAt: string
  endsAt: string
  usageLimitTotal: string
  usageLimitPerCustomer: string
  requiresCustomer: boolean
  isActive: boolean
}

/** A datetime the server sends → the `datetime-local` an input takes. */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toIso(local: string): string | null {
  return local === '' ? null : new Date(local).toISOString()
}

function toValues(discount: DiscountDetail): Values {
  return {
    title: discount.title,
    percent: discount.type === 'percentage' ? bpsToPercent(discount.value) : '',
    amountCents: discount.type === 'fixed_amount' ? discount.value : null,
    minSubtotalCents: discount.minSubtotalCents,
    startsAt: toLocalInput(discount.startsAt),
    endsAt: toLocalInput(discount.endsAt),
    usageLimitTotal: discount.usageLimitTotal === null ? '' : String(discount.usageLimitTotal),
    usageLimitPerCustomer:
      discount.usageLimitPerCustomer === null ? '' : String(discount.usageLimitPerCustomer),
    requiresCustomer: discount.requiresCustomer,
    isActive: discount.isActive,
  }
}

/**
 * One discount.
 *
 * Read down: what it is and whether it is working, then the terms, then what it
 * applies to, then what it has actually cost. The last of those is the one a
 * console usually leaves out — `usageCount` says a code was used, and the
 * ledger says what for.
 *
 * The code and the type are shown and never editable. An order citing SUMMER25
 * as a percentage has to keep meaning that, so retyping a live code is a new
 * code rather than an edit, and the page says so rather than presenting a
 * disabled input with no explanation.
 */
export function DiscountDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { can } = useAuth()

  const query = useDiscount(id)
  const discount = query.data

  useDocumentTitle(discount ? discount.code : 'Discount')

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to="/discounts"
          className="text-muted hover:text-ink inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-3.5" /> Discounts
        </Link>
      </div>

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {discount ? <DiscountView discount={discount} canWrite={can('discounts:write')} /> : null}
      </QueryBoundary>
    </div>
  )
}

function DiscountView({ discount, canWrite }: { discount: DiscountDetail; canWrite: boolean }) {
  const { toast } = useToast()
  const navigate = useNavigate()
  const currency = useStoreCurrency()
  const update = useUpdateDiscount(discount.id)
  const archive = useArchiveDiscount()
  const [archiving, setArchiving] = useState(false)

  const form = useFormState<Values>(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useMemo(() => toValues(discount), []),
  )

  useEffect(() => {
    if (!form.isDirty) form.reset(toValues(discount))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discount.id, discount.value, discount.title, discount.isActive])

  const disabled = !canWrite || update.isPending || discount.status === 'archived'
  const windowIsBackwards =
    form.values.startsAt !== '' &&
    form.values.endsAt !== '' &&
    new Date(form.values.startsAt) >= new Date(form.values.endsAt)
  const perCustomerNeedsAccount =
    form.values.usageLimitPerCustomer !== '' && !form.values.requiresCustomer

  function save() {
    if (!form.isDirty || update.isPending || windowIsBackwards) return

    const count = (value: string) => (value.trim() === '' ? null : Number(value))
    update.mutate(
      {
        title: form.values.title.trim(),
        ...(discount.type === 'percentage' ? { value: percentToBps(form.values.percent) } : {}),
        ...(discount.type === 'fixed_amount' ? { value: form.values.amountCents ?? 0 } : {}),
        minSubtotalCents: form.values.minSubtotalCents,
        startsAt: toIso(form.values.startsAt),
        endsAt: toIso(form.values.endsAt),
        usageLimitTotal: count(form.values.usageLimitTotal),
        usageLimitPerCustomer: count(form.values.usageLimitPerCustomer),
        requiresCustomer: form.values.requiresCustomer,
        isActive: form.values.isActive,
      },
      {
        onSuccess: (saved) => {
          toast({ tone: 'success', title: 'Discount saved' })
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
    <>
      <PageHeader
        title={discount.code}
        description={`${discount.title} · ${TYPE_LABELS[discount.type]}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONES[discount.status]}>{STATUS_LABELS[discount.status]}</Badge>
            {canWrite && discount.status !== 'archived' ? (
              <>
                <Button
                  variant="ghost"
                  className="hover:text-danger"
                  leadingIcon={<Trash2 className="size-4" />}
                  onClick={() => setArchiving(true)}
                >
                  Archive
                </Button>
                {form.isDirty ? (
                  <Button variant="secondary" onClick={() => form.reset(toValues(discount))}>
                    Discard
                  </Button>
                ) : null}
                <Button
                  variant="primary"
                  disabled={!form.isDirty || windowIsBackwards}
                  isLoading={update.isPending}
                  onClick={save}
                >
                  Save changes
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      {discount.status === 'archived' ? (
        <Alert tone="info" title="This discount is archived">
          It cannot be used or changed. The orders that used it still name it, which is why it is
          kept rather than deleted.
        </Alert>
      ) : null}

      {discount.status === 'exhausted' ? (
        <Alert tone="warning" title="This code has run out">
          It has been used {discount.usageCount} times, which is its limit. Raise the limit below to
          let it work again.
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader
              title="Terms"
              description="What it takes off, and the least a basket has to be worth."
            />
            <CardBody className="flex flex-col gap-4">
              <Field label="Name" required error={form.errors.title}>
                <Input
                  disabled={disabled}
                  value={form.values.title}
                  onChange={(event) => form.setValue('title', event.target.value)}
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                {discount.type === 'percentage' ? (
                  <Field label="Percent off" required error={form.errors.value}>
                    <div className="relative">
                      <Input
                        type="number"
                        min={0.01}
                        max={100}
                        step={0.01}
                        disabled={disabled}
                        value={form.values.percent}
                        onChange={(event) => form.setValue('percent', event.target.value)}
                        className="pr-7"
                      />
                      <span className="text-faint pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm">
                        %
                      </span>
                    </div>
                  </Field>
                ) : null}

                {discount.type === 'fixed_amount' ? (
                  <Field label="Amount off" required error={form.errors.value}>
                    <MoneyInput
                      currency={currency}
                      disabled={disabled}
                      value={form.values.amountCents}
                      onValueChange={(amount) => form.setValue('amountCents', amount)}
                    />
                  </Field>
                ) : null}

                {discount.type === 'free_shipping' ? (
                  <Field label="Takes off">
                    <p className="text-muted pt-2 text-sm">
                      The delivery charge, whatever it comes to.
                    </p>
                  </Field>
                ) : null}

                <Field
                  label="Minimum basket"
                  hint="Blank or zero means any basket qualifies."
                  error={form.errors.minSubtotalCents}
                >
                  <MoneyInput
                    currency={currency}
                    disabled={disabled}
                    value={form.values.minSubtotalCents}
                    onValueChange={(amount) => form.setValue('minSubtotalCents', amount ?? 0)}
                  />
                </Field>
              </div>

              <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
                <div>
                  <p className="text-ink text-sm font-medium">Live</p>
                  <p className="text-muted mt-0.5 text-xs">
                    Off means the code is refused, whatever its dates say.
                  </p>
                </div>
                <Switch
                  checked={form.values.isActive}
                  disabled={disabled}
                  label="Live"
                  onCheckedChange={(checked) => form.setValue('isActive', checked)}
                />
              </div>
            </CardBody>
          </Card>

          <DiscountScopeCard
            discount={discount}
            canWrite={canWrite && discount.status !== 'archived'}
          />

          <RedemptionsCard discountId={discount.id} />
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="When it runs" description="Leave either end open." />
            <CardBody className="flex flex-col gap-4">
              <Field label="Starts" hint="Blank means it is live now.">
                <Input
                  type="datetime-local"
                  disabled={disabled}
                  value={form.values.startsAt}
                  onChange={(event) => form.setValue('startsAt', event.target.value)}
                />
              </Field>

              <Field
                label="Ends"
                hint="Blank means it runs until you switch it off."
                error={windowIsBackwards ? 'It has to end after it starts.' : form.errors.endsAt}
              >
                <Input
                  type="datetime-local"
                  disabled={disabled}
                  invalid={windowIsBackwards}
                  value={form.values.endsAt}
                  onChange={(event) => form.setValue('endsAt', event.target.value)}
                />
              </Field>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="How often it can be used" description={describeUsage(discount)} />
            <CardBody className="flex flex-col gap-4">
              <Field
                label="Total uses"
                hint="Blank means no limit. Below what it has already been used cannot be saved."
                error={form.errors.usageLimitTotal}
              >
                <Input
                  type="number"
                  min={1}
                  step={1}
                  disabled={disabled}
                  placeholder="No limit"
                  value={form.values.usageLimitTotal}
                  onChange={(event) => form.setValue('usageLimitTotal', event.target.value)}
                />
              </Field>

              <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
                <div>
                  <p className="text-ink text-sm font-medium">Signed-in customers only</p>
                  <p className="text-muted mt-0.5 text-xs">
                    A guest leaves no account to count against, so a per-customer limit needs this.
                  </p>
                </div>
                <Switch
                  checked={form.values.requiresCustomer}
                  disabled={disabled}
                  label="Signed-in customers only"
                  onCheckedChange={(checked) => form.setValue('requiresCustomer', checked)}
                />
              </div>

              <Field
                label="Uses per customer"
                hint="Blank means no per-customer limit."
                error={
                  perCustomerNeedsAccount
                    ? 'This cannot be counted for a guest — switch on signed-in customers only.'
                    : form.errors.usageLimitPerCustomer
                }
              >
                <Input
                  type="number"
                  min={1}
                  step={1}
                  disabled={disabled}
                  placeholder="No limit"
                  invalid={perCustomerNeedsAccount}
                  value={form.values.usageLimitPerCustomer}
                  onChange={(event) => form.setValue('usageLimitPerCustomer', event.target.value)}
                />
              </Field>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Fixed at creation" description="Changing either is a new code." />
            <CardBody className="flex flex-col gap-3">
              <div>
                <p className="text-faint text-xs">Code</p>
                <p className="text-ink font-medium">{discount.code}</p>
              </div>
              <div>
                <p className="text-faint text-xs">Takes off</p>
                <p className="text-ink text-sm">{TYPE_LABELS[discount.type]}</p>
              </div>
              <p className="text-muted text-xs">
                An order that used this code records it and its terms as they were. Retyping either
                would leave those orders describing something that no longer exists.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        isOpen={archiving}
        onCancel={() => setArchiving(false)}
        onConfirm={() =>
          archive.mutate(discount.id, {
            onSuccess: () => {
              toast({ tone: 'success', title: 'Discount archived' })
              setArchiving(false)
              void navigate('/discounts')
            },
            onError: (error) => {
              toast({ tone: 'error', title: 'Could not archive', description: messageOf(error) })
              setArchiving(false)
            },
          })
        }
        title={`Archive ${discount.code}?`}
        confirmLabel="Archive the discount"
        tone="danger"
        isLoading={archive.isPending}
      >
        It stops working immediately and cannot be changed afterwards. The{' '}
        {discount.usageCount > 0
          ? `${discount.usageCount} orders that used it keep naming it`
          : 'code is kept rather than deleted'}
        , which is why this archives rather than deletes.
      </ConfirmDialog>
    </>
  )
}
