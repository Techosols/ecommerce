/**
 * Real image fixtures (§20.3).
 *
 * Generated with sharp rather than checked in as base64 blobs, so a test can
 * ask for the size and format it needs — and so the bytes the pipeline decodes
 * are genuinely decodable rather than a plausible-looking header.
 */
import sharp from 'sharp'

export async function makePng(width = 32, height = 32): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } },
  })
    .png()
    .toBuffer()
}

export async function makeJpeg(width = 32, height = 32): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } },
  })
    .jpeg()
    .toBuffer()
}

export async function makeWebp(width = 32, height = 32): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 200, b: 40 } },
  })
    .webp()
    .toBuffer()
}

/**
 * A JPEG carrying EXIF, including a GPS position. Used to prove the pipeline
 * strips location data rather than republishing where a photo was taken.
 */
export async function makeJpegWithExif(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 32, channels: 3, background: { r: 90, g: 90, b: 90 } },
  })
    .withExif({
      IFD0: { Copyright: 'Test', Make: 'TestCam' },
      IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'W' },
    })
    .jpeg()
    .toBuffer()
}

/**
 * A polyglot: a valid PNG with an HTML/script payload appended. Sniffing alone
 * accepts it — re-encoding is what removes the payload.
 */
export async function makePolyglotPng(): Promise<Buffer> {
  const png = await makePng()
  return Buffer.concat([png, Buffer.from('<script>alert(document.cookie)</script>')])
}
