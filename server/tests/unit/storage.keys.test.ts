/**
 * Key generation and content sniffing (§16.3).
 *
 * These two files are the whole reason a client cannot choose where its bytes
 * land or what the server believes they are, so they get direct tests rather
 * than being covered incidentally by the media suite.
 */
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_IMAGE_TYPES,
  assertSafeKey,
  extensionFor,
  generateMediaKey,
  isAllowedImageType,
  prefixOf,
  sanitiseFilename,
  variantKey,
} from '../../src/infrastructure/storage/keys.js'
import { SNIFF_BYTES, isRiskyContainer, sniffImageType } from '../../src/infrastructure/storage/sniff.js'

describe('generateMediaKey', () => {
  it('date-partitions and gives each asset its own directory', () => {
    const { assetId, prefix, key } = generateMediaKey({
      mimeType: 'image/jpeg',
      now: new Date('2026-03-09T12:00:00Z'),
    })

    expect(prefix).toBe(`media/2026/03/${assetId}`)
    expect(key).toBe(`${prefix}/original.jpg`)
    assertSafeKey(key)
  })

  it('uses UTC, so a key does not depend on the server’s timezone', () => {
    // 23:30 UTC on the 31st is already the next month in some zones.
    const { key } = generateMediaKey({
      mimeType: 'image/png',
      now: new Date('2026-01-31T23:30:00Z'),
    })
    expect(key.startsWith('media/2026/01/')).toBe(true)
  })

  it('never reuses a key', () => {
    const keys = new Set(
      Array.from({ length: 50 }, () => generateMediaKey({ mimeType: 'image/webp' }).key),
    )
    expect(keys.size).toBe(50)
  })

  it('refuses a type outside the allowlist', () => {
    expect(isAllowedImageType('image/svg+xml')).toBe(false)
    expect(() => extensionFor('image/svg+xml')).toThrow()
    expect(() => generateMediaKey({ mimeType: 'text/html' })).toThrow()
  })

  it('maps every allowed type to an extension', () => {
    for (const mime of Object.keys(ALLOWED_IMAGE_TYPES)) {
      expect(extensionFor(mime)).toMatch(/^[a-z]+$/)
    }
  })

  it('derives variant keys under the asset’s own prefix', () => {
    const { prefix, key } = generateMediaKey({ mimeType: 'image/png' })
    expect(prefixOf(key)).toBe(prefix)
    expect(variantKey(prefix, 'thumb')).toBe(`${prefix}/thumb.webp`)
  })
})

describe('assertSafeKey', () => {
  it('accepts a generated key', () => {
    expect(() => assertSafeKey('media/2026/03/abc-123/original.jpg')).not.toThrow()
  })

  it.each([
    ['empty', ''],
    ['absolute', '/etc/passwd'],
    ['traversal', 'media/../../etc/passwd'],
    ['dot-dot anywhere', 'media/a..b/original.png'],
    ['double slash', 'media//original.png'],
    ['null byte', 'media/a\u0000.png'],
    ['newline', 'media/a\n.png'],
    ['space', 'media/my file.png'],
    ['url-encoded traversal', 'media/%2e%2e/original.png'],
    ['backslash', 'media\\..\\original.png'],
    ['too long', `media/${'a'.repeat(600)}.png`],
  ])('rejects %s', (_label, key) => {
    expect(() => assertSafeKey(key)).toThrow(/unsafe storage key/i)
  })

  it('does not echo the whole key back in the error', () => {
    try {
      assertSafeKey(`/${'x'.repeat(500)}`)
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(140)
    }
  })
})

describe('sanitiseFilename', () => {
  it('keeps only the base name', () => {
    expect(sanitiseFilename('/etc/passwd')).toBe('passwd')
    expect(sanitiseFilename('C:\\Users\\me\\photo.png')).toBe('photo.png')
    expect(sanitiseFilename('../../secret.jpg')).toBe('secret.jpg')
  })

  it('strips characters that have meaning somewhere', () => {
    expect(sanitiseFilename('<script>.png')).toBe('_script_.png')
  })

  it('is undefined-safe and bounded', () => {
    expect(sanitiseFilename(undefined)).toBeNull()
    expect(sanitiseFilename('***')).toBe('___')
    expect((sanitiseFilename('a'.repeat(500)) ?? '').length).toBe(200)
  })
})

describe('sniffImageType', () => {
  const cases: [string, Buffer][] = [
    ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])],
    [
      'image/png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    ],
    ['image/gif', Buffer.from('GIF89a\u0000\u0000\u0000\u0000\u0000\u0000', 'binary')],
    ['image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])],
    [
      'image/avif',
      Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from('avif')]),
    ],
  ]

  it.each(cases)('recognises %s', (expected, bytes) => {
    expect(sniffImageType(bytes)).toBe(expected)
  })

  it.each([
    ['SVG, which can execute script', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['a PDF', Buffer.from('%PDF-1.7\n')],
    ['a zip / office document', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['an ELF binary', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['a shell script', Buffer.from('#!/bin/sh\nrm -rf /\n')],
    ['empty', Buffer.alloc(0)],
    ['a truncated PNG header', Buffer.from([0x89, 0x50, 0x4e])],
  ])('refuses %s', (_label, bytes) => {
    expect(sniffImageType(bytes)).toBeUndefined()
  })

  it('is not fooled by a JPEG signature that starts one byte late', () => {
    expect(sniffImageType(Buffer.from([0x00, 0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined()
  })

  it('needs no more than SNIFF_BYTES to decide', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(4096, 0x41),
    ])
    expect(sniffImageType(png.subarray(0, SNIFF_BYTES))).toBe('image/png')
  })

  it('flags container formats that warrant re-encoding', () => {
    expect(isRiskyContainer('image/webp')).toBe(true)
    expect(isRiskyContainer('image/gif')).toBe(true)
    expect(isRiskyContainer('image/jpeg')).toBe(false)
  })
})
