/**
 * Choosing a variant, one option at a time.
 *
 * The storefront used to list whole variants as flat chips — "Small / Classic",
 * "Large / Thin" — which works for two variants and falls apart at twelve. A
 * shopper does not think "I want the Large/Thin one"; they think "large", and
 * then "thin". So the picker asks one question per axis, and this module turns
 * the answers back into a variant.
 *
 * Everything here is pure and lives apart from the components, because every
 * one of these functions is a place a subtle bug hides quietly — the kind that
 * shows the wrong price rather than throwing.
 *
 * **Nothing here decides what anything costs or whether it is in stock.** Those
 * are read off the variant the server sent. This module only answers "which
 * variant did they mean".
 */

/**
 * Is this a colour axis?
 *
 * Answered by the data, never by the name. The server publishes a `swatchHex`
 * the merchant set; if any value on the option carries one, it is a colour
 * axis. A storefront that matched on the word "Colour" would fail on "Shade",
 * on "Farbe", and on every catalogue not written in English.
 */
export function isColourOption(option) {
  return option.values.some((value) => value.swatchHex !== null)
}

/**
 * What a variant has chosen, as `{ optionName: valueId }`.
 *
 * Keyed by option *name* because that is what the public variant DTO carries —
 * `{ name, value, valueId }` — and it is the only key both sides agree on.
 */
export function selectionOf(variant) {
  const selection = {}
  for (const option of variant?.options ?? []) selection[option.name] = option.valueId
  return selection
}

/** The variant that matches every choice, or null when the pair is not stocked. */
export function variantFor(product, selection) {
  const names = product.options.map((option) => option.name)
  return (
    product.variants.find((variant) => {
      const has = selectionOf(variant)
      return names.every((name) => has[name] === selection[name])
    }) ?? null
  )
}

/**
 * The first variant a shopper could actually buy, falling back to the first
 * one that exists.
 *
 * The fallback matters: a wholly sold-out product must still render a coherent
 * page with a price and a picker, rather than a blank column.
 */
export function initialVariant(product) {
  return product.variants.find((variant) => variant.available) ?? product.variants[0] ?? null
}

/**
 * Which values on one option lead anywhere, given what else is chosen.
 *
 * Two different answers, and the difference is the whole point:
 *
 *   • `exists: false` — no variant pairs this value with the current choices.
 *     Picking "Thin" when only "Classic" comes in Large is a dead end, and
 *     showing it as available would produce a picker that silently corrects
 *     itself when clicked.
 *   • `available: false` — the pairing exists and is out of stock. That is
 *     information the shopper wants: the large exists, and they cannot have it.
 *
 * Both are marked, differently, rather than hidden. Hiding a sold-out size
 * leaves somebody wondering whether it was ever made.
 */
export function valueStates(product, option, selection) {
  const states = {}
  for (const value of option.values) {
    const candidate = { ...selection, [option.name]: value.id }
    const match = variantFor(product, candidate)
    states[value.id] = {
      exists: match !== null,
      available: match?.available ?? false,
    }
  }
  return states
}

/**
 * Choosing a value, and repairing the rest of the selection if it breaks.
 *
 * Picking "Mulberry" when the current size is one Mulberry does not come in
 * would otherwise leave the picker pointing at a variant that does not exist.
 * Rather than refuse the click — the shopper asked for Mulberry, and they
 * should get Mulberry — the other axes fall back to the first combination that
 * does exist, preferring one in stock.
 */
export function chooseValue(product, selection, option, valueId) {
  const wanted = { ...selection, [option.name]: valueId }
  if (variantFor(product, wanted)) return wanted

  const rescue =
    product.variants.find(
      (variant) => selectionOf(variant)[option.name] === valueId && variant.available,
    ) ?? product.variants.find((variant) => selectionOf(variant)[option.name] === valueId)

  return rescue ? selectionOf(rescue) : selection
}

/**
 * The image to show for the chosen variant.
 *
 * A variant's own image is one of the product's own images — the server's
 * composite foreign key guarantees it — so this returns the *index* into the
 * gallery rather than a loose URL. That way picking a colour moves the gallery
 * to that photo, thumbnails and all, instead of swapping one picture out from
 * under a filmstrip that still points somewhere else.
 *
 * Returns null when the variant has no image of its own, which is the common
 * case and means "leave the gallery where it is".
 */
export function galleryIndexFor(product, variant) {
  if (!variant?.image?.url) return null
  const index = product.images.findIndex((image) => image.url === variant.image.url)
  return index === -1 ? null : index
}
