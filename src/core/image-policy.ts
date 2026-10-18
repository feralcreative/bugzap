// What Bugzap will accept as an image, decided from the BYTES.
//
// Ported from Routeloop's src/images/policy.ts. Pure, so test/core/image-policy.test.ts
// can pin the security boundary with nothing but byte arrays.
//
// THIS IS A SECURITY BOUNDARY, NOT A FORMAT PREFERENCE. Three rules:
//
//   1. NEVER TRUST THE EXTENSION OR THE Content-Type. Both are supplied by the
//      client and neither describes the bytes. `sniffImageType` reads the magic
//      number and nothing else.
//   2. RASTER ONLY. NO SVG, EVER. An SVG is a document that can carry script, and
//      one served back to a site owner's browser is stored XSS. It is refused by
//      construction: an SVG is text and matches no magic number below.
//   3. THE SIZE GATES COME BEFORE ANYTHING ELSE. A file over the byte cap is refused
//      on its length, and one whose header claims more pixels than the cap is
//      refused on the header, so a decompression bomb is never handed to anything
//      that would decode it.
//
// Unlike Routeloop, nothing here is re-encoded on the server: Workers cannot run
// sharp. The browser re-encodes uploads through a canvas before they are sent, and
// ./image-strip.ts removes metadata from whatever arrives without decoding it.

/** PNG and JPEG only. The widget produces exactly these (a canvas exports either),
 *  so anything else arriving was not produced by the widget. */
export const ACCEPTED_TYPES = ['jpeg', 'png'] as const
export type ImageType = (typeof ACCEPTED_TYPES)[number]

export const MIME: Record<ImageType, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
}

/** 2 MB. Twice Routeloop's cap, because a screenshot of a busy page is a large PNG
 *  where a phone photo shrunk to 1600px is a small JPEG. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

/**
 * A ceiling on DECODED pixels, which the byte cap does not give you.
 *
 * A small file can describe an enormous image: a highly compressible PNG can decode
 * to hundreds of megapixels and exhaust the memory of whoever opens it. Bugzap never
 * decodes on the server, but the site owner's browser does, so the bound still matters.
 */
export const MAX_IMAGE_PIXELS = 40_000_000

// Magic numbers, as bytes. Arrays rather than a regex over a string because a byte
// array is what arrives, and turning it into a string to test it is how an encoding
// assumption sneaks in.
const MAGIC: Array<{ type: ImageType; bytes: number[] }> = [
  // JPEG: SOI marker, then the start of any APPn/DQT segment.
  { type: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  // PNG: the 8-byte signature, which deliberately includes CRLF and EOF bytes so a
  // file mangled by a text-mode transfer fails to match.
  { type: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
]

/**
 * What these bytes actually are, or null.
 *
 * Null covers every refusal that is not about size: a GIF, a WebP, a PDF, an SVG, an
 * HTML file named `shot.png`, and an empty upload. The caller does not need them
 * distinguished; the answer to all of them is the same.
 */
export function sniffImageType(data: Uint8Array): ImageType | null {
  for (const { type, bytes } of MAGIC) {
    if (data.length < bytes.length) continue
    let match = true
    for (let i = 0; i < bytes.length; i++) {
      if (data[i] !== bytes[i]) {
        match = false
        break
      }
    }
    if (match) return type
  }
  return null
}

export type ImageSize = { width: number; height: number }

/**
 * The dimensions the file's header claims, without decoding a pixel.
 *
 * PNG: the IHDR chunk, which the spec requires to come first. JPEG: the first
 * start-of-frame marker, found by walking segment lengths. Null when the header is
 * not where it should be, which is itself grounds to refuse the file.
 */
export function readImageSize(data: Uint8Array, type: ImageType): ImageSize | null {
  return type === 'png' ? pngSize(data) : jpegSize(data)
}

const u16 = (d: Uint8Array, i: number) => ((d[i] ?? 0) << 8) | (d[i + 1] ?? 0)
const u32 = (d: Uint8Array, i: number) => u16(d, i) * 0x10000 + u16(d, i + 2)

function pngSize(d: Uint8Array): ImageSize | null {
  // Signature (8), then length (4) and type (4) of the first chunk, which must be IHDR.
  if (d.length < 24) return null
  if (d[12] !== 0x49 || d[13] !== 0x48 || d[14] !== 0x44 || d[15] !== 0x52) return null
  const width = u32(d, 16)
  const height = u32(d, 20)
  return width > 0 && height > 0 ? { width, height } : null
}

// SOF0–SOF15 carry the frame size, except C4 (DHT), C8 (reserved) and CC (DAC),
// which share the range without being frames.
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc

function jpegSize(d: Uint8Array): ImageSize | null {
  let i = 2 // past SOI
  while (i + 4 <= d.length) {
    if (d[i] !== 0xff) return null
    const marker = d[i + 1] ?? 0
    // Fill bytes: a run of 0xFF before a marker is legal padding.
    if (marker === 0xff) {
      i++
      continue
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    // Scan data, or end of image, before any frame header: not a usable file.
    if (marker === 0xda || marker === 0xd9) return null
    const len = u16(d, i + 2)
    if (len < 2) return null
    if (isSof(marker)) {
      if (i + 9 > d.length) return null
      const height = u16(d, i + 5)
      const width = u16(d, i + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    i += 2 + len
  }
  return null
}

export type UploadRefusal = 'empty' | 'too-large' | 'unsupported' | 'too-many-pixels'
export type UploadCheck = { ok: true; type: ImageType; size: ImageSize } | { ok: false; reason: UploadRefusal }

/**
 * Whether these bytes may be stored at all.
 *
 * Order matters: length first, so an oversized file is refused without this function
 * reading into it; then the magic number; then the header's claimed size.
 */
export function checkUpload(data: Uint8Array): UploadCheck {
  if (data.length === 0) return { ok: false, reason: 'empty' }
  if (data.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' }
  const type = sniffImageType(data)
  if (!type) return { ok: false, reason: 'unsupported' }
  const size = readImageSize(data, type)
  if (!size) return { ok: false, reason: 'unsupported' }
  if (size.width * size.height > MAX_IMAGE_PIXELS) return { ok: false, reason: 'too-many-pixels' }
  return { ok: true, type, size }
}

export const UPLOAD_REFUSAL_MESSAGES: Record<UploadRefusal, string> = {
  empty: 'That file was empty.',
  'too-large': `Images have to be ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB or smaller.`,
  unsupported: 'That has to be a JPEG or a PNG.',
  'too-many-pixels': 'That image is too large to open.',
}
