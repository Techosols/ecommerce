import { useMemo, useState } from 'react'
import { KeyRound, Mail, ShieldCheck, UserPlus } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { PageHeader } from '@/components/ui/PageHeader'
import { Pagination } from '@/components/ui/Pagination'
import { DataTable, type Column } from '@/components/ui/Table'
import { Tooltip } from '@/components/ui/Tooltip'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import {
  useInviteStaff,
  useResendInvitation,
  useRoles,
  useSetStaffRoles,
  useSetStaffStatus,
  useStaff,
} from '../hooks/settings.hooks'
import type { Role, StaffMember } from '../types/settings.types'

/** Owner first: the list reads as a hierarchy, which is what it is. */
const ROLE_ORDER = ['owner', 'admin', 'staff', 'customer']

function sortRoles(roles: string[]): string[] {
  return [...roles].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))
}

function nameOf(member: StaffMember): string {
  const name = [member.firstName, member.lastName].filter(Boolean).join(' ')
  return name || member.email
}

/**
 * Who can get in, and what each of them may do.
 *
 * Two things this screen is careful about:
 *
 *   • **Nobody is deleted.** An account that has approved a refund is named by
 *     the audit trail for good, so the only removal is `disabled` — which
 *     revokes its sessions server-side in the same call, rather than leaving
 *     someone signed in with a token issued before they were let go.
 *   • **A role is its permissions.** Choosing "admin" from a dropdown tells an
 *     operator nothing, so the invite dialog and the role reference both spell
 *     out what the role actually grants.
 */
export function StaffPage() {
  const { can, user } = useAuth()
  const { toast } = useToast()
  useDocumentTitle('Staff')

  const [page, setPage] = useState(1)
  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState<StaffMember | null>(null)
  const [disabling, setDisabling] = useState<StaffMember | null>(null)

  const staff = useStaff({ page, limit: 20 })
  const roles = useRoles()
  const setStatus = useSetStaffStatus()
  const resend = useResendInvitation()

  const canWrite = can('staff:write')
  const canAssign = can('roles:assign')

  const columns = useMemo<Array<Column<StaffMember>>>(
    () => [
      {
        id: 'person',
        header: 'Person',
        cell: (row) => (
          <div className="min-w-0">
            <span className="text-ink block truncate font-medium">
              {nameOf(row)}
              {row.id === user?.id ? <span className="text-faint text-xs"> · you</span> : null}
            </span>
            <span className="text-faint block truncate text-xs">{row.email}</span>
          </div>
        ),
      },
      {
        id: 'roles',
        header: 'Roles',
        width: '14rem',
        cell: (row) => (
          <span className="flex flex-wrap gap-1">
            {sortRoles(row.roles).map((role) => (
              <Badge key={role} size="sm" tone={role === 'owner' ? 'brand' : 'neutral'}>
                {role}
              </Badge>
            ))}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        width: '10rem',
        hideBelow: 'sm',
        cell: (row) => {
          if (row.status === 'disabled') return <Badge tone="danger">Disabled</Badge>
          // Invited but never signed in: the account exists and has no password
          // until they use their link, which is a different thing from active.
          if (!row.emailVerified) return <Badge tone="warning">Invited</Badge>
          return <Badge tone="positive">Active</Badge>
        },
      },
      {
        id: 'lastLogin',
        header: 'Last signed in',
        width: '11rem',
        hideBelow: 'md',
        cell: (row) =>
          row.lastLoginAt ? (
            <Tooltip label={formatDateTime(row.lastLoginAt)}>
              <span className="text-muted text-sm">{formatRelativeTime(row.lastLoginAt)}</span>
            </Tooltip>
          ) : (
            <span className="text-faint text-xs">Never</span>
          ),
      },
      {
        id: 'actions',
        header: '',
        width: '15rem',
        align: 'right',
        cell: (row) => (
          <span className="flex justify-end gap-1">
            {canAssign ? (
              <Button variant="ghost" size="sm" onClick={() => setEditing(row)}>
                Roles
              </Button>
            ) : null}
            {canWrite && !row.emailVerified && row.status !== 'disabled' ? (
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<Mail className="size-3.5" />}
                onClick={() =>
                  resend.mutate(row.id, {
                    onSuccess: () => toast({ tone: 'success', title: 'Invitation sent again' }),
                    onError: (error) =>
                      toast({
                        tone: 'error',
                        title: 'Could not resend',
                        description: messageOf(error),
                      }),
                  })
                }
              >
                Resend
              </Button>
            ) : null}
            {canWrite && row.id !== user?.id ? (
              row.status === 'disabled' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setStatus.mutate(
                      { id: row.id, status: 'active' },
                      {
                        onSuccess: () => toast({ tone: 'success', title: 'Account restored' }),
                        onError: (error) =>
                          toast({
                            tone: 'error',
                            title: 'Could not restore',
                            description: messageOf(error),
                          }),
                      },
                    )
                  }
                >
                  Restore
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="hover:text-danger"
                  onClick={() => setDisabling(row)}
                >
                  Disable
                </Button>
              )
            ) : null}
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canAssign, canWrite, user?.id],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Staff"
        description="Who can sign in to this admin, and what each of them may do."
        actions={
          canWrite ? (
            <Button
              variant="primary"
              leadingIcon={<UserPlus className="size-4" />}
              onClick={() => setInviting(true)}
            >
              Invite someone
            </Button>
          ) : undefined
        }
      />

      <Card>
        <QueryBoundary
          isLoading={staff.isPending}
          error={staff.error}
          onRetry={() => void staff.refetch()}
        >
          <DataTable
            columns={columns}
            rows={staff.data?.items ?? []}
            getRowId={(row) => row.id}
            caption="Staff accounts"
          />
          {staff.data && staff.data.pagination.totalPages > 1 ? (
            <div className="border-line border-t px-4 py-3 sm:px-5">
              <Pagination pagination={staff.data.pagination} onPageChange={setPage} />
            </div>
          ) : null}
        </QueryBoundary>
      </Card>

      <RolesReference roles={roles.data ?? []} />

      {inviting ? (
        <InviteDialog roles={roles.data ?? []} onClose={() => setInviting(false)} />
      ) : null}

      {editing ? (
        <RolesDialog member={editing} roles={roles.data ?? []} onClose={() => setEditing(null)} />
      ) : null}

      <ConfirmDialog
        isOpen={disabling !== null}
        onCancel={() => setDisabling(null)}
        onConfirm={() => {
          if (!disabling) return
          setStatus.mutate(
            { id: disabling.id, status: 'disabled' },
            {
              onSuccess: () => {
                toast({ tone: 'success', title: 'Account disabled' })
                setDisabling(null)
              },
              onError: (error) => {
                toast({
                  tone: 'error',
                  title: 'Could not disable',
                  description: messageOf(error),
                })
                setDisabling(null)
              },
            },
          )
        }}
        title={`Disable ${disabling ? nameOf(disabling) : ''}?`}
        confirmLabel="Disable the account"
        tone="danger"
        isLoading={setStatus.isPending}
      >
        They are signed out everywhere immediately and cannot sign back in. Nothing they did is
        removed — the audit trail still names them — and you can restore the account later.
      </ConfirmDialog>
    </div>
  )
}

/**
 * What each role can actually do.
 *
 * Present because the alternative is an operator choosing between "admin" and
 * "staff" by guessing, and the difference is whether somebody can issue
 * refunds.
 */
function RolesReference({ roles }: { roles: Role[] }) {
  const staffRoles = roles.filter((role) => role.key !== 'customer')
  if (staffRoles.length === 0) return null

  return (
    <Card>
      <CardHeader
        title="What the roles mean"
        description="Set on the server. Every screen in this admin checks these, not what the menu shows."
      />
      <CardBody>
        <ul className="divide-line divide-y">
          {staffRoles.map((role) => (
            <li key={role.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:gap-4">
              <div className="sm:w-48 sm:shrink-0">
                <span className="text-ink flex items-center gap-1.5 font-medium">
                  <ShieldCheck className="text-muted size-3.5" />
                  {role.name}
                </span>
                <span className="text-muted block text-xs">{role.description}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {role.permissions.length === 0 ? (
                  <span className="text-faint text-xs">No admin permissions.</span>
                ) : (
                  role.permissions.map((permission) => (
                    <Badge key={permission} size="sm" tone="neutral">
                      {permission}
                    </Badge>
                  ))
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}

function RoleChoices({
  roles,
  selected,
  onChange,
  disabled,
}: {
  roles: Role[]
  selected: string[]
  onChange: (roles: string[]) => void
  disabled?: boolean
}) {
  const assignable = roles.filter((role) => role.key !== 'customer')

  return (
    <div className="flex flex-col gap-2">
      {assignable.map((role) => (
        <label
          key={role.key}
          className="border-line hover:bg-surface-hover flex cursor-pointer items-start gap-3 rounded-md border p-3"
        >
          <Checkbox
            checked={selected.includes(role.key)}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, role.key]
                  : selected.filter((key) => key !== role.key),
              )
            }
          />
          <span className="min-w-0">
            <span className="text-ink block text-sm font-medium">{role.name}</span>
            <span className="text-muted block text-xs">{role.description}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

function InviteDialog({ roles, onClose }: { roles: Role[]; onClose: () => void }) {
  const { toast } = useToast()
  const invite = useInviteStaff()

  const [email, setEmail] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [selected, setSelected] = useState<string[]>(['staff'])

  const ready = email.trim() !== '' && selected.length > 0

  function submit() {
    if (!ready || invite.isPending) return
    invite.mutate(
      {
        email: email.trim(),
        roles: selected,
        ...(firstName.trim() ? { firstName: firstName.trim() } : {}),
        ...(lastName.trim() ? { lastName: lastName.trim() } : {}),
      },
      {
        onSuccess: () => {
          toast({ tone: 'success', title: 'Invitation sent' })
          onClose()
        },
        onError: (error) =>
          toast({ tone: 'error', title: 'Could not invite', description: messageOf(error) }),
      },
    )
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Invite someone"
      description="They set their own password from a single-use link. You never see or send one."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} isLoading={invite.isPending} onClick={submit}>
            Send invitation
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Email" required>
          <Input
            type="email"
            value={email}
            placeholder="sam@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name">
            <Input value={firstName} onChange={(event) => setFirstName(event.target.value)} />
          </Field>
          <Field label="Last name">
            <Input value={lastName} onChange={(event) => setLastName(event.target.value)} />
          </Field>
        </div>

        <Field label="Roles" required hint="At least one. They add up — nothing subtracts.">
          <RoleChoices roles={roles} selected={selected} onChange={setSelected} />
        </Field>
      </div>
    </Modal>
  )
}

function RolesDialog({
  member,
  roles,
  onClose,
}: {
  member: StaffMember
  roles: Role[]
  onClose: () => void
}) {
  const { toast } = useToast()
  const setRoles = useSetStaffRoles()
  const [selected, setSelected] = useState<string[]>(member.roles)

  const changed =
    selected.length !== member.roles.length || selected.some((role) => !member.roles.includes(role))
  const losingLastOwner = member.roles.includes('owner') && !selected.includes('owner')

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Roles for ${nameOf(member)}`}
      description="Takes effect on their next request, not their next sign-in."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!changed || selected.length === 0}
            isLoading={setRoles.isPending}
            onClick={() =>
              setRoles.mutate(
                { id: member.id, roles: selected },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Roles updated' })
                    onClose()
                  },
                  onError: (error) =>
                    toast({
                      tone: 'error',
                      title: 'Could not change the roles',
                      description: messageOf(error),
                    }),
                },
              )
            }
          >
            Save roles
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <RoleChoices roles={roles} selected={selected} onChange={setSelected} />

        {losingLastOwner ? (
          <p className="text-warning flex items-start gap-2 text-xs">
            <KeyRound className="mt-0.5 size-3.5 shrink-0" />
            {/* The server refuses to remove the last owner outright; this is
                the warning for the case where it will succeed. */}
            Removing the owner role takes away their ability to manage staff and read the audit
            trail. If they are the last owner, the server will refuse.
          </p>
        ) : null}
      </div>
    </Modal>
  )
}
