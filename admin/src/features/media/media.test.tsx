import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tokenStore } from '@/lib/api/tokenStore'
import { apiMock, type ApiMock } from '@/test/api-mock'
import { jsonResponse } from '@/test/http'
import { renderAuthed } from '@/test/renderAuthed'
import { adminUser, productDetail } from '@/test/catalogue'
import { ProductMediaManager } from '@/features/products/components/ProductMediaManager'
import { validateImageFile } from './media.hooks'

/**
 * The three-step upload, as the server defines it.
 *
 * `XMLHttpRequest` is stubbed because the byte transfer deliberately does not
 * go through the API client — it is a PUT at a storage provider's signed URL,
 * and `fetch` has no upload-progress event.
 */

let api: ApiMock

class FakeXHR {
  static instances: FakeXHR[] = []
  static failWith: number | null = null

  method = ''
  url = ''
  status = 200
  readonly headers: Record<string, string> = {}
  readonly upload = { listeners: {} as Record<string, Array<(event: unknown) => void>>, addEventListener(type: string, fn: (event: unknown) => void) { (this.listeners[type] ??= []).push(fn) } }
  private readonly listeners: Record<string, Array<() => void>> = {}

  constructor() {
    FakeXHR.instances.push(this)
  }

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value
  }
  addEventListener(type: string, fn: () => void) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  abort() {
    this.listeners.abort?.forEach((fn) => fn())
  }
  send() {
    this.upload.listeners.progress?.forEach((fn) => fn({ lengthComputable: true, loaded: 50, total: 100 }))
    this.status = FakeXHR.failWith ?? 200
    queueMicrotask(() => this.listeners.load?.forEach((fn) => fn()))
  }
}

function imageFile(name = 'burger.png', type = 'image/png') {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type })
}

beforeEach(() => {
  api = apiMock().install()
  FakeXHR.instances = []
  FakeXHR.failWith = null
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  tokenStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  tokenStore.clear()
})

describe('validateImageFile', () => {
  it('rejects a type the server does not accept, before any upload', () => {
    const file = new File(['x'], 'notes.pdf', { type: 'application/pdf' })
    expect(validateImageFile(file)).toMatch(/only JPEG, PNG, WebP, AVIF and GIF/)
  })

  it('rejects a file over the size limit', () => {
    const big = new File([new Uint8Array(64)], 'huge.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 })
    expect(validateImageFile(big)).toMatch(/the limit is 10 MB/)
  })

  it('accepts a normal image', () => {
    expect(validateImageFile(imageFile())).toBeNull()
  })
})

describe('ProductMediaManager', () => {
  function uploadRoutes(mock: ApiMock, assetStatus: 'ready' | 'processing' = 'ready') {
    return mock
      .withSession(adminUser)
      .on('POST', '/admin/media/uploads', () =>
        jsonResponse(202, {
          success: true,
          data: {
            assetId: 'asset-1',
            upload: {
              url: 'http://storage.test/upload/tok-1',
              method: 'PUT',
              token: 'tok-1',
              expiresAt: '2030-01-01T00:00:00.000Z',
            },
            storageKey: 'media/asset-1.png',
          },
        }),
      )
      .on('POST', '/admin/media/asset-1/complete', () =>
        jsonResponse(202, {
          success: true,
          data: { id: 'asset-1', status: assetStatus, alt: null, mimeType: 'image/png' },
        }),
      )
  }

  it('walks the server’s three steps in order and attaches the ready asset', async () => {
    const user = userEvent.setup()
    uploadRoutes(api).on('POST', '/admin/products/prod-1/media', () =>
      jsonResponse(201, { success: true, data: productDetail() }),
    )

    await renderAuthed(
      <ProductMediaManager productId="prod-1" media={[]} canEdit />,
      { route: '/products/prod-1' },
    )

    await user.upload(screen.getByLabelText(/Drop images here/i), imageFile())

    await waitFor(() =>
      expect(api.callsTo('POST', '/admin/products/prod-1/media')).toHaveLength(1),
    )

    // Step 1 declares what is coming — a claim, never the bytes.
    expect(api.callsTo('POST', '/admin/media/uploads')[0]!.body).toMatchObject({
      contentType: 'image/png',
      filename: 'burger.png',
    })

    // Step 2 goes to the URL the server chose, verbatim, and carries no bearer
    // token: a signed URL is its own credential, and attaching ours would leak
    // it to a third-party host.
    const transfer = FakeXHR.instances[0]!
    expect(transfer.method).toBe('PUT')
    expect(transfer.url).toBe('http://storage.test/upload/tok-1')
    expect(transfer.headers).not.toHaveProperty('authorization')
    expect(transfer.headers['Content-Type']).toBe('image/png')

    // Step 3, then the attach — by asset id, once the asset is ready.
    expect(api.callsTo('POST', '/admin/media/asset-1/complete')).toHaveLength(1)
    expect(api.callsTo('POST', '/admin/products/prod-1/media')[0]!.body).toMatchObject({
      mediaId: 'asset-1',
    })
  })

  it('waits for the worker before attaching, because complete returns processing', async () => {
    const user = userEvent.setup()
    uploadRoutes(api, 'processing')
      // The worker finishes between the poll and the next read.
      .on('GET', '/admin/media/asset-1', {
        id: 'asset-1',
        status: 'ready',
        alt: null,
        mimeType: 'image/png',
      })
      .on('POST', '/admin/products/prod-1/media', () =>
        jsonResponse(201, { success: true, data: productDetail() }),
      )

    await renderAuthed(<ProductMediaManager productId="prod-1" media={[]} canEdit />, {
      route: '/products/prod-1',
    })

    await user.upload(screen.getByLabelText(/Drop images here/i), imageFile())

    await waitFor(
      () => expect(api.callsTo('POST', '/admin/products/prod-1/media')).toHaveLength(1),
      { timeout: 5000 },
    )
    // The attach would be refused by `assertReady` had it happened first.
    expect(api.callsTo('GET', '/admin/media/asset-1').length).toBeGreaterThan(0)
  })

  it('reports the server’s reason when it rejects the image', async () => {
    const user = userEvent.setup()
    api
      .withSession(adminUser)
      .on('POST', '/admin/media/uploads', () =>
        jsonResponse(202, {
          success: true,
          data: {
            assetId: 'asset-1',
            upload: { url: 'http://storage.test/upload/tok-1', method: 'PUT', token: 'tok-1', expiresAt: '2030-01-01T00:00:00.000Z' },
            storageKey: 'media/asset-1.png',
          },
        }),
      )
      .onError(
        'POST',
        '/admin/media/asset-1/complete',
        422,
        'MEDIA_REJECTED',
        'The uploaded file is not a recognised image',
      )

    await renderAuthed(<ProductMediaManager productId="prod-1" media={[]} canEdit />, {
      route: '/products/prod-1',
    })

    await user.upload(screen.getByLabelText(/Drop images here/i), imageFile())

    expect(
      await screen.findByText('The uploaded file is not a recognised image'),
    ).toBeInTheDocument()
    expect(api.callsTo('POST', '/admin/products/prod-1/media')).toHaveLength(0)
  })

  it('sends the whole arrangement when an image is reordered, by product-media id', async () => {
    const user = userEvent.setup()
    const media = [
      { id: 'pm-1', mediaId: 'asset-1', alt: null, position: 0, isPrimary: true, url: 'http://img/1', variants: {} },
      { id: 'pm-2', mediaId: 'asset-2', alt: null, position: 1, isPrimary: false, url: 'http://img/2', variants: {} },
    ]
    api.withSession(adminUser).on('PUT', '/admin/products/prod-1/media/order', () =>
      jsonResponse(200, { success: true, data: productDetail() }),
    )

    await renderAuthed(<ProductMediaManager productId="prod-1" media={media} canEdit />, {
      route: '/products/prod-1',
    })

    await user.click(screen.getByRole('button', { name: 'Make image 2 the primary image' }))

    await waitFor(() =>
      expect(api.callsTo('PUT', '/admin/products/prod-1/media/order')).toHaveLength(1),
    )
    // Row ids, not asset ids — the server matches `order` against product_media.
    expect(api.callsTo('PUT', '/admin/products/prod-1/media/order')[0]!.body).toEqual({
      order: ['pm-1', 'pm-2'],
      primaryId: 'pm-2',
    })
  })

  it('confirms before detaching an image', async () => {
    const user = userEvent.setup()
    const media = [
      { id: 'pm-1', mediaId: 'asset-1', alt: null, position: 0, isPrimary: true, url: 'http://img/1', variants: {} },
    ]
    api
      .withSession(adminUser)
      .on('DELETE', '/admin/products/prod-1/media/pm-1', () => new Response(null, { status: 204 }))

    await renderAuthed(<ProductMediaManager productId="prod-1" media={media} canEdit />, {
      route: '/products/prod-1',
    })

    await user.click(screen.getByRole('button', { name: 'Remove image 1' }))
    expect(api.callsTo('DELETE', '/admin/products/prod-1/media/pm-1')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(api.callsTo('DELETE', '/admin/products/prod-1/media/pm-1')).toHaveLength(1),
    )
  })

  it('offers no upload control without catalog:write', async () => {
    api.withSession(adminUser)
    await renderAuthed(<ProductMediaManager productId="prod-1" media={[]} canEdit={false} />, {
      route: '/products/prod-1',
    })

    expect(screen.queryByLabelText(/Drop images here/i)).not.toBeInTheDocument()
    expect(screen.getByText('No images')).toBeInTheDocument()
  })
})
