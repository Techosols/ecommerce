import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, LogOut, Monitor, Moon, Settings, Sun } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import {
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
} from '@/components/ui/DropdownMenu'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Badge } from '@/components/ui/Badge'
import { displayName, initialsOf } from '@/lib/format'
import { useAuth } from '@/features/auth/useAuth'
import { useTheme, type ThemeChoice } from '@/app/theme.context'

const themeOptions: Array<{ value: ThemeChoice; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

/**
 * Who is signed in, and the way out.
 *
 * The role badge is not decoration: staff, admin and owner see materially
 * different admins, and an operator who cannot find a page needs to know which
 * account they are using before they raise a ticket about it.
 */
export function UserMenu() {
  const { user, logout, can } = useAuth()
  const { choice, setChoice } = useTheme()
  const navigate = useNavigate()
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)

  if (!user) return null

  const name = displayName(user)
  const primaryRole = user.roles.find((role) => role !== 'customer') ?? user.roles[0] ?? 'staff'

  async function handleSignOut() {
    setIsSigningOut(true)
    await logout()
    setIsSigningOut(false)
    setConfirmingSignOut(false)
    void navigate('/login', { replace: true })
  }

  return (
    <>
      <DropdownMenu
        width="w-64"
        trigger={({ ref, ...props }) => (
          <button
            ref={ref}
            type="button"
            className="hover:bg-ink dark:hover:bg-surface flex items-center gap-2 rounded-lg py-1 pr-2 pl-1 transition-colors"
            {...props}
          >
            <Avatar initials={initialsOf(user.firstName, user.lastName, user.email)} size="sm" />
            <span className="text-white dark:text-ink hidden max-w-32 truncate text-sm font-medium sm:block">
              {name}
            </span>
            <ChevronDown aria-hidden="true" className="text-faint size-4 shrink-0" />
          </button>
        )}
      >
        <>
          <div className="px-2.5 py-2">
            <p className="text-ink truncate text-sm font-medium">{name}</p>
            <p className="text-muted truncate text-xs">{user.email}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              <Badge tone="brand" size="sm">
                {primaryRole}
              </Badge>
              <Badge size="sm">{user.permissions.length} permissions</Badge>
            </div>
          </div>

          <DropdownSeparator />

          <DropdownLabel>Appearance</DropdownLabel>
          {themeOptions.map((option) => (
            <DropdownItem
              key={option.value}
              icon={<option.icon className="size-4" />}
              closeOnSelect={false}
              onSelect={() => setChoice(option.value)}
              className={choice === option.value ? 'bg-surface-hover text-ink' : undefined}
            >
              {option.label}
            </DropdownItem>
          ))}

          <DropdownSeparator />

          {can('settings:read') ? (
            <DropdownItem
              icon={<Settings className="size-4" />}
              onSelect={() => void navigate('/settings')}
            >
              Store settings
            </DropdownItem>
          ) : null}

          <DropdownItem
            tone="danger"
            icon={<LogOut className="size-4" />}
            onSelect={() => setConfirmingSignOut(true)}
          >
            Sign out
          </DropdownItem>
        </>
      </DropdownMenu>

      <ConfirmDialog
        isOpen={confirmingSignOut}
        onCancel={() => setConfirmingSignOut(false)}
        onConfirm={() => void handleSignOut()}
        title="Sign out?"
        confirmLabel="Sign out"
        tone="danger"
        isLoading={isSigningOut}
      >
        This ends the session on this device. Any unsaved work in an open form will be lost.
      </ConfirmDialog>
    </>
  )
}
