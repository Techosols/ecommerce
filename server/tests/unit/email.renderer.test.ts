import { describe, expect, it } from 'vitest'
import { renderTemplate } from '../../src/infrastructure/email/renderer.js'
import { EMAIL_TEMPLATES } from '../../src/infrastructure/email/templates/registry.js'

const branding = { storeName: 'Test Store', supportEmail: 'help@example.test' }

describe('email rendering', () => {
  it('produces HTML and a plain-text alternative', async () => {
    const rendered = await renderTemplate(
      'system-check',
      { environment: 'staging', triggeredAt: '2026-08-29T10:00:00Z' },
      branding,
    )

    expect(rendered.subject).toBe('Email delivery check — staging')
    expect(rendered.html).toContain('<html')
    expect(rendered.html).toContain('Test Store')
    expect(rendered.html).toContain('staging')
    expect(rendered.text).toContain('staging')
    expect(rendered.text).not.toContain('<')
  })

  it('honours conditional blocks', async () => {
    const withNote = await renderTemplate(
      'system-check',
      { environment: 'local', triggeredAt: 'now', note: 'post-deploy check' },
      branding,
    )
    const withoutNote = await renderTemplate(
      'system-check',
      { environment: 'local', triggeredAt: 'now' },
      branding,
    )

    expect(withNote.html).toContain('post-deploy check')
    expect(withoutNote.html).not.toContain('Note:')
  })

  it('escapes interpolated values, so template data cannot inject markup', async () => {
    const rendered = await renderTemplate(
      'system-check',
      { environment: '<script>alert(1)</script>', triggeredAt: 'now' },
      branding,
    )
    expect(rendered.html).not.toContain('<script>alert(1)</script>')
    expect(rendered.html).toContain('&lt;script&gt;')
  })

  it('rejects props that do not match the template schema', async () => {
    await expect(
      renderTemplate('system-check', { environment: 'x' } as never, branding),
    ).rejects.toThrow()
  })

  it('gives every registered template a subject builder and a schema', () => {
    for (const definition of Object.values(EMAIL_TEMPLATES)) {
      expect(typeof definition.subject).toBe('function')
      expect(definition.schema).toBeDefined()
      expect(definition.dir).toBeTruthy()
    }
  })
})
