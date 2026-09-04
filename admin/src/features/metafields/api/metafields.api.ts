import { api } from '@/lib/api/client'
import type {
  CreateDefinitionInput,
  MetafieldDefinition,
  MetafieldEntry,
  MetafieldOwnerType,
  UpdateDefinitionInput,
} from '../types/metafields.types'

/**
 * The metafield endpoints.
 *
 * Values are read and written per record, as a batch: the server applies the
 * whole set in one transaction and refuses all of it if any one value is
 * unacceptable, so the admin never has to reason about a half-saved form.
 */
export const metafieldsApi = {
  definitions: (ownerType?: MetafieldOwnerType) =>
    api.get<MetafieldDefinition[]>('/admin/metafields/definitions', {
      query: { ownerType },
    }),

  createDefinition: (body: CreateDefinitionInput) =>
    api.post<MetafieldDefinition>('/admin/metafields/definitions', body),

  updateDefinition: (id: string, body: UpdateDefinitionInput) =>
    api.patch<MetafieldDefinition>(`/admin/metafields/definitions/${id}`, body),

  /** Returns how many values went with it, so the admin can say what happened. */
  deleteDefinition: (id: string) =>
    api.delete<{ deletedValues: number }>(`/admin/metafields/definitions/${id}`),

  values: (ownerType: MetafieldOwnerType, ownerId: string) =>
    api.get<MetafieldEntry[]>(`/admin/metafields/${ownerType}/${ownerId}`),

  setValues: (
    ownerType: MetafieldOwnerType,
    ownerId: string,
    values: { definitionId: string; value: unknown }[],
  ) => api.put<MetafieldEntry[]>(`/admin/metafields/${ownerType}/${ownerId}`, { values }),
}
