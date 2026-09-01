/**
 * Provider selection happens once, here (§46).
 *
 * Nothing else in the codebase knows which backend is active — the same rule
 * the email subsystem follows. A feature calls `getStorage()` and gets a
 * `StorageProvider`.
 */
import { env } from '../../config/index.js'
import { createLogger } from '../logging/logger.js'
import { LocalStorageProvider } from './providers/local.js'
import { MemoryStorageProvider } from './providers/memory.js'
import { SupabaseStorageProvider } from './providers/supabase.js'
import type { StorageProvider } from './provider.js'

const log = createLogger('storage')

let provider: StorageProvider | undefined

function build(): StorageProvider {
  switch (env.STORAGE_PROVIDER) {
    case 'supabase':
      // Config has already refused to boot without these (§21.1).
      return new SupabaseStorageProvider({
        url: env.SUPABASE_URL!,
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!,
        bucket: env.SUPABASE_STORAGE_BUCKET,
        isPublic: env.SUPABASE_STORAGE_PUBLIC,
      })
    case 'local':
      return new LocalStorageProvider({
        directory: env.STORAGE_LOCAL_DIR,
        baseUrl: env.STORAGE_LOCAL_BASE_URL,
        bucket: env.SUPABASE_STORAGE_BUCKET,
      })
    case 'memory':
      return new MemoryStorageProvider(env.SUPABASE_STORAGE_BUCKET)
  }
}

export function getStorage(): StorageProvider {
  if (!provider) {
    provider = build()
    log.debug({ provider: provider.name, bucket: provider.bucket }, 'storage provider selected')
  }
  return provider
}

/** Test seam: substitute a provider, or reset to the configured one. */
export function setStorage(next: StorageProvider | undefined): void {
  provider = next
}

export type {
  StorageProvider,
  SignedUpload,
  StoredObjectInfo,
  PutObjectInput,
} from './provider.js'
export { StorageOperationError } from './provider.js'
export {
  ALLOWED_IMAGE_TYPES,
  VARIANT_SIZES,
  assertSafeKey,
  extensionFor,
  generateMediaKey,
  isAllowedImageType,
  prefixOf,
  sanitiseFilename,
  variantKey,
} from './keys.js'
export type { MediaVariant, GeneratedKey } from './keys.js'
export { LocalStorageProvider } from './providers/local.js'
export { MemoryStorageProvider } from './providers/memory.js'
export { SupabaseStorageProvider } from './providers/supabase.js'
