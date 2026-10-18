// Metadata removal, without a decoder.
//
// The property that matters is the one a reviewer cannot check by reading: that a
// phone photo's GPS coordinates, and anything else hiding in a file's side channels,
// are gone after the strip while the pixel data is untouched.
import { describe, expect, it } from 'vitest'
import { readImageSize, sniffImageType } from '../../src/core/image-policy'
import { stripMetadata } from '../../src/core/image-strip'
import { contains, jpeg, png, SECRET } from './fixtures/images'

describe('stripMetadata: JPEG', () => {
  const out = stripMetadata(jpeg(), 'jpeg')

  it('removes EXIF, vendor segments, comments, and anything after the end of the image', () => {
    expect(contains(jpeg(), SECRET)).toBe(true)
    expect(out).not.toBeNull()
    expect(contains(out as Uint8Array, SECRET)).toBe(false)
  })

  it('keeps JFIF and the ICC profile, which change how the colors decode', () => {
    expect(contains(out as Uint8Array, 'JFIF')).toBe(true)
    expect(contains(out as Uint8Array, 'ICC_PROFILE')).toBe(true)
  })

  it('leaves a file that is still a JPEG of the same size', () => {
    expect(sniffImageType(out as Uint8Array)).toBe('jpeg')
    expect(readImageSize(out as Uint8Array, 'jpeg')).toEqual({
      width: 640,
      height: 480,
    })
  })

  // The scan data has a stuffed FF00 and a restart marker in it; both are pixel
  // data, not segment boundaries, and must come through byte for byte.
  it('copies the entropy-coded data through unchanged and ends on the end-of-image marker', () => {
    const o = out as Uint8Array
    const tail = Array.from(o.subarray(o.length - 10))
    expect(tail).toEqual([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0xff, 0xd9])
  })

  it('is idempotent', () => {
    expect(stripMetadata(out as Uint8Array, 'jpeg')).toEqual(out)
  })

  it('refuses a file it cannot walk, rather than passing it through', () => {
    const truncated = jpeg({ trailing: false }).subarray(0, 60)
    expect(stripMetadata(truncated, 'jpeg')).toBeNull()
    expect(stripMetadata(Uint8Array.from([0xff, 0xd8, 0x00, 0x00]), 'jpeg')).toBeNull()
  })
})

describe('stripMetadata: PNG', () => {
  const out = stripMetadata(png(), 'png')

  it('removes text, EXIF and time chunks, and anything after IEND', () => {
    expect(contains(png(), SECRET)).toBe(true)
    expect(out).not.toBeNull()
    expect(contains(out as Uint8Array, SECRET)).toBe(false)
    expect(contains(out as Uint8Array, 'tIME')).toBe(false)
  })

  it('keeps the chunks that describe pixels', () => {
    for (const kept of ['IHDR', 'sRGB', 'IDAT', 'IEND']) expect(contains(out as Uint8Array, kept), kept).toBe(true)
    expect(readImageSize(out as Uint8Array, 'png')).toEqual({
      width: 800,
      height: 600,
    })
  })

  it('refuses a PNG with a chunk length that runs past the end', () => {
    const bad = png({ trailing: false })
    bad[8 + 3] = 0xff // IHDR's length, now far longer than the file
    expect(stripMetadata(bad, 'png')).toBeNull()
  })

  it('refuses a PNG with no IEND', () => {
    const full = png({ trailing: false })
    expect(stripMetadata(full.subarray(0, full.length - 12), 'png')).toBeNull()
  })
})
