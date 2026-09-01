import { createContext, use } from 'react'
import { useQuery } from '@tanstack/react-query'
import { settingsApi } from './settings.api'

/**
 * The store's own name and currency, fetched once for the whole session.
 *
 * A context rather than a hook everybody calls, so the header, a price and a
 * footer all read one answer. It changes about as often as the shop is
 * renamed, so it is held indefinitely and refetched only on a reload.
 */
export const SettingsContext = createContext(null)

export function useStoreSettings() {
  return use(SettingsContext)
}

export function useSettingsQuery() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.get(),
    staleTime: Infinity,
  })
}
