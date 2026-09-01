/**
 * The memory and local adapters, against the shared contract (§46).
 *
 * No database and no network: these two providers are the ones every other
 * test leans on, so they are held to the same interface the Supabase adapter
 * implements.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LocalStorageProvider } from '../../src/infrastructure/storage/providers/local.js'
import { MemoryStorageProvider } from '../../src/infrastructure/storage/providers/memory.js'
import { runStorageProviderContract, PNG_1X1 } from '../contract/storageProvider.js'

const tempDirs: string[] = []

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

runStorageProviderContract('memory', () => {
  const provider = new MemoryStorageProvider('media-test')
  return {
    provider,
    async completeUpload(token, body, contentType) {
      await provider.completeUpload(token as string, body, contentType)
    },
    async cleanup() {
      provider.clear()
    },
  }
})

runStorageProviderContract('local filesystem', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'storage-contract-'))
  tempDirs.push(directory)
  const provider = new LocalStorageProvider({
    directory,
    baseUrl: 'http://localhost:4000/local-storage',
    bucket: 'media-test',
  })
  return {
    provider,
    async completeUpload(token, body) {
      await provider.completeUpload(token as string, body)
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true })
    },
  }
})

describe('local provider upload tokens', () => {
  async function build() {
    const directory = await mkdtemp(path.join(tmpdir(), 'storage-token-'))
    tempDirs.push(directory)
    return new LocalStorageProvider({
      directory,
      baseUrl: 'http://localhost:4000/local-storage',
      bucket: 'media-test',
    })
  }

  it('redeems a token once and only once', async () => {
    const provider = await build()
    const { token } = await provider.createSignedUploadUrl('media/a/original.png', {
      contentType: 'image/png',
      expiresInSeconds: 300,
    })

    await provider.completeUpload(token as string, PNG_1X1)
    await expect(provider.completeUpload(token as string, PNG_1X1)).rejects.toThrow(
      /unknown upload token/i,
    )
  })

  it('refuses an expired token', async () => {
    const provider = await build()
    const { token } = await provider.createSignedUploadUrl('media/b/original.png', {
      contentType: 'image/png',
      expiresInSeconds: -1,
    })

    await expect(provider.completeUpload(token as string, PNG_1X1)).rejects.toThrow(/expired/i)
  })

  it('refuses an unknown token, so a guessed URL writes nothing', async () => {
    const provider = await build()
    await expect(provider.completeUpload('f'.repeat(32), PNG_1X1)).rejects.toThrow(
      /unknown upload token/i,
    )
  })

  it('never writes outside its root, even if a key escapes', async () => {
    const provider = await build()
    await expect(
      provider.put({ key: '../escaped.png', body: PNG_1X1, contentType: 'image/png' }),
    ).rejects.toThrow(/unsafe/i)
  })
})
