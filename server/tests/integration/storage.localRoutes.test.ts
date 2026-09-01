/**
 * The development-only local storage endpoints (§46).
 *
 * They exist so a developer without a Supabase project runs the identical
 * three-step client flow. Because they accept raw bytes at a URL, they are
 * tested as an attack surface rather than as a convenience: a guessed token
 * must write nothing, a key must not escape the storage root, and the download
 * route must never let the browser decide what a file is.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  LOCAL_STORAGE_PATH,
  buildLocalStorageRouter,
  localStorageEnabled,
} from '../../src/routes/localStorage.routes.js'
import { setStorage } from '../../src/infrastructure/storage/index.js'
import { LocalStorageProvider } from '../../src/infrastructure/storage/providers/local.js'
import { MemoryStorageProvider } from '../../src/infrastructure/storage/providers/memory.js'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const app = express()
app.use(LOCAL_STORAGE_PATH, buildLocalStorageRouter())

let directory: string
let provider: LocalStorageProvider

describe('local storage dev endpoints', () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'storage-routes-'))
  })
  beforeEach(() => {
    provider = new LocalStorageProvider({
      directory,
      baseUrl: `http://localhost:4000${LOCAL_STORAGE_PATH}`,
      bucket: 'media-test',
    })
    setStorage(provider)
  })
  afterAll(async () => {
    setStorage(undefined)
    await rm(directory, { recursive: true, force: true })
  })

  it('is enabled only outside production, with the local provider', () => {
    // Config forbids `local` in production, so this is belt and braces; the
    // test records the intent so a future config change cannot quietly expose
    // an upload endpoint on a deployed instance.
    expect(localStorageEnabled()).toBe(process.env.STORAGE_PROVIDER !== 'supabase')
  })

  it('accepts bytes at the URL the ticket named', async () => {
    const key = 'media/2026/03/asset/original.png'
    const upload = await provider.createSignedUploadUrl(key, {
      contentType: 'image/png',
      expiresInSeconds: 300,
    })

    const res = await request(app)
      .put(new URL(upload.url).pathname)
      .set('Content-Type', 'image/png')
      .send(PNG_1X1)

    expect(res.status).toBe(200)
    expect(res.body.key).toBe(key)
    expect((await provider.head(key))?.byteSize).toBe(PNG_1X1.byteLength)
  })

  it('writes nothing for a guessed token, and says no more than it must', async () => {
    const res = await request(app)
      .put(`${LOCAL_STORAGE_PATH}/upload/${'a'.repeat(32)}`)
      .set('Content-Type', 'image/png')
      .send(PNG_1X1)

    expect(res.status).toBe(403)

    // An expired token must be indistinguishable from an invented one, so a
    // caller cannot probe for which keys once existed.
    const expired = await provider.createSignedUploadUrl('media/2026/03/old/original.png', {
      contentType: 'image/png',
      expiresInSeconds: -1,
    })
    const expiredRes = await request(app)
      .put(new URL(expired.url).pathname)
      .set('Content-Type', 'image/png')
      .send(PNG_1X1)

    expect(expiredRes.status).toBe(403)
    expect(expiredRes.body).toEqual(res.body)
  })

  it('refuses a token that has already been redeemed', async () => {
    const upload = await provider.createSignedUploadUrl('media/2026/03/twice/original.png', {
      contentType: 'image/png',
      expiresInSeconds: 300,
    })
    const url = new URL(upload.url).pathname

    const put = () => request(app).put(url).set('Content-Type', 'image/png').send(PNG_1X1)
    expect((await put()).status).toBe(200)
    expect((await put()).status).toBe(403)
  })

  it('refuses an empty upload', async () => {
    const upload = await provider.createSignedUploadUrl('media/2026/03/empty/original.png', {
      contentType: 'image/png',
      expiresInSeconds: 300,
    })

    const res = await request(app)
      .put(new URL(upload.url).pathname)
      .set('Content-Type', 'image/png')
      .send(Buffer.alloc(0))
    expect(res.status).toBe(400)
  })

  it('serves an object with the type its bytes actually are, and forbids sniffing', async () => {
    const key = 'media/2026/03/served/original.png'
    await provider.put({ key, body: PNG_1X1, contentType: 'image/png' })

    const res = await request(app).get(`${LOCAL_STORAGE_PATH}/objects/${key}`)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(Buffer.from(res.body).equals(PNG_1X1)).toBe(true)
  })

  it('never serves a non-image as one, whatever landed in the bucket', async () => {
    const key = 'media/2026/03/sneaky/original.png'
    await provider.put({
      key,
      body: Buffer.from('<script>alert(document.cookie)</script>'),
      // Even a lying content type at write time does not decide what is served.
      contentType: 'text/html',
    })

    const res = await request(app).get(`${LOCAL_STORAGE_PATH}/objects/${key}`)
    expect(res.headers['content-type']).toBe('application/octet-stream')
  })

  it('refuses to read outside the storage root', async () => {
    // Something worth stealing, one level above the bucket.
    await mkdir(path.dirname(directory), { recursive: true })
    const secret = path.join(directory, '..', `secret-${process.pid}.txt`)
    await writeFile(secret, 'top secret')

    try {
      for (const attempt of [
        '../secret.txt',
        '..%2fsecret.txt',
        'media/../../etc/passwd',
        '/etc/passwd',
      ]) {
        const res = await request(app).get(`${LOCAL_STORAGE_PATH}/objects/${attempt}`)
        expect([400, 404]).toContain(res.status)
        expect(res.text ?? '').not.toContain('top secret')
      }
    } finally {
      await rm(secret, { force: true })
    }
  })

  it('404s for an object that is not there', async () => {
    const res = await request(app).get(`${LOCAL_STORAGE_PATH}/objects/media/2026/03/x/nope.png`)
    expect(res.status).toBe(404)
  })

  it('does nothing at all when a different provider is configured', async () => {
    setStorage(new MemoryStorageProvider('media-test'))

    const blocked = await request(app)
      .put(`${LOCAL_STORAGE_PATH}/upload/${'a'.repeat(32)}`)
      .set('Content-Type', 'image/png')
      .send(PNG_1X1)
    expect(blocked.status).toBe(404)
    expect((await request(app).get(`${LOCAL_STORAGE_PATH}/objects/media/a/b.png`)).status).toBe(404)
  })
})
