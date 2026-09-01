import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Ban, CheckCircle2, RefreshCw, Users } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatCard } from '@/components/ui/StatCard'
import { Switch } from '@/components/ui/Switch'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useOrders } from '@/features/orders/hooks/orders.hooks'
import { OrderStatusBadge } from '@/features/orders/components/OrderStatusBadges'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { useFormState } from '@/lib/useFormState'
import { CustomerTagsCard } from '../components/CustomerTagsCard'
import { CustomerTimeline } from '../components/CustomerTimeline'
import { MarketingCard } from '../components/MarketingCard'
import { MergeDialog } from '../components/MergeDialog'
import { STATUS_LABELS, STATUS_TONES, customerName } from '../components/customerLabels'
import {
  useCustomer,
  useRecomputeMetrics,
  useSetCustomerStatus,
  useUpdateCustomer,
} from '../hooks/customers.hooks'
import type { CustomerAddress, CustomerDetail } from '../types/customers.types'

interface ProfileValues extends Record<string, unknown> {
  firstName: string
  lastName: string
  phone: string
  adminNote: string
  taxExempt: boolean
  locale: string
}

function toValues(customer: CustomerDetail): ProfileValues {
  return {
    firstName: customer.firstName ?? '',
    lastName: customer.lastName ?? '',
    phone: customer.phone ?? '',
    adminNote: customer.adminNote ?? '',
    taxExempt: customer.taxExempt,
    locale: customer.locale ?? '',
  }
}

/**
 * One customer, and everything a shop knows about them.
 *
 * The lifetime figures across the top are read, never derived: the browser has
 * this one record and none of its orders, and a total added up from a page of
 * orders would be wrong for anybody with more than a page.
 *
 * The order list below is the real orders list, filtered to this customer,
 * rather than a copy embedded in the customer record — one query, one shape,
 * and a link straight through to the order.
 */
export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { can } = useAuth()
  const { toast } = useToast()

  const query = useCustomer(id)
  const customer = query.data
  const canWrite = can('customers:write')

  useDocumentTitle(customer ? customerName(customer) : 'Customer')

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to="/customers"
          className="text-muted hover:text-ink inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-3.5" /> Customers
        </Link>
      </div>

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {customer ? (
          <CustomerDetailView
            customer={customer}
            canWrite={canWrite}
            canReadOrders={can('orders:read')}
            toast={toast}
          />
        ) : null}
      </QueryBoundary>
    </div>
  )
}

interface ViewProps {
  customer: CustomerDetail
  canWrite: boolean
  canReadOrders: boolean
  toast: ReturnType<typeof useToast>['toast']
}

function CustomerDetailView({ customer, canWrite, canReadOrders, toast }: ViewProps) {
  const update = useUpdateCustomer(customer.id)
  const setStatus = useSetCustomerStatus(customer.id)
  const recompute = useRecomputeMetrics(customer.id)

  const [isMergeOpen, setMergeOpen] = useState(false)
  const [pendingStatus, setPendingStatus] = useState<'active' | 'disabled' | null>(null)

  const form = useFormState<ProfileValues>(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useMemo(() => toValues(customer), []),
  )

  // Re-baseline when the record is refetched, but never over an unsaved edit.
  useEffect(() => {
    if (!form.isDirty) form.reset(toValues(customer))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer.id, customer.tags.join(' '), customer.marketing.email])

  const orders = useOrders({ page: 1, limit: 10, q: customer.email })

  function saveProfile() {
    if (update.isPending || !form.isDirty) return
    const blank = (value: string) => (value.trim() === '' ? null : value.trim())

    update.mutate(
      {
        firstName: blank(form.values.firstName),
        lastName: blank(form.values.lastName),
        phone: blank(form.values.phone),
        adminNote: blank(form.values.adminNote),
        taxExempt: form.values.taxExempt,
        locale: blank(form.values.locale),
      },
      {
        onSuccess: (saved) => {
          toast({ tone: 'success', title: 'Customer updated' })
          form.reset(toValues({ ...customer, ...saved }))
        },
        onError: (error) =>
          toast({ tone: 'error', title: 'Could not save', description: messageOf(error) }),
      },
    )
  }

  return (
    <>
      <PageHeader
        title={customerName(customer)}
        description={customer.email}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONES[customer.status]}>{STATUS_LABELS[customer.status]}</Badge>
            {customer.taxExempt ? <Badge tone="info">Tax exempt</Badge> : null}
            {!customer.emailVerified ? <Badge tone="warning">Email unverified</Badge> : null}

            {canWrite ? (
              <>
                <Button
                  variant="secondary"
                  leadingIcon={<Users className="size-4" />}
                  onClick={() => setMergeOpen(true)}
                >
                  Merge
                </Button>
                <Button
                  variant="secondary"
                  leadingIcon={
                    customer.status === 'active' ? (
                      <Ban className="size-4" />
                    ) : (
                      <CheckCircle2 className="size-4" />
                    )
                  }
                  onClick={() => setPendingStatus(customer.status === 'active' ? 'disabled' : 'active')}
                >
                  {customer.status === 'active' ? 'Disable account' : 'Enable account'}
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      {/* Read, not derived: the browser has this record and none of its orders. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total spent" value={formatMoney(customer.totalSpent)} />
        <StatCard label="Orders" value={String(customer.ordersCount)} />
        <StatCard label="Average order" value={formatMoney(customer.averageOrderValue)} />
        <StatCard
          label="Customer since"
          value={customer.firstOrderAt ? formatDate(customer.firstOrderAt) : 'Never ordered'}
          hint={customer.lastOrderAt ? `Last order ${formatDate(customer.lastOrderAt)}` : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader
              title="Details"
              description="What staff can change. The email address is the customer's identity and is not edited here."
            />
            <CardBody className="flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="First name">
                  <Input
                    value={form.values.firstName}
                    disabled={!canWrite}
                    onChange={(event) => form.setValue('firstName', event.target.value)}
                  />
                </Field>
                <Field label="Last name">
                  <Input
                    value={form.values.lastName}
                    disabled={!canWrite}
                    onChange={(event) => form.setValue('lastName', event.target.value)}
                  />
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Phone">
                  <Input
                    value={form.values.phone}
                    disabled={!canWrite}
                    onChange={(event) => form.setValue('phone', event.target.value)}
                  />
                </Field>
                <Field label="Locale" hint="Language tag, such as en-GB.">
                  <Input
                    value={form.values.locale}
                    disabled={!canWrite}
                    onChange={(event) => form.setValue('locale', event.target.value)}
                  />
                </Field>
              </div>

              <Field
                label="Note"
                hint="One pinned line whoever opens this record next should read first."
              >
                <Textarea
                  rows={2}
                  maxLength={2000}
                  value={form.values.adminNote}
                  disabled={!canWrite}
                  onChange={(event) => form.setValue('adminNote', event.target.value)}
                />
              </Field>

              <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
                <div>
                  <p className="text-ink text-sm font-medium">Tax exempt</p>
                  <p className="text-muted mt-0.5 text-xs">Charged no tax at checkout.</p>
                </div>
                <Switch
                  checked={form.values.taxExempt}
                  disabled={!canWrite}
                  onCheckedChange={(checked) => form.setValue('taxExempt', checked)}
                  label="Tax exempt"
                />
              </div>
            </CardBody>

            {canWrite && form.isDirty ? (
              <CardFooter className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => form.reset(toValues(customer))}>
                  Discard
                </Button>
                <Button isLoading={update.isPending} onClick={saveProfile}>
                  Save changes
                </Button>
              </CardFooter>
            ) : null}
          </Card>

          <Card>
            <CardHeader
              title="Orders"
              description="The ten most recent. Opens the order itself, not a copy."
            />
            <CardBody>
              {!canReadOrders ? (
                <p className="text-muted text-sm">You do not have permission to see orders.</p>
              ) : orders.data && orders.data.items.length > 0 ? (
                <ul className="divide-line divide-y">
                  {orders.data.items.map((order) => (
                    <li key={order.id}>
                      <Link
                        to={`/orders/${order.id}`}
                        className="hover:bg-surface-hover -mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2"
                      >
                        <span className="min-w-0">
                          <span className="text-ink block font-medium">{order.orderNumber}</span>
                          <span className="text-faint block text-xs">
                            {formatDateTime(order.placedAt)}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-3">
                          <OrderStatusBadge status={order.status} size="sm" />
                          <span className="text-ink tabular text-sm font-medium">
                            {formatMoney(order.total)}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted text-sm">This customer has not ordered yet.</p>
              )}
            </CardBody>
          </Card>

          <CustomerTimeline customerId={customer.id} canWrite={canWrite} />
        </div>

        <div className="flex flex-col gap-6">
          <MarketingCard customer={customer} canWrite={canWrite} />

          <CustomerTagsCard
            customerId={customer.id}
            tags={customer.tags}
            canWrite={canWrite}
          />

          <Card>
            <CardHeader title="Addresses" description="Their address book, newest first." />
            <CardBody className="flex flex-col gap-4">
              {customer.addresses.length === 0 ? (
                <p className="text-muted text-sm">No saved addresses.</p>
              ) : (
                customer.addresses.map((address) => (
                  <AddressBlock key={address.id} address={address} />
                ))
              )}
            </CardBody>
          </Card>

          {canWrite ? (
            <Card>
              <CardHeader
                title="Lifetime figures"
                description="Rebuilt from this customer's orders, for when the totals look wrong."
              />
              <CardBody>
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<RefreshCw className="size-3.5" />}
                  isLoading={recompute.isPending}
                  onClick={() =>
                    recompute.mutate(undefined, {
                      onSuccess: () => toast({ tone: 'success', title: 'Figures rebuilt' }),
                      onError: (error) =>
                        toast({
                          tone: 'error',
                          title: 'Could not rebuild',
                          description: messageOf(error),
                        }),
                    })
                  }
                >
                  Recalculate
                </Button>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>

      <MergeDialog
        survivor={customer}
        isOpen={isMergeOpen}
        onClose={() => setMergeOpen(false)}
      />

      <ConfirmDialog
        isOpen={pendingStatus !== null}
        onCancel={() => setPendingStatus(null)}
        onConfirm={() => {
          if (!pendingStatus) return
          setStatus.mutate(pendingStatus, {
            onSuccess: () => {
              toast({
                tone: 'success',
                title: pendingStatus === 'disabled' ? 'Account disabled' : 'Account enabled',
              })
              setPendingStatus(null)
            },
            onError: (error) => {
              toast({
                tone: 'error',
                title: 'Could not change the account',
                description: messageOf(error),
              })
              setPendingStatus(null)
            },
          })
        }}
        title={pendingStatus === 'disabled' ? 'Disable this account?' : 'Enable this account?'}
        confirmLabel={pendingStatus === 'disabled' ? 'Disable account' : 'Enable account'}
        tone={pendingStatus === 'disabled' ? 'danger' : 'primary'}
        isLoading={setStatus.isPending}
      >
        {pendingStatus === 'disabled' ? (
          <>
            They are signed out everywhere immediately and cannot order or sign in again. Their
            record, orders and history are untouched.
          </>
        ) : (
          <>They will be able to sign in and order again.</>
        )}
      </ConfirmDialog>

      {customer.status === 'locked' ? (
        <Alert tone="warning" title="This account is locked">
          Too many failed sign-in attempts. It unlocks itself, or the customer can reset their
          password.
        </Alert>
      ) : null}
    </>
  )
}

function AddressBlock({ address }: { address: CustomerAddress }) {
  return (
    <address className="text-ink-soft text-sm not-italic">
      <span className="text-ink flex items-center gap-2 font-medium">
        {address.firstName} {address.lastName}
        {address.isDefault ? (
          <Badge size="sm" tone="neutral">
            Default
          </Badge>
        ) : null}
      </span>
      {address.company ? <span className="block">{address.company}</span> : null}
      <span className="block">{address.line1}</span>
      {address.line2 ? <span className="block">{address.line2}</span> : null}
      <span className="block">
        {address.city}
        {address.region ? `, ${address.region}` : ''} {address.postalCode ?? ''}
      </span>
      <span className="block">{address.countryCode}</span>
      {address.phone ? <span className="text-muted mt-1 block text-xs">{address.phone}</span> : null}
    </address>
  )
}
