// Metadata removal without a decoder.
//
// Routeloop re-encoded every upload through sharp, which drops metadata as a side
// effect. Workers cannot run sharp, so this does the one part of that job that
// matters for privacy, structurally: it walks the file's segments or chunks and
// copies through only the ones that describe pixels.
//
// What it removes, and why each one matters:
//
//   - JPEG APP1 (EXIF and XMP). EXIF carries GPS coordinates, the camera serial
//     number and the time the photo was taken. A phone photo uploaded as "here is
//     the bug" would otherwise publish where the reporter was standing.
//   - JPEG APP13 (Photoshop/IPTC), COM comments, and every other APPn segment that
//     is not one of the three below. Vendor segments are free-form and routinely
//     hold names, paths and device details.
//   - PNG eXIf, tEXt, iTXt, zTXt and tIME chunks: the PNG equivalents.
//   - Anything after the end-of-image marker or the IEND chunk. Phones append
//     secondary images there (multi-picture JPEGs), and so does anyone hiding a
//     payload in an image.
//
// What it keeps in a JPEG beyond the pixel data: APP0 (JFIF), APP2 when it is an
// ICC profile, and APP14 when it is Adobe's, because dropping either of the last
// two changes how the colors decode.
//
// Orientation is lost with EXIF. That is acceptable because the widget draws every
// upload through a canvas first, which applies the orientation to the pixels.
//
// Returns null for a file whose structure does not parse. The caller refuses it:
// a file that cannot be walked cannot be shown to be clean.
import type { ImageType } from './image-policy'

export function stripMetadata(data: Uint8Array, type: ImageType): Uint8Array | null {
  try {
    return type === 'png' ? stripPng(data) : stripJpeg(data)
  } catch {
    return null
  }
}

const u16 = (d: Uint8Array, i: number) => ((d[i] ?? 0) << 8) | (d[i + 1] ?? 0)
const u32 = (d: Uint8Array, i: number) => u16(d, i) * 0x10000 + u16(d, i + 2)
const ascii = (d: Uint8Array, start: number, text: string) => {
  for (let k = 0; k < text.length; k++) if (d[start + k] !== text.charCodeAt(k)) return false
  return true
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// --- JPEG --------------------------------------------------------------------

/** Whether an APPn or COM segment survives. `body` is the index just past the length. */
function keepAppSegment(d: Uint8Array, marker: number, body: number): boolean {
  if (marker === 0xe0) return ascii(d, body, 'JFIF\0') || ascii(d, body, 'JFXX\0')
  if (marker === 0xe2) return ascii(d, body, 'ICC_PROFILE\0')
  if (marker === 0xee) return ascii(d, body, 'Adobe')
  return false
}

const isApp = (m: number) => m >= 0xe0 && m <= 0xef

function stripJpeg(d: Uint8Array): Uint8Array | null {
  if (d[0] !== 0xff || d[1] !== 0xd8) return null
  const parts: Uint8Array[] = [d.subarray(0, 2)]
  let i = 2

  while (i < d.length) {
    if (d[i] !== 0xff) return null
    const marker = d[i + 1]
    if (marker === undefined) return null
    if (marker === 0xff) {
      i++ // fill byte
      continue
    }
    if (marker === 0xd9) {
      // End of image. Everything after it is dropped, which is the point.
      parts.push(d.subarray(i, i + 2))
      return concat(parts)
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(d.subarray(i, i + 2))
      i += 2
      continue
    }

    const len = u16(d, i + 2)
    const end = i + 2 + len
    if (len < 2 || end > d.length) return null

    const dropped = (isApp(marker) || marker === 0xfe) && !keepAppSegment(d, marker, i + 4)
    if (!dropped) parts.push(d.subarray(i, end))
    i = end

    if (marker === 0xda) {
      // Start of scan: entropy-coded data follows the header and runs until the
      // next real marker. Inside it, 0xFF is either stuffed (FF 00) or a restart
      // marker (FF D0–D7); anything else ends the scan. A progressive JPEG has
      // several scans, so the loop resumes parsing segments afterwards.
      const scanStart = i
      while (i < d.length) {
        if (d[i] === 0xff) {
          const next = d[i + 1]
          if (next === undefined) return null
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            i += next === 0xff ? 1 : 2
            continue
          }
          break
        }
        i++
      }
      parts.push(d.subarray(scanStart, i))
    }
  }
  // Ran off the end without an end-of-image marker: truncated.
  return null
}

// --- PNG ---------------------------------------------------------------------

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'])

function stripPng(d: Uint8Array): Uint8Array | null {
  if (d.length < 8) return null
  const parts: Uint8Array[] = [d.subarray(0, 8)]
  let i = 8
  while (i + 12 <= d.length) {
    const len = u32(d, i)
    const end = i + 12 + len // length + type + data + crc
    if (end > d.length) return null
    const type = String.fromCharCode(d[i + 4] ?? 0, d[i + 5] ?? 0, d[i + 6] ?? 0, d[i + 7] ?? 0)
    if (!PNG_DROP.has(type)) parts.push(d.subarray(i, end))
    if (type === 'IEND') return concat(parts)
    i = end
  }
  return null
}
