import { v7 as uuidv7 } from 'uuid'
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { registerConstraintError } from '../../infrastructure/database/errors.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { auditService } from '../audit/index.js'
import type { Actor } from '../../shared/auth/actor.js'
import { ERROR_CODES, NotFoundError, ValidationError } from '../../shared/errors/index.js'
import { assertValidationsCoherent, coerceValue } from './metafields.validate.js'
import type {
  CreateDefinitionInput,
  MetafieldDefinition,
  MetafieldDefinitionWithUsage,
  MetafieldOwnerType,
  MetafieldValue,
  PublicMetafield,
  UpdateDefinitionInput,
} from './metafields.types.js'

const log = createLogger('metafields')

registerConstraintError(
  'metafield_definitions_identity',
  ERROR_CODES.ALREADY_EXISTS,
  'A field with that namespace and key already exists for this kind of record',
)

/**
 * Owner type → the column that holds it.
 *
 * A fixed map, never a value from a request: these names are interpolated into
 * SQL, and the whole safety of that rests on them coming from here. The owner
 * type itself is validated against this map's keys before it is used.
 */
const OWNER_COLUMN = {
  product: 'product_id',
  variant: 'variant_id',
  collection: 'collection_id',
  customer: 'customer_id',
  order: 'order_id',
} as const satisfies Record<MetafieldOwnerType, string>

/** The table each owner type lives in, for checking the record exists. */
const OWNER_TABLE = {
  product: 'products',
  variant: 'product_variants',
  collection: 'collections',
  // A customer is a user who has bought something; this schema has no separate
  // customers table (see 0034).
  customer: 'users',
  order: 'orders',
} as const satisfies Record<MetafieldOwnerType, string>

function columnFor(ownerType: MetafieldOwnerType): string {
  const column = OWNER_COLUMN[ownerType]
  if (!column) throw new ValidationError(`Unknown record type ${ownerType}`)
  return column
}

interface DefinitionRow {
  id: string
  owner_type: MetafieldOwnerType
  namespace: string
  key: string
  name: string
  description: string | null
  type: MetafieldDefinition['type']
  validations: MetafieldDefinition['validations']
  required: boolean
  storefront_visible: boolean
  position: number
  created_at: Date
  updated_at: Date
}

function toDefinition(row: DefinitionRow): MetafieldDefinition {
  return {
    id: row.id,
    ownerType: row.owner_type,
    namespace: row.namespace,
    key: row.key,
    name: row.name,
    description: row.description,
    type: row.type,
    validations: row.validations ?? {},
    required: row.required,
    storefrontVisible: row.storefront_visible,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const metafieldsService = {
  // ── Definitions ───────────────────────────────────────────────────────────

  async listDefinitions(ownerType?: MetafieldOwnerType): Promise<MetafieldDefinitionWithUsage[]> {
    const rows = await query<DefinitionRow & { value_count: number }>(
      `SELECT d.*,
              (SELECT count(*)::int FROM metafield_values v WHERE v.definition_id = d.id) AS value_count
         FROM metafield_definitions d
        ${ownerType ? 'WHERE d.owner_type = $1' : ''}
        ORDER BY d.owner_type, d.position, d.created_at`,
      ownerType ? [ownerType] : [],
      { name: 'metafields.listDefinitions' },
    )
    return rows.map((row) => ({ ...toDefinition(row), valueCount: row.value_count }))
  },

  async getDefinition(id: string): Promise<MetafieldDefinition> {
    const row = await queryOne<DefinitionRow>(
      'SELECT * FROM metafield_definitions WHERE id = $1',
      [id],
      { name: 'metafields.getDefinition' },
    )
    if (!row) throw new NotFoundError('Field not found')
    return toDefinition(row)
  },

  async createDefinition(
    input: CreateDefinitionInput,
    actor: Actor,
  ): Promise<MetafieldDefinition> {
    assertValidationsCoherent(input.type, input.validations ?? {})

    const id = uuidv7()
    await execute(
      `INSERT INTO metafield_definitions
         (id, owner_type, namespace, key, name, description, type, validations,
          required, storefront_visible, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        input.ownerType,
        input.namespace,
        input.key,
        input.name,
        input.description ?? null,
        input.type,
        JSON.stringify(input.validations ?? {}),
        input.required ?? false,
        input.storefrontVisible ?? false,
        input.position ?? 0,
      ],
      { name: 'metafields.createDefinition' },
    )

    await auditService.record({
      actor,
      action: 'metafield_definition.created',
      resourceType: 'metafield_definition',
      resourceId: id,
      after: {
        ownerType: input.ownerType,
        namespace: input.namespace,
        key: input.key,
        type: input.type,
        storefrontVisible: input.storefrontVisible ?? false,
      },
    })

    log.info(
      { id, ownerType: input.ownerType, key: `${input.namespace}.${input.key}` },
      'metafield definition created',
    )
    return this.getDefinition(id)
  },

  /**
   * Changes what can be changed.
   *
   * The type, namespace, key and owner type are not in the patch and cannot be:
   * values are already stored against them. Changing a text field to an integer
   * would not convert anything — it would leave every stored value invalid
   * under its own definition, which is a worse state than any of the words
   * "cannot change type" describe.
   */
  async updateDefinition(
    id: string,
    patch: UpdateDefinitionInput,
    actor: Actor,
  ): Promise<MetafieldDefinition> {
    const before = await this.getDefinition(id)
    if (patch.validations) assertValidationsCoherent(before.type, patch.validations)

    const sets: string[] = []
    const params: unknown[] = [id]
    const set = (column: string, value: unknown) => {
      params.push(value)
      sets.push(`${column} = $${params.length}`)
    }

    if (patch.name !== undefined) set('name', patch.name)
    if (patch.description !== undefined) set('description', patch.description)
    if (patch.validations !== undefined) set('validations', JSON.stringify(patch.validations))
    if (patch.required !== undefined) set('required', patch.required)
    if (patch.storefrontVisible !== undefined) set('storefront_visible', patch.storefrontVisible)
    if (patch.position !== undefined) set('position', patch.position)

    if (sets.length === 0) return before

    await execute(
      `UPDATE metafield_definitions SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
      params,
      { name: 'metafields.updateDefinition' },
    )

    const after = await this.getDefinition(id)
    await auditService.record({
      actor,
      action: 'metafield_definition.updated',
      resourceType: 'metafield_definition',
      resourceId: id,
      before: { storefrontVisible: before.storefrontVisible, name: before.name },
      after: { storefrontVisible: after.storefrontVisible, name: after.name },
    })

    // Worth its own line at info: this is the change that moves data from
    // private to public, and "when did that become visible?" is a question
    // somebody eventually asks.
    if (before.storefrontVisible !== after.storefrontVisible) {
      log.info(
        { id, key: `${after.namespace}.${after.key}`, storefrontVisible: after.storefrontVisible },
        'metafield storefront visibility changed',
      )
    }
    return after
  },

  /**
   * Deletes a definition and every value stored under it.
   *
   * The cascade is the database's, and it is the honest behaviour: a value
   * without its definition has no type, no name and no way to be rendered, so
   * keeping the rows would preserve bytes rather than data. What the caller
   * owes the operator is the *count* before they decide, which `listDefinitions`
   * already carries.
   */
  async deleteDefinition(id: string, actor: Actor): Promise<{ deletedValues: number }> {
    const definition = await this.getDefinition(id)

    return withTransaction(async () => {
      const counted = await queryOne<{ count: number }>(
        'SELECT count(*)::int AS count FROM metafield_values WHERE definition_id = $1',
        [id],
        { name: 'metafields.countValues' },
      )
      await execute('DELETE FROM metafield_definitions WHERE id = $1', [id], {
        name: 'metafields.deleteDefinition',
      })

      await auditService.record({
        actor,
        action: 'metafield_definition.deleted',
        resourceType: 'metafield_definition',
        resourceId: id,
        before: {
          ownerType: definition.ownerType,
          key: `${definition.namespace}.${definition.key}`,
          deletedValues: counted?.count ?? 0,
        },
      })

      log.info(
        { id, key: `${definition.namespace}.${definition.key}`, deletedValues: counted?.count ?? 0 },
        'metafield definition deleted',
      )
      return { deletedValues: counted?.count ?? 0 }
    })
  },

  // ── Values ────────────────────────────────────────────────────────────────

  /**
   * Every field defined for this kind of record, with this record's value.
   *
   * Definitions drive the list, not values — a field nobody has filled in yet
   * still has to appear, or the admin could not offer somewhere to fill it in.
   */
  async valuesFor(
    ownerType: MetafieldOwnerType,
    ownerId: string,
  ): Promise<(MetafieldValue & { definition: MetafieldDefinition })[]> {
    const column = columnFor(ownerType)

    const rows = await query<DefinitionRow & { value: unknown; value_updated_at: Date | null }>(
      `SELECT d.*, v.value, v.updated_at AS value_updated_at
         FROM metafield_definitions d
         LEFT JOIN metafield_values v
           ON v.definition_id = d.id AND v.${column} = $1
        WHERE d.owner_type = $2
        ORDER BY d.position, d.created_at`,
      [ownerId, ownerType],
      { name: 'metafields.valuesFor' },
    )

    return rows.map((row) => {
      const definition = toDefinition(row)
      return {
        definitionId: definition.id,
        namespace: definition.namespace,
        key: definition.key,
        name: definition.name,
        type: definition.type,
        value: row.value ?? null,
        updatedAt: row.value_updated_at ?? definition.updatedAt,
        definition,
      }
    })
  },

  /**
   * Writes a batch of values for one record.
   *
   * One transaction, because a form saves as a whole: half-written metafields
   * would leave a product describing itself with two of five fields updated and
   * no way for the operator to know which.
   *
   * A `null` clears the field. Every value is coerced and bounded against its
   * own definition first, so nothing is written unless all of it is acceptable.
   */
  async setValues(
    ownerType: MetafieldOwnerType,
    ownerId: string,
    values: { definitionId: string; value: unknown }[],
    actor: Actor,
  ): Promise<(MetafieldValue & { definition: MetafieldDefinition })[]> {
    const column = columnFor(ownerType)
    await assertOwnerExists(ownerType, ownerId)

    const definitions = await this.listDefinitions(ownerType)
    const byId = new Map(definitions.map((definition) => [definition.id, definition]))

    // Everything is checked before anything is written, so a bad third field
    // does not leave the first two applied.
    const prepared = values.map((entry) => {
      const definition = byId.get(entry.definitionId)
      if (!definition) {
        throw new ValidationError('That field does not apply to this kind of record')
      }
      return { definition, value: coerceValue(definition, entry.value) }
    })

    await withTransaction(async () => {
      for (const { definition, value } of prepared) {
        if (value === null) {
          await execute(
            `DELETE FROM metafield_values WHERE definition_id = $1 AND ${column} = $2`,
            [definition.id, ownerId],
            { name: 'metafields.clearValue' },
          )
          continue
        }

        /*
         * Upsert against the partial unique index for this owner column.
         *
         * Named explicitly rather than by constraint name because these are
         * partial indexes — one per owner kind — and the inference has to match
         * the one that actually covers this column.
         */
        await execute(
          `INSERT INTO metafield_values (id, definition_id, ${column}, value)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (definition_id, ${column}) WHERE ${column} IS NOT NULL
           DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [uuidv7(), definition.id, ownerId, JSON.stringify(value)],
          { name: 'metafields.setValue' },
        )
      }
    })

    /*
     * Audited as "which fields changed", never the values themselves.
     *
     * A customer metafield can hold anything somebody typed, and the audit log
     * is read far more widely than the record it describes. Field names answer
     * "who changed this" without turning the trail into a second copy of the
     * data.
     */
    await auditService.record({
      actor,
      action: 'metafield.values_updated',
      resourceType: ownerType,
      resourceId: ownerId,
      after: { fields: prepared.map((p) => `${p.definition.namespace}.${p.definition.key}`) },
    })

    return this.valuesFor(ownerType, ownerId)
  },

  // ── The storefront's view ─────────────────────────────────────────────────

  /**
   * The public fields for one record.
   *
   * `storefront_visible` is in the WHERE clause, not filtered afterwards in the
   * mapper — a private field never leaves the database, so no later refactor of
   * a DTO can accidentally include one.
   */
  async publicFor(ownerType: MetafieldOwnerType, ownerId: string): Promise<PublicMetafield[]> {
    const column = columnFor(ownerType)
    const rows = await query<{
      namespace: string
      key: string
      type: MetafieldDefinition['type']
      value: unknown
    }>(
      `SELECT d.namespace, d.key, d.type, v.value
         FROM metafield_values v
         JOIN metafield_definitions d ON d.id = v.definition_id
        WHERE v.${column} = $1
          AND d.owner_type = $2
          AND d.storefront_visible
        ORDER BY d.position, d.key`,
      [ownerId, ownerType],
      { name: 'metafields.publicFor' },
    )
    return rows.map((row) => ({
      namespace: row.namespace,
      key: row.key,
      type: row.type,
      value: row.value,
    }))
  },

  /**
   * The same, for many records at once.
   *
   * A product list rendering metafields would otherwise be one query per row —
   * the N+1 that turns a category page into forty round trips.
   */
  async publicForMany(
    ownerType: MetafieldOwnerType,
    ownerIds: string[],
  ): Promise<Map<string, PublicMetafield[]>> {
    const result = new Map<string, PublicMetafield[]>()
    if (ownerIds.length === 0) return result

    const column = columnFor(ownerType)
    const rows = await query<{
      owner_id: string
      namespace: string
      key: string
      type: MetafieldDefinition['type']
      value: unknown
    }>(
      `SELECT v.${column} AS owner_id, d.namespace, d.key, d.type, v.value
         FROM metafield_values v
         JOIN metafield_definitions d ON d.id = v.definition_id
        WHERE v.${column} = ANY($1::uuid[])
          AND d.owner_type = $2
          AND d.storefront_visible
        ORDER BY d.position, d.key`,
      [ownerIds, ownerType],
      { name: 'metafields.publicForMany' },
    )

    for (const row of rows) {
      const list = result.get(row.owner_id) ?? []
      list.push({ namespace: row.namespace, key: row.key, type: row.type, value: row.value })
      result.set(row.owner_id, list)
    }
    return result
  },
}

/**
 * Refuses a value written against a record that does not exist.
 *
 * The foreign key would refuse it too, but as a 409 about a constraint. This is
 * the same refusal in the operator's language, and it is also what stops a
 * mistyped id quietly creating nothing while reporting success.
 */
async function assertOwnerExists(ownerType: MetafieldOwnerType, ownerId: string): Promise<void> {
  const table = OWNER_TABLE[ownerType]
  if (!table) throw new ValidationError(`Unknown record type ${ownerType}`)

  const row = await queryOne<{ id: string }>(`SELECT id FROM ${table} WHERE id = $1`, [ownerId], {
    name: 'metafields.assertOwnerExists',
  })
  if (!row) throw new NotFoundError('That record does not exist')
}
