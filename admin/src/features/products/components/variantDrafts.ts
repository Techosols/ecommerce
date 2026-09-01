import type { OptionInput, VariantInput } from '../types/products.types'

/** The server allows at most 3 option axes and 100 variants per product. */
export const MAX_OPTIONS = 3
export const MAX_VARIANTS = 100

export interface OptionDraft {
  name: string
  values: string[]
}

export interface VariantDraft {
  /** `{ Size: 'Large' }` — the shape `createVariantSchema` expects. */
  options: Record<string, string>
  priceAmount: number | null
  compareAtAmount: number | null
  sku: string
  barcode: string
}

/** A stable key for one combination, independent of the order it was built in. */
export function signatureOf(selection: Record<string, string>): string {
  return Object.keys(selection)
    .sort()
    .map((name) => `${name}=${selection[name]!}`)
    .join('|')
}

/** Every combination of the option values, in the order the axes are declared. */
export function combinationsOf(options: OptionDraft[]): Array<Record<string, string>> {
  const usable = options.filter((option) => option.name.trim() !== '' && option.values.length > 0)
  if (usable.length === 0) return []

  return usable.reduce<Array<Record<string, string>>>(
    (rows, option) =>
      rows.flatMap((row) =>
        option.values.map((value) => ({ ...row, [option.name.trim()]: value })),
      ),
    [{}],
  )
}

export function emptyVariantDraft(): VariantDraft {
  return { options: {}, priceAmount: null, compareAtAmount: null, sku: '', barcode: '' }
}

/**
 * Turns the drafts into the payload `createProductSchema` accepts.
 *
 * Empty strings become absent fields rather than empty ones: the server's SKU
 * column is unique, and two products both sending `sku: ""` would collide on a
 * value neither of them meant to set.
 */
export function toVariantInputs(
  hasOptions: boolean,
  options: OptionDraft[],
  variants: Record<string, VariantDraft>,
  single: VariantDraft,
): { options: OptionInput[]; variants: VariantInput[] } {
  if (!hasOptions) {
    return {
      options: [],
      variants: [
        {
          priceAmount: single.priceAmount ?? 0,
          ...(single.compareAtAmount !== null ? { compareAtAmount: single.compareAtAmount } : {}),
          ...(single.sku.trim() ? { sku: single.sku.trim() } : {}),
          ...(single.barcode.trim() ? { barcode: single.barcode.trim() } : {}),
        },
      ],
    }
  }

  const usable = options
    .map((option) => ({ name: option.name.trim(), values: option.values }))
    .filter((option) => option.name !== '' && option.values.length > 0)

  const rows = combinationsOf(options).map((selection) => {
    const draft = variants[signatureOf(selection)]
    return {
      options: selection,
      priceAmount: draft?.priceAmount ?? 0,
      ...(draft?.compareAtAmount != null ? { compareAtAmount: draft.compareAtAmount } : {}),
      ...(draft?.sku.trim() ? { sku: draft.sku.trim() } : {}),
      ...(draft?.barcode.trim() ? { barcode: draft.barcode.trim() } : {}),
    }
  })

  return { options: usable, variants: rows }
}
