/**
 * Rich text sanitisation (§16.3).
 *
 * This suite is the reason the feature is safe to ship. A product description
 * is written by one browser and rendered in every other browser that visits the
 * shop, so every case below is a real stored-XSS payload that must not survive
 * a round trip.
 *
 * If any of these ever fails, the storefront is executing somebody else's
 * script on the checkout page.
 */
import { describe, expect, it } from 'vitest'
import { richTextToPlain, sanitiseRichText } from '../../src/shared/validation/richText.js'

describe('what must not survive', () => {
  it('drops a script tag and its contents', () => {
    const clean = sanitiseRichText('<p>Hello</p><script>alert(document.cookie)</script>')
    expect(clean).toBe('<p>Hello</p>')
    expect(clean).not.toMatch(/alert/)
  })

  it('drops an event handler, keeping the element', () => {
    // The classic one: a perfectly ordinary tag carrying executable script.
    const clean = sanitiseRichText('<img src="x" onerror="fetch(\'https://evil\')" alt="a">')
    expect(clean).toMatch(/<img/)
    expect(clean).not.toMatch(/onerror/i)
  })

  it('drops a javascript: href, keeping the text', () => {
    const clean = sanitiseRichText('<a href="javascript:alert(1)">Click me</a>')
    expect(clean).not.toMatch(/javascript:/i)
    expect(clean).toMatch(/Click me/)
  })

  it('drops inline style entirely', () => {
    // Arbitrary CSS positions an invisible overlay across the page and harvests
    // clicks. No product description needs it.
    const clean = sanitiseRichText(
      '<p style="position:fixed;inset:0;opacity:0">Trap</p>',
    )
    expect(clean).not.toMatch(/style=/)
    expect(clean).toMatch(/Trap/)
  })

  it('refuses an iframe pointing anywhere but a video host', () => {
    // An unrestricted iframe is a page inside your page — it can cover the
    // checkout form with a copy of itself.
    expect(sanitiseRichText('<iframe src="https://evil.test/login"></iframe>')).toBe(null)
    expect(sanitiseRichText('<iframe src="/admin"></iframe>')).toBe(null)
  })

  it('keeps a YouTube embed', () => {
    const clean = sanitiseRichText(
      '<iframe src="https://www.youtube.com/embed/abc123" allowfullscreen></iframe>',
    )
    expect(clean).toMatch(/youtube\.com\/embed\/abc123/)
  })

  it('adds noopener to a link that opens a new tab', () => {
    // Without it the opened page holds a live reference to your window and can
    // navigate your tab to a copy of your own login screen.
    const clean = sanitiseRichText('<a href="https://x.test" target="_blank">Go</a>')
    expect(clean).toMatch(/rel="noopener noreferrer nofollow"/)
  })

  it('survives a payload dressed up to look like markup it allows', () => {
    const clean = sanitiseRichText(
      '<p>ok</p><svg/onload=alert(1)><math><mtext><table><mglyph><style><img src=x onerror=alert(2)>',
    )
    expect(clean).not.toMatch(/onload|onerror|alert/i)
  })

  it('does not let a data: URI become script', () => {
    const clean = sanitiseRichText(
      '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
    )
    expect(clean).not.toMatch(/data:text\/html/)
  })
})

describe('what must survive', () => {
  it('keeps the formatting the editor produces', () => {
    const input =
      '<h2>Ingredients</h2><p><strong>Bold</strong> and <em>italic</em> and <u>underlined</u>.</p>' +
      '<ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol>' +
      '<blockquote>Quoted</blockquote><hr />'
    const clean = sanitiseRichText(input)
    for (const tag of ['h2', 'strong', 'em', 'u', 'ul', 'li', 'ol', 'blockquote', 'hr']) {
      expect(clean).toMatch(new RegExp(`<${tag}`))
    }
  })

  it('keeps alignment classes, which is how alignment is stored', () => {
    const clean = sanitiseRichText('<p class="text-center">Middle</p>')
    expect(clean).toMatch(/class="text-center"/)
  })

  it('keeps a table', () => {
    const clean = sanitiseRichText(
      '<table><tbody><tr><th colspan="2">Size</th></tr><tr><td>S</td><td>36</td></tr></tbody></table>',
    )
    expect(clean).toMatch(/<table/)
    expect(clean).toMatch(/colspan="2"/)
  })

  it('keeps an ordinary image with its alt text', () => {
    const clean = sanitiseRichText('<img src="https://cdn.test/a.jpg" alt="A jar of balm">')
    expect(clean).toMatch(/src="https:\/\/cdn\.test\/a\.jpg"/)
    expect(clean).toMatch(/alt="A jar of balm"/)
  })
})

describe('emptiness', () => {
  it('leaves null and undefined alone', () => {
    expect(sanitiseRichText(null)).toBe(null)
    expect(sanitiseRichText(undefined)).toBe(undefined)
  })

  it('turns what an emptied editor leaves behind into null', () => {
    // Otherwise "has a description" is a question the database answers wrongly
    // for every product somebody typed into and then cleared.
    expect(sanitiseRichText('<p></p>')).toBe(null)
    expect(sanitiseRichText('<p><br /></p>')).toBe(null)
    expect(sanitiseRichText('   ')).toBe(null)
  })

  it('keeps a document whose only content is an image', () => {
    expect(sanitiseRichText('<p><img src="https://cdn.test/a.jpg"></p>')).toMatch(/<img/)
  })
})

describe('plain text', () => {
  it('strips markup for previews and meta descriptions', () => {
    expect(richTextToPlain('<h2>Balm</h2><p>Rich  and <strong>soft</strong>.</p>')).toBe(
      'Balm Rich and soft.',
    )
  })
})
