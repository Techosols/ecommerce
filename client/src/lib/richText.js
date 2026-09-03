/**
 * Descriptions arrive from the API as HTML.
 *
 * The admin writes them in a rich text editor and the server sanitises what it
 * stores (`shared/validation/richText.ts`), so by the time a description
 * reaches this page it is already an allowlisted subset of HTML — that is the
 * guarantee `dangerouslySetInnerHTML` leans on wherever the storefront renders
 * one in full.
 *
 * Some places do not want the markup at all. A collection card gives its
 * description two clamped lines; a heading tag or a table inside those two
 * lines would break the card's layout, and half an open element is not
 * something to hand to a browser. Those places want the words.
 */

/**
 * The readable text inside a fragment of description HTML.
 *
 * Block boundaries become a space first, so `<p>Balm</p><p>Rich</p>` reads as
 * "Balm Rich" rather than "BalmRich" — running two sentences together is the
 * kind of thing a shopper notices even in a two-line teaser.
 *
 * Parsing rather than a regex: the tag soup a regex mishandles is exactly the
 * soup a person's description turns into after a paste from Word.
 *
 * @param {string | null | undefined} html
 * @returns {string}
 */
export function richTextToPlain(html) {
  if (!html) return ''

  const spaced = html.replace(/<\/(p|div|li|h[1-6]|tr|td|th|blockquote|pre)>/gi, ' ')

  // `template` parses without fetching anything: an `<img>` inside it never
  // hits the network and a `<script>` never runs, which a detached `<div>`
  // with `innerHTML` does not promise on every engine.
  const template = document.createElement('template')
  template.innerHTML = spaced

  return (template.content.textContent ?? '').replace(/\s+/g, ' ').trim()
}
