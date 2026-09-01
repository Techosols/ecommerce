/**
 * Content-type sniffing from magic bytes (§16.3).
 *
 * An upload's declared content type is a claim by an untrusted party. The only
 * thing that decides what a file *is* is its leading bytes, so every object is
 * sniffed after it lands and before anything is allowed to reference it.
 *
 * This is a short allowlist rather than a general detector on purpose: we
 * accept five image formats, so recognising exactly those and rejecting
 * everything else is both simpler and stricter than a library that recognises
 * two hundred.
 */
export type SniffedType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/avif'

/** Bytes needed for the longest signature we check (AVIF's `ftyp` box). */
export const SNIFF_BYTES = 32

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false
  return bytes.every((byte, index) => buffer[offset + index] === byte)
}

export function sniffImageType(buffer: Buffer): SniffedType | undefined {
  // JPEG: FF D8 FF
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg'

  // PNG: 89 P N G \r \n 1A \n
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'

  // GIF: "GIF87a" / "GIF89a"
  if (buffer.length >= 6) {
    const header = buffer.toString('ascii', 0, 6)
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  }

  // RIFF container: "RIFF" ....  "WEBP"
  if (buffer.length >= 12) {
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      return 'image/webp'
    }
  }

  // ISO-BMFF: size, "ftyp", then a brand. AVIF brands are avif / avis.
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
  }

  return undefined
}

/**
 * Formats that can carry active content or be crafted as polyglots. Every
 * accepted image is re-encoded regardless, but flagging these makes the reason
 * explicit where it matters.
 */
export function isRiskyContainer(type: SniffedType): boolean {
  // SVG is not in the allowlist at all, precisely because it is a document
  // that can execute script. GIF can carry crafted frames; WebP and AVIF are
  // container formats with a history of decoder bugs.
  return type === 'image/gif' || type === 'image/webp' || type === 'image/avif'
}
