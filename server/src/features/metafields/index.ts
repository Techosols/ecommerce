/** Public surface of the `metafields` feature (§2.2). */
export { metafieldsService } from './metafields.service.js'
export { metafieldsAdminRoutes } from './metafields.admin.routes.js'
export { OWNER_TYPES, METAFIELD_TYPES } from './metafields.types.js'
export type {
  MetafieldDefinition,
  MetafieldDefinitionWithUsage,
  MetafieldOwnerType,
  MetafieldType,
  MetafieldValidations,
  MetafieldValue,
  PublicMetafield,
} from './metafields.types.js'
