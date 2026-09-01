/**
 * Customers and their address books (CLAUDE.md §12).
 *
 * A customer is a `users` row with the `customer` role — there is no second
 * identity table, because two records of the same person always drift.
 *
 * The rule that shapes this file: **a customer may only ever reach their own
 * data.** Every address operation is scoped by `userId` from the Actor, never
 * from the request body, so a valid address id belonging to somebody else is
 * simply not found (§6.6, resource-level policy).
 */
import { v7 as uuidv7 } from 'uuid'
import { publish } from '../../events/index.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import type { Actor } from '../../shared/auth/actor.js'
import {
  ConflictError,
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
} from '../../shared/errors/index.js'
import { auditService } from '../audit/index.js'
import { usersService } from '../users/index.js'
import { customersRepository as repo } from './customers.repository.js'
import type {
  Address,
  AddressInput,
  AddressSnapshot,
  CustomerEvent,
  CustomerListFilter,
  CustomerSummary,
  MarketingState,
} from './customers.types.js'

const log = createLogger('customers')

/** Enough to be a real address book, few enough to bound the read. */
const MAX_ADDRESSES = 20

/** Marks a customer record the shop created at checkout rather than one a person opened. */
const GUEST_TAG = 'guest'

export const customersService = {
  // ── Admin surface ─────────────────────────────────────────────────────────

  async list(filter: CustomerListFilter): Promise<{ rows: CustomerSummary[]; total: number }> {
    return repo.list(filter)
  },

  async getById(userId: string): Promise<CustomerSummary> {
    const customer = await repo.findById(userId)
    if (!customer) throw new NotFoundError('Customer not found')
    return customer
  },

  /**
   * Enables or disables a customer account.
   *
   * Disabling revokes every session, so access ends now rather than whenever
   * the access token happens to expire (§6.3).
   */
  async setStatus(
    userId: string,
    status: 'active' | 'disabled',
    actor: Actor,
    revokeSessions: (userId: string, reason: string) => Promise<number>,
  ): Promise<CustomerSummary> {
    const before = await repo.findById(userId)
    if (!before) throw new NotFoundError('Customer not found')
    if (before.status === status) return before

    await withTransaction(async () => {
      await usersService.setStatusUnchecked(userId, status)
      await auditService.record({
        actor,
        action: 'customer.status_changed',
        resourceType: 'user',
        resourceId: userId,
        before: { status: before.status },
        after: { status },
      })
      await publish(
        'customer.status_changed',
        { userId, from: before.status, to: status, actorId: actor.userId },
        { aggregateId: userId, actorUserId: actor.userId },
      )
    })

    usersService.invalidateAccess(userId)
    if (status === 'disabled') await revokeSessions(userId, 'account_disabled')

    log.info({ userId, status, actorId: actor.userId }, 'customer status changed')
    return this.getById(userId)
  },

  // ── Profile, self-service ─────────────────────────────────────────────────

  /**
   * A customer editing their own details.
   *
   * Deliberately narrow: email changes go through verification, roles and
   * status are not the customer's to set, and a strict schema means they cannot
   * be smuggled in (§16.3).
   */
  async updateProfile(
    actor: Actor,
    patch: {
      firstName?: string | null
      lastName?: string | null
      phone?: string | null
      acceptsMarketing?: boolean
    },
  ): Promise<CustomerSummary> {
    const before = await repo.findById(actor.userId)
    if (!before) throw new NotFoundError('Customer not found')

    await repo.updateProfile(actor.userId, patch)
    usersService.invalidateAccess(actor.userId)

    if (patch.acceptsMarketing !== undefined && patch.acceptsMarketing !== before.acceptsMarketing) {
      // Consent changes are the ones anyone will later need to prove.
      await publish(
        'customer.marketing_consent_changed',
        { userId: actor.userId, acceptsMarketing: patch.acceptsMarketing },
        { aggregateId: actor.userId, actorUserId: actor.userId },
      )
    }
    return this.getById(actor.userId)
  },

  // ── Addresses ─────────────────────────────────────────────────────────────

  async listAddresses(userId: string): Promise<Address[]> {
    return repo.listAddresses(userId)
  },

  /** Scoped by owner: someone else's address id is simply not found. */
  async getAddress(userId: string, addressId: string): Promise<Address> {
    const address = await repo.findAddress(addressId)
    if (!address || address.userId !== userId || address.archivedAt) {
      throw new NotFoundError('Address not found')
    }
    return address
  },

  async createAddress(userId: string, input: AddressInput): Promise<Address> {
    const existing = await repo.countAddresses(userId)
    if (existing >= MAX_ADDRESSES) {
      throw new ConflictError(`An address book holds at most ${MAX_ADDRESSES} addresses`, {
        code: ERROR_CODES.DOMAIN_RULE_VIOLATION,
      })
    }

    // The first address is the default whether or not anyone said so, so
    // checkout always has something to pre-fill.
    const isDefault = input.isDefault ?? existing === 0

    return withTransaction(async () => {
      if (isDefault) await repo.clearDefaultAddress(userId)
      const address = await repo.createAddress({
        id: uuidv7(),
        userId,
        label: input.label ?? null,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        company: input.company ?? null,
        line1: input.line1.trim(),
        line2: input.line2 ?? null,
        city: input.city.trim(),
        region: input.region ?? null,
        postalCode: input.postalCode ?? null,
        countryCode: input.countryCode.toUpperCase(),
        phone: input.phone ?? null,
        isDefault,
      })
      await publish(
        'customer.address_added',
        { userId, addressId: address.id },
        { aggregateId: userId, actorUserId: userId },
      )
      return address
    })
  },

  async updateAddress(
    userId: string,
    addressId: string,
    patch: Partial<AddressInput>,
  ): Promise<Address> {
    const before = await this.getAddress(userId, addressId)

    const updated = await withTransaction(async () => {
      if (patch.isDefault === true && !before.isDefault) await repo.clearDefaultAddress(userId)
      const next: Record<string, unknown> = { ...patch }
      if (patch.countryCode) next.countryCode = patch.countryCode.toUpperCase()
      return repo.updateAddress(addressId, next)
    })

    if (!updated) throw new NotFoundError('Address not found')
    return updated
  },

  /**
   * Archives an address.
   *
   * Never deleted: an order placed to it keeps its own copy, but the address
   * book row may still be referenced by a draft or a support conversation, and
   * a hole in a customer's history helps nobody.
   */
  async archiveAddress(userId: string, addressId: string): Promise<void> {
    const address = await this.getAddress(userId, addressId)

    await withTransaction(async () => {
      await repo.archiveAddress(addressId)
      // Removing the default promotes the next one, so checkout is never left
      // with an address book and nothing selected.
      if (address.isDefault) {
        const remaining = await repo.listAddresses(userId)
        const next = remaining.find((candidate) => candidate.id !== addressId)
        if (next) await repo.updateAddress(next.id, { isDefault: true })
      }
    })
  },

  /**
   * Freezes an address into the shape an order stores.
   *
   * A copy, deliberately: a customer correcting their street next year must not
   * rewrite where last year's parcel went.
   */
  toSnapshot(address: Address): AddressSnapshot {
    return {
      firstName: address.firstName,
      lastName: address.lastName,
      company: address.company,
      line1: address.line1,
      line2: address.line2,
      city: address.city,
      region: address.region,
      postalCode: address.postalCode,
      countryCode: address.countryCode,
      phone: address.phone,
    }
  },

  /** Called when an order is paid, to keep lifetime figures current. */
  async recordPurchase(userId: string, totalCents: number, placedAt: Date): Promise<void> {
    await repo.recordPurchase(userId, totalCents, placedAt)
  },

  // ── CRM ───────────────────────────────────────────────────────────────────

  /**
   * Creates a customer from the admin.
   *
   * Three ways to give them access, and the caller says which: send them a link
   * to set a password, set one now, or create the record with no way in at all
   * — which is the right answer for somebody who only ever buys over the phone.
   */
  async create(
    input: {
      email: string
      firstName?: string | null
      lastName?: string | null
      phone?: string | null
      adminNote?: string | null
      tags?: string[]
      taxExempt?: boolean
      locale?: string | null
      marketingEmailState?: MarketingState
      access: 'invite' | 'password' | 'none'
      password?: string
    },
    actor: Actor,
    hooks: {
      hashPassword: (plain: string) => Promise<string>
      sendSetPasswordLink: (email: string) => Promise<void>
    },
  ): Promise<CustomerSummary> {
    const existing = await usersService.getByEmail(input.email)
    if (existing) {
      throw new ConflictError('An account with that email address already exists', {
        code: ERROR_CODES.EMAIL_ALREADY_REGISTERED,
      })
    }

    const created = await usersService.create({
      email: input.email,
      // No hash for `invite` or `none`: an account without one cannot be signed
      // into, which `login` already refuses.
      passwordHash: input.access === 'password' && input.password
        ? await hooks.hashPassword(input.password)
        : null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      roles: ['customer'],
    })

    await repo.updateAdmin(created.id, {
      ...(input.phone === undefined ? {} : { phone: input.phone }),
      ...(input.adminNote === undefined ? {} : { adminNote: input.adminNote }),
      ...(input.taxExempt === undefined ? {} : { taxExempt: input.taxExempt }),
      ...(input.locale === undefined ? {} : { locale: input.locale }),
    })
    if (input.tags?.length) await repo.addTags(created.id, input.tags)
    if (input.marketingEmailState) {
      await repo.setConsent(created.id, { channel: 'email', state: input.marketingEmailState })
    }

    await this.recordEvent(created.id, {
      kind: 'account.created_by_staff',
      body: null,
      actor,
      metadata: { access: input.access },
    })
    await auditService.record({
      actor,
      action: 'customer.created',
      resourceType: 'customer',
      resourceId: created.id,
      after: { email: input.email },
    })

    // After the record exists, so a mail failure leaves a customer rather than
    // nothing at all.
    if (input.access === 'invite') await hooks.sendSetPasswordLink(input.email)

    log.info({ customerId: created.id, access: input.access }, 'customer created')
    return this.getById(created.id)
  },

  /**
   * The customer behind a checkout, creating one if this email has never
   * bought here before.
   *
   * A guest order used to be a `customer_id` of NULL and an email held as a
   * loose string, which meant the same person buying three times was three
   * unrelated orders and nobody in the Customers list. This closes that: after
   * checkout, every order points at a customer record, whether or not the
   * shopper ever chose to register.
   *
   * **An existing account wins.** If the email already belongs to somebody, the
   * order joins their history rather than forking a second record of the same
   * person — the whole reason there is one identity table. That has a
   * deliberate consequence: a customer the shop has disabled cannot slip past
   * `assertCanOrder` by not logging in, because checkout now knows who they
   * are. It leaks nothing in the other direction; the shopper still sees only
   * what the guest order-lookup gives them, and holding somebody's email has
   * never been proof of holding their inbox.
   *
   * **The record cannot be signed into.** No password hash is written, which
   * `login` already refuses. Setting one is the shopper's own act, through the
   * ordinary reset-password flow — so a person who never registered still has
   * not, and their record is a shop's memory of them, not an account made in
   * their name.
   *
   * No marketing consent is recorded here under any circumstances. Typing an
   * email to receive a receipt is not a subscription, and checkout carries no
   * opt-in field to say otherwise.
   */
  async findForCheckout(email: string): Promise<string | null> {
    const existing = await usersService.getByEmail(email.trim().toLowerCase())
    return existing?.id ?? null
  },

  /**
   * Creates the customer record for an email that has never bought here.
   *
   * Called from inside the checkout transaction, so it rolls back with the
   * order. Never call it without first calling `findForCheckout` — it does not
   * check for an existing account, and `users.email` is unique, so a second
   * call for the same address is a constraint violation rather than a
   * duplicate.
   */
  async createForCheckout(input: {
    email: string
    firstName?: string | null
    lastName?: string | null
    phone?: string | null
  }): Promise<string> {
    const email = input.email.trim().toLowerCase()

    const created = await usersService.create({
      email,
      // Deliberately absent — see above.
      passwordHash: null,
      firstName: input.firstName?.trim() || null,
      lastName: input.lastName?.trim() || null,
      roles: ['customer'],
    })

    // Name and phone come off the shipping address, which is the only thing a
    // guest told us about themselves. `updateAdmin` rather than the create
    // call because phone is a customer-record column, not an identity one.
    if (input.phone?.trim()) {
      await repo.updateAdmin(created.id, { phone: input.phone.trim() })
    }

    // Tagged so staff can tell a record the shop made from one a person chose
    // to open. Removable, and never re-applied — a guest who later registers
    // and has the tag taken off keeps it off.
    await repo.addTags(created.id, [GUEST_TAG])

    // No actor: nobody did this, checkout did.
    await this.recordEvent(created.id, {
      kind: 'account.created_at_checkout',
      body: null,
      actor: null,
    })

    log.info({ customerId: created.id }, 'customer created at checkout')
    return created.id
  },

  async updateAdmin(
    customerId: string,
    patch: {
      firstName?: string | null
      lastName?: string | null
      phone?: string | null
      adminNote?: string | null
      taxExempt?: boolean
      locale?: string | null
    },
    actor: Actor,
  ): Promise<CustomerSummary> {
    const before = await this.getById(customerId)
    await repo.updateAdmin(customerId, patch)
    usersService.invalidateAccess(customerId)

    await auditService.record({
      actor,
      action: 'customer.updated',
      resourceType: 'customer',
      resourceId: customerId,
      before: { firstName: before.firstName, lastName: before.lastName, phone: before.phone },
      after: patch,
    })
    return this.getById(customerId)
  },

  async addTags(customerId: string, tags: string[], actor: Actor): Promise<CustomerSummary> {
    await this.getById(customerId)
    await repo.addTags(customerId, tags)
    await this.recordEvent(customerId, {
      kind: 'tags.added',
      body: null,
      actor,
      metadata: { tags },
    })
    return this.getById(customerId)
  },

  async removeTags(customerId: string, tags: string[], actor: Actor): Promise<CustomerSummary> {
    await this.getById(customerId)
    await repo.removeTags(customerId, tags)
    await this.recordEvent(customerId, {
      kind: 'tags.removed',
      body: null,
      actor,
      metadata: { tags },
    })
    return this.getById(customerId)
  },

  /**
   * Sets consent for one channel.
   *
   * Recorded on the timeline and in the audit log, because consent is the thing
   * a shop is most likely to have to prove, and "it says subscribed" is not an
   * answer to "when did they agree, and who changed it".
   */
  async setConsent(
    customerId: string,
    input: { channel: 'email' | 'sms'; state: MarketingState; optInLevel?: string | null },
    actor: Actor,
  ): Promise<CustomerSummary> {
    const before = await this.getById(customerId)
    await repo.setConsent(customerId, input)
    usersService.invalidateAccess(customerId)

    await this.recordEvent(customerId, {
      kind: 'marketing.consent_changed',
      body: null,
      actor,
      metadata: {
        channel: input.channel,
        from: input.channel === 'sms' ? before.marketingSmsState : before.marketingEmailState,
        to: input.state,
      },
    })
    await auditService.record({
      actor,
      action: 'customer.consent_changed',
      resourceType: 'customer',
      resourceId: customerId,
      before: { email: before.marketingEmailState, sms: before.marketingSmsState },
      after: { channel: input.channel, state: input.state },
    })
    return this.getById(customerId)
  },

  // ── Timeline ──────────────────────────────────────────────────────────────

  async events(customerId: string): Promise<CustomerEvent[]> {
    await this.getById(customerId)
    return repo.events(customerId)
  },

  /**
   * Writes one timeline entry.
   *
   * Used for staff notes and for system observations alike, which is the point:
   * one feed, so "we rang them" and "they placed an order" sit in the order
   * they actually happened rather than in two lists somebody has to interleave
   * by eye.
   */
  async recordEvent(
    customerId: string,
    input: {
      kind: string
      body: string | null
      actor: Actor | null
      metadata?: Record<string, unknown>
    },
  ): Promise<CustomerEvent> {
    return repo.insertEvent({
      id: uuidv7(),
      customerId,
      kind: input.kind,
      body: input.body,
      actorUserId: input.actor?.userId ?? null,
      // Snapshotted, so the entry still says who wrote it after the account goes.
      actorName: input.actor?.email ?? null,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })
  },

  async addNote(customerId: string, body: string, actor: Actor): Promise<CustomerEvent> {
    await this.getById(customerId)
    return this.recordEvent(customerId, { kind: 'note', body: body.trim(), actor })
  },

  async deleteNote(customerId: string, eventId: string, actor: Actor): Promise<void> {
    const removed = await repo.deleteNote(customerId, eventId)
    // Scoped to `kind = 'note'`, so a system observation cannot be deleted by
    // guessing its id — the timeline is evidence, and only the part a person
    // wrote is theirs to take back.
    if (removed === 0) throw new NotFoundError('Note not found')
    await auditService.record({
      actor,
      action: 'customer.note_deleted',
      resourceType: 'customer',
      resourceId: customerId,
      before: { eventId },
    })
  },

  // ── Merge ─────────────────────────────────────────────────────────────────

  /**
   * Folds a duplicate record into the one that survives.
   *
   * Orders, addresses and timeline entries are re-pointed rather than copied,
   * and the survivor's lifetime figures are **recomputed from the orders**
   * rather than added together — adding would double anything already counted
   * on both sides, and there is no way to tell afterwards.
   *
   * The duplicate is then deleted. That is the one destructive operation in the
   * customer surface, and it is why it refuses to run when the loser still has
   * anything the mover did not move.
   */
  async merge(survivorId: string, duplicateId: string, actor: Actor): Promise<CustomerSummary> {
    if (survivorId === duplicateId) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'A customer cannot be merged into themselves',
      )
    }

    const survivor = await this.getById(survivorId)
    const duplicate = await this.getById(duplicateId)

    await withTransaction(async () => {
      await repo.movePossessions(duplicateId, survivorId)
      // Tags and the note are worth keeping; they are the only fields somebody
      // typed that would otherwise be lost with the row.
      if (duplicate.tags.length > 0) await repo.addTags(survivorId, duplicate.tags)
      if (duplicate.adminNote && !survivor.adminNote) {
        await repo.updateAdmin(survivorId, { adminNote: duplicate.adminNote })
      }
      await repo.deleteCustomer(duplicateId)
      await repo.recomputeMetrics(survivorId)

      await auditService.record({
        actor,
        action: 'customer.merged',
        resourceType: 'customer',
        resourceId: survivorId,
        before: { duplicateId, duplicateEmail: duplicate.email },
        after: { survivorId },
      })
    })

    await this.recordEvent(survivorId, {
      kind: 'customer.merged',
      body: null,
      actor,
      metadata: { mergedEmail: duplicate.email, orders: duplicate.ordersCount },
    })

    usersService.invalidateAccess(survivorId)
    log.info({ survivorId, duplicateId }, 'customers merged')
    return this.getById(survivorId)
  },

  // ── Rollups ───────────────────────────────────────────────────────────────

  async recomputeMetrics(customerId: string): Promise<CustomerSummary> {
    await repo.recomputeMetrics(customerId)
    return this.getById(customerId)
  },

  /** Rebuilds every customer's figures. Bounded by the customer count. */
  async recomputeAllMetrics(actor: Actor): Promise<number> {
    const ids = await repo.allCustomerIds()
    for (const id of ids) await repo.recomputeMetrics(id)

    await auditService.record({
      actor,
      action: 'customer.metrics_recomputed',
      resourceType: 'customer',
      resourceId: null,
      after: { customers: ids.length },
    })
    log.info({ customers: ids.length }, 'customer metrics recomputed')
    return ids.length
  },

  async assertCanOrder(customer: CustomerSummary): Promise<void> {
    if (customer.status !== 'active') {
      throw new DomainRuleError(
        ERROR_CODES.ACCOUNT_DISABLED,
        'This account cannot place orders',
      )
    }
  },
}
