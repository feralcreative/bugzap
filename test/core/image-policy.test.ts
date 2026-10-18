// The image boundary.
//
// Ported from Routeloop's test/images.test.ts. Most of what is below is about things
// that must NOT be accepted: an SVG above all, because an accepted one is stored XSS
// in the owner's dashboard. The processImage half of that file tested sharp, which
// Workers cannot run; its replacement is test/core/image-strip.test.ts.
import { describe, expect, it } from 'vitest'
import {
  ACCEPTED_TYPES,
  checkUpload,
  MAX_IMAGE_BYTES,
  readImageSize,
  sniffImageType,
  UPLOAD_REFUSAL_MESSAGES,
} from '../../src/core/image-policy'
import { jpeg, png } from './fixtures/images'

const bytes = (...b: number[]) => Uint8Array.from(b)
const JPEG_HEAD = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)
const PNG_HEAD = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00)

describe('sniffImageType', () => {
  it('knows the two formats it accepts', () => {
    expect(sniffImageType(JPEG_HEAD)).toBe('jpeg')
    expect(sniffImageType(PNG_HEAD)).toBe('png')
    expect(ACCEPTED_TYPES).toEqual(['jpeg', 'png'])
  })

  // THE ONE THAT MATTERS. This test is what stops someone "helpfully" adding SVG to
  // the accepted list later.
  it('refuses an SVG, however it is dressed up', () => {
    for (const svg of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '<?xml version="1.0"?><svg/>', '  <svg />']) {
      expect(sniffImageType(new TextEncoder().encode(svg)), svg).toBeNull()
    }
  })

  it('refuses other real image formats, which are not the same as unsafe', () => {
    expect(sniffImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBeNull() // GIF89a
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBeNull() // WEBP
    expect(sniffImageType(bytes(0x25, 0x50, 0x44, 0x46))).toBeNull() // %PDF
  })

  it('refuses HTML wearing a png name', () => {
    expect(sniffImageType(new TextEncoder().encode('<!doctype html><script>alert(1)</script>'))).toBeNull()
  })

  it('is not fooled by a magic number that appears later in the file', () => {
    expect(sniffImageType(bytes(0x00, 0xff, 0xd8, 0xff))).toBeNull()
  })

  it('handles a buffer shorter than the signature it is testing', () => {
    expect(sniffImageType(bytes(0x89, 0x50))).toBeNull()
    expect(sniffImageType(bytes())).toBeNull()
  })
})

describe('readImageSize', () => {
  it('reads a PNG from its IHDR chunk', () => {
    expect(readImageSize(png({ width: 1234, height: 567 }), 'png')).toEqual({
      width: 1234,
      height: 567,
    })
  })

  // The frame header sits behind several metadata segments in a real phone photo,
  // so this walks past APP0, APP1, APP2, APP13, COM, DQT to reach it.
  it('reads a JPEG from its start-of-frame, past the metadata segments', () => {
    expect(readImageSize(jpeg({ width: 1600, height: 900 }), 'jpeg')).toEqual({
      width: 1600,
      height: 900,
    })
  })

  it('returns null for a header that is not where it should be', () => {
    expect(readImageSize(PNG_HEAD, 'png')).toBeNull()
    expect(readImageSize(JPEG_HEAD, 'jpeg')).toBeNull()
  })
})

describe('checkUpload', () => {
  it('accepts a real-shaped file and reports its size', () => {
    expect(checkUpload(png({ width: 10, height: 20 }))).toEqual({
      ok: true,
      type: 'png',
      size: { width: 10, height: 20 },
    })
  })

  it('refuses an empty upload distinctly from an unreadable one', () => {
    expect(checkUpload(bytes())).toEqual({ ok: false, reason: 'empty' })
    expect(checkUpload(bytes(1, 2, 3))).toEqual({
      ok: false,
      reason: 'unsupported',
    })
  })

  // Order is the point: an oversized file must be refused on its length, before
  // anything reads into it.
  it('refuses an oversized file even when it is a real JPEG', () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1)
    big.set(jpeg(), 0)
    expect(checkUpload(big)).toEqual({ ok: false, reason: 'too-large' })
  })

  // A decompression bomb: a tiny file whose header claims an enormous image.
  it('refuses a small file whose header claims too many pixels', () => {
    expect(checkUpload(png({ width: 50_000, height: 50_000 }))).toEqual({
      ok: false,
      reason: 'too-many-pixels',
    })
  })

  it('refuses a file whose magic number is right but whose header is missing', () => {
    expect(checkUpload(JPEG_HEAD)).toEqual({
      ok: false,
      reason: 'unsupported',
    })
  })

  it('has a message for every refusal it can return', () => {
    for (const reason of ['empty', 'too-large', 'unsupported', 'too-many-pixels'] as const) {
      expect(UPLOAD_REFUSAL_MESSAGES[reason], reason).toBeTruthy()
    }
  })
})
