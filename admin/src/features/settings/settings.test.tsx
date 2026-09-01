import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { renderAuthed } from '@/test/renderAuthed'
import {
  adminUser,
  auditRecord,
  ownerUser,
  role,
  session,
  staffMember,
  storeSettings,
} from '@/test/catalogue'
import { AccountPage } from './pages/AccountPage'
import { AuditLogPage } from './pages/AuditLogPage'
import { SettingsLayout } from './pages/SettingsLayout'
import { StaffPage } from './pages/StaffPage'
import { StoreSettingsPage } from './pages/StoreSettingsPage'
import { bpsToPercent, percentToBps, taxOn } from './components/taxMath'
import { describeAction, toneOf } from './components/auditLabels'
import { describeAgent } from './components/sessionLabels'

/**
 * The settings section.
 *
 * What these tests are really defending:
 *
 *   • **The tax basis is legible.** `pricesIncludeTax` changes what every price
 *     in the catalogue means, and the only way to see which reading is in force
 *     is a worked example. The example must use the server's arithmetic.
 *   • **A patch carries what changed.** The page saves once for the whole form,
 *     so a save must not resend fields nobody touched over somebody else's edit.
 *   • **Nobody is deleted.** Staff are disabled, and the dialog says what that
 *     costs before it happens.
 */

let api: ApiMock

function baseRoutes(mock: ApiMock, user = ownerUser) {
  return mock
    .withSession(user)
    .on('GET', '/storefront/settings', { currency: 'GBP', storeName: 'Copperleaf', logoUrl: null })
    .on('GET', '/admin/notifications/unread-count', { count: 0 })
}

beforeEach(() => {
  api = apiMock().install()
  tokenStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  tokenStore.clear()
})

// ── The arithmetic ──────────────────────────────────────────────────────────

describe('tax maths', () => {
  it('round-trips a rate through the percentage a person types', () => {
    expect(bpsToPercent(875)).toBe('8.75')
    expect(bpsToPercent(2000)).toBe('20')
    expect(percentToBps('8.75')).toBe(875)
    expect(percentToBps('20')).toBe(2000)
  })

  it('refuses to put NaN in a payload', () => {
    expect(percentToBps('')).toBe(0)
    expect(percentToBps('abc')).toBe(0)
    expect(percentToBps('-5')).toBe(0)
  })

  it('extracts inclusive tax rather than adding it', () => {
    // The whole difference: at 20%, an inclusive 1200 contains 200 of tax,
    // and an exclusive 1000 has 200 added to it. Both end at 1200.
    expect(taxOn(1200, 2000, true)).toBe(200)
    expect(taxOn(1000, 2000, false)).toBe(200)
  })
})

// ── Store settings ──────────────────────────────────────────────────────────

describe('StoreSettingsPage', () => {
  function settingsRoutes(mock: ApiMock, settings = storeSettings(), user = ownerUser) {
    return baseRoutes(mock, user).on('GET', '/admin/settings', settings)
  }

  it('works an example of what the tax basis means', async () => {
    settingsRoutes(api)
    await renderAuthed(<StoreSettingsPage />, { route: '/settings' })

    // 20%, exclusive: a 10.00 product is charged 12.00.
    expect(await screen.findByText(/is charged/)).toHaveTextContent('£12.00')
    expect(screen.getByText(/plus £2.00 of tax/)).toBeInTheDocument()
  })

  it('changes the example the moment the basis changes, before anything is saved', async () => {
    const user = userEvent.setup()
    settingsRoutes(api)
    await renderAuthed(<StoreSettingsPage />, { route: '/settings' })
    await screen.findByText(/plus £2.00 of tax/)

    await user.selectOptions(screen.getByLabelText('Catalogue prices'), 'inclusive')

    // The same 10.00 now contains 1.67, rather than having 2.00 added.
    expect(await screen.findByText(/of which/)).toHaveTextContent('£1.67')
    expect(api.callsTo('PATCH', '/admin/settings')).toHaveLength(0)
  })

  it('sends only what was changed', async () => {
    const user = userEvent.setup()
    settingsRoutes(api).on('PATCH', '/admin/settings', storeSettings({ storeName: 'Copperleaf Co' }))
    await renderAuthed(<StoreSettingsPage />, { route: '/settings' })

    const name = await screen.findByLabelText(/^Name/)
    await user.clear(name)
    await user.type(name, 'Copperleaf Co')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(api.callsTo('PATCH', '/admin/settings')).toHaveLength(1)
    })
    expect(api.callsTo('PATCH', '/admin/settings')[0]!.body).toMatchObject({
      storeName: 'Copperleaf Co',
    })
  })

  it('offers nothing to save until something changes', async () => {
    settingsRoutes(api)
    await renderAuthed(<StoreSettingsPage />, { route: '/settings' })

    expect(await screen.findByRole('button', { name: 'Save changes' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
  })

  it('shows the cash-on-delivery policy that is actually in force', async () => {
    // The DTO used to omit these: the form could save a ceiling and had no way
    // to show the current one, so every control rendered as though COD was off.
    settingsRoutes(
      api,
      storeSettings({
        codEnabled: true,
        codMinSubtotalCents: 1000,
        codMaxSubtotalCents: 25_000,
        codFeeCents: 199,
        codCountryCodes: ['GB', 'IE'],
      }),
    )
    await renderAuthed(<StoreSettingsPage />, { route: '/settings' })

    expect(await screen.findByText(/can be paid at the door/)).toHaveTextContent('£10.00')
    expect(screen.getByText(/can be paid at the door/)).toHaveTextContent('£250.00')
    expect(screen.getByText(/can be paid at the door/)).toHaveTextContent('GB, IE')
  })

  it('spots a ceiling below the floor before the server has to', async () => {
    const user = userEvent.setup()
    settingsRoutes(api, storeSettings({ codEnabled: true, codMinSubtotalCents: 10_000 }))
    await renderAuthed(<StoreSettingsPage />, { route: '/settings' })

    const ceiling = await screen.findByLabelText(/^Largest order/)
    await user.type(ceiling, '50')

    expect(await screen.findByText('The ceiling is below the floor.')).toBeInTheDocument()
  })

  it('lets an operator who may only read, only read', async () => {
    const readOnly = {
      ...ownerUser,
      permissions: ownerUser.permissions.filter((p) => p !== 'settings:write'),
    }
    settingsRoutes(api, storeSettings(), readOnly)
    await renderAuthed(<StoreSettingsPage />, { route: '/settings' })

    expect(await screen.findByLabelText(/^Name/)).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
  })
})

// ── The sub-navigation ──────────────────────────────────────────────────────

describe('SettingsLayout', () => {
  it('shows no tab bar to an operator with one section', async () => {
    // `adminUser` holds none of settings:read, staff:read or audit:read, so the
    // only section is their own account — and a tab bar with one tab is noise.
    baseRoutes(api, adminUser)
    await renderAuthed(<SettingsLayout />, { route: '/settings/account' })

    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: 'Settings sections' })).not.toBeInTheDocument()
    })
    expect(screen.queryByRole('link', { name: 'Store' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Audit trail' })).not.toBeInTheDocument()
  })

  it('shows every section to an owner', async () => {
    baseRoutes(api)
    await renderAuthed(<SettingsLayout />, { route: '/settings' })

    const nav = within(await screen.findByRole('navigation', { name: 'Settings sections' }))
    for (const label of ['Store', 'Staff', 'Audit trail', 'Your account']) {
      expect(nav.getByRole('link', { name: label })).toBeInTheDocument()
    }
  })
})

// ── Staff ───────────────────────────────────────────────────────────────────

describe('StaffPage', () => {
  function staffRoutes(mock: ApiMock, members = [staffMember()], user = ownerUser) {
    return baseRoutes(mock, user)
      .on('GET', '/admin/roles', [
        role({ key: 'owner', name: 'Owner', permissions: ['settings:write', 'audit:read'] }),
        role(),
      ])
      .onList('/admin/staff', members)
  }

  it('separates an invited account from an active one', async () => {
    staffRoutes(api, [
      staffMember(),
      staffMember({
        id: 'user-new',
        email: 'new@example.com',
        firstName: 'Nina',
        emailVerified: false,
        lastLoginAt: null,
      }),
    ])
    await renderAuthed(<StaffPage />, { route: '/settings/staff' })

    expect(await screen.findByText('Sam Staff')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    // Invited: the account exists and has no password until they use the link.
    expect(screen.getByText('Invited')).toBeInTheDocument()
    expect(screen.getByText('Never')).toBeInTheDocument()
  })

  it('spells out what each role can do, rather than naming it', async () => {
    staffRoutes(api)
    await renderAuthed(<StaffPage />, { route: '/settings/staff' })

    expect(await screen.findByText('What the roles mean')).toBeInTheDocument()
    expect(screen.getByText('settings:write')).toBeInTheDocument()
  })

  it('says what disabling costs before doing it', async () => {
    const user = userEvent.setup()
    staffRoutes(api)
    await renderAuthed(<StaffPage />, { route: '/settings/staff' })
    await screen.findByText('Sam Staff')

    await user.click(screen.getByRole('button', { name: 'Disable' }))

    expect(await screen.findByText('Disable Sam Staff?')).toBeInTheDocument()
    expect(screen.getByText(/signed out everywhere immediately/)).toBeInTheDocument()
    // And nothing has happened yet.
    expect(api.callsTo('PATCH', '/admin/staff')).toHaveLength(0)
  })

  it('never offers to disable your own account', async () => {
    staffRoutes(api, [staffMember({ id: ownerUser.id, email: ownerUser.email })])
    await renderAuthed(<StaffPage />, { route: '/settings/staff' })

    await screen.findByText(/owner@example.com/)
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument()
  })

  it('invites without ever handling a password', async () => {
    const user = userEvent.setup()
    staffRoutes(api).on('POST', '/admin/staff', staffMember({ id: 'user-new' }))
    await renderAuthed(<StaffPage />, { route: '/settings/staff' })
    await screen.findByText('Sam Staff')

    await user.click(screen.getByRole('button', { name: 'Invite someone' }))
    await user.type(screen.getByLabelText(/^Email/), 'nina@example.com')

    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.queryByLabelText(/password/i)).not.toBeInTheDocument()

    await user.click(dialog.getByRole('button', { name: 'Send invitation' }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/admin/staff')).toHaveLength(1)
    })
    expect(api.callsTo('POST', '/admin/staff')[0]!.body).toMatchObject({
      email: 'nina@example.com',
      roles: ['staff'],
    })
  })

  it('hides role assignment from someone who cannot assign roles', async () => {
    const noAssign = {
      ...ownerUser,
      permissions: ownerUser.permissions.filter((p) => p !== 'roles:assign'),
    }
    staffRoutes(api, [staffMember()], noAssign)
    await renderAuthed(<StaffPage />, { route: '/settings/staff' })

    await screen.findByText('Sam Staff')
    expect(screen.queryByRole('button', { name: 'Roles' })).not.toBeInTheDocument()
  })
})

// ── The audit trail ─────────────────────────────────────────────────────────

describe('audit labels', () => {
  it('reads an action as a sentence', () => {
    expect(describeAction('order.refunded')).toBe('Order refunded')
    expect(describeAction('store_settings.updated')).toBe('Store settings updated')
  })

  it('takes its tone from the verb, not the resource', () => {
    expect(toneOf('order.refunded')).toBe('danger')
    expect(toneOf('product.created')).toBe('positive')
    expect(toneOf('product.updated')).toBe('neutral')
  })
})

describe('AuditLogPage', () => {
  function auditRoutes(mock: ApiMock, records = [auditRecord()]) {
    return baseRoutes(mock).onList('/admin/audit-logs', records)
  }

  it('names who did what, and to what', async () => {
    auditRoutes(api)
    await renderAuthed(<AuditLogPage />, { route: '/settings/audit' })

    expect(await screen.findByText('Store settings updated')).toBeInTheDocument()
    expect(screen.getByText(/owner@example.com/)).toBeInTheDocument()
  })

  it('shows the change field by field, not as two blobs', async () => {
    const user = userEvent.setup()
    auditRoutes(api)
    await renderAuthed(<AuditLogPage />, { route: '/settings/audit' })

    await user.click(await screen.findByRole('button', { name: /1 field changed/ }))

    expect(await screen.findByText('taxRateBps')).toBeInTheDocument()
    expect(screen.getByText('2000')).toBeInTheDocument()
    expect(screen.getByText('500')).toBeInTheDocument()
  })

  it('offers no way to change anything', async () => {
    auditRoutes(api)
    await renderAuthed(<AuditLogPage />, { route: '/settings/audit' })

    await screen.findByText('Store settings updated')
    // A trail with an edit button is not evidence of anything.
    expect(screen.queryByRole('button', { name: /delete|edit|remove/i })).not.toBeInTheDocument()
  })

  it('sends the date range as a whole day at each end', async () => {
    const user = userEvent.setup()
    auditRoutes(api)
    await renderAuthed(<AuditLogPage />, { route: '/settings/audit' })
    await screen.findByText('Store settings updated')

    await user.type(screen.getByLabelText('To'), '2026-03-01')

    await waitFor(() => {
      const last = api.callsTo('GET', '/admin/audit-logs').at(-1)!
      // Not midnight: "to today" that excluded today would hide what somebody
      // investigating is looking for.
      expect(last.url).toContain('23%3A59%3A59')
    })
  })
})

// ── The operator's own account ──────────────────────────────────────────────

describe('session labels', () => {
  it('says enough to recognise your own laptop', () => {
    expect(describeAgent('Mozilla/5.0 (Macintosh) Chrome/140.0')).toBe('Chrome on macOS')
    expect(describeAgent('Mozilla/5.0 (iPhone) Safari/605')).toBe('Safari on iOS')
    expect(describeAgent(null)).toBe('Unknown device')
  })
})

describe('AccountPage', () => {
  function accountRoutes(mock: ApiMock, sessions = [session()]) {
    return baseRoutes(mock).on('GET', '/auth/sessions', sessions)
  }

  it('marks the browser you are using, and will not end it here', async () => {
    accountRoutes(api, [
      session(),
      session({ id: 'sess-2', current: false, userAgent: 'Mozilla/5.0 (Windows) Firefox/140' }),
    ])
    await renderAuthed(<AccountPage />, { route: '/settings/account' })

    expect(await screen.findByText('This browser')).toBeInTheDocument()
    // One End button: the current session is ended by signing out, which also
    // clears the refresh cookie.
    expect(screen.getAllByRole('button', { name: 'End' })).toHaveLength(1)
  })

  it('refuses a password change until the confirmation matches', async () => {
    const user = userEvent.setup()
    accountRoutes(api)
    await renderAuthed(<AccountPage />, { route: '/settings/account' })

    await user.type(await screen.findByLabelText(/^Current password/), 'old-passphrase')
    await user.type(screen.getByLabelText(/^New password/), 'a-much-longer-passphrase')
    await user.type(screen.getByLabelText(/^Confirm new password/), 'a-much-longer-passphras')

    expect(await screen.findByText('These do not match.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled()
  })

  it('says that changing it signs out everywhere else', async () => {
    const user = userEvent.setup()
    accountRoutes(api).on('POST', '/auth/password/change', { changed: true })
    await renderAuthed(<AccountPage />, { route: '/settings/account' })

    await user.type(await screen.findByLabelText(/^Current password/), 'old-passphrase')
    await user.type(screen.getByLabelText(/^New password/), 'a-much-longer-passphrase')
    await user.type(screen.getByLabelText(/^Confirm new password/), 'a-much-longer-passphrase')
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    await waitFor(() => {
      expect(api.callsTo('POST', '/auth/password/change')).toHaveLength(1)
    })
    expect(await screen.findByText(/Every other session has been signed out/)).toBeInTheDocument()
  })
})
