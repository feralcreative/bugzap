// Hand-built image files, byte by byte.
//
// Neither the Worker nor the tests can decode an image, so these are not valid
// pictures: they are valid STRUCTURES, which is all sniffing, sizing and metadata
// stripping ever look at. Each one carries a marker string in every place metadata
// can hide, so a test can assert the string is gone.

export const SECRET = 'GPS-37.7749,-122.4194'
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0))

/** A JPEG segment: FF, marker, two-byte length that counts itself, payload. */
function seg(marker: number, payload: number[]): number[] {
  const len = payload.length + 2
  return [0xff, marker, len >> 8, len & 0xff, ...payload]
}

export function jpeg({ width = 640, height = 480, trailing = true } = {}): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8, // SOI
    ...seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), // APP0, kept
    ...seg(0xe1, [...ascii('Exif'), 0, 0, ...ascii(SECRET)]), // APP1, dropped
    ...seg(0xe2, [...ascii('ICC_PROFILE'), 0, 1, 1, 9, 9]), // APP2 ICC, kept
    ...seg(0xe2, [...ascii('MPF'), 0, ...ascii(SECRET)]), // APP2 not ICC, dropped
    ...seg(0xed, [...ascii('Photoshop 3.0'), 0, ...ascii(SECRET)]), // APP13, dropped
    ...seg(0xfe, ascii(`comment ${SECRET}`)), // COM, dropped
    ...seg(0xdb, [0, ...new Array(64).fill(1)]), // DQT, kept
    ...seg(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]), // SOF0
    ...seg(0xc4, [0, ...new Array(16).fill(0)]), // DHT
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]), // SOS header
    // Entropy-coded data with a stuffed FF00 and a restart marker inside it.
    0x12,
    0x34,
    0xff,
    0x00,
    0x56,
    0xff,
    0xd0,
    0x78,
    0xff,
    0xd9, // EOI
    ...(trailing ? ascii(`appended ${SECRET}`) : []),
  ])
}

/** A PNG chunk: length, type, data, and a CRC this code never checks. */
function chunk(type: string, data: number[]): number[] {
  const len = data.length
  return [len >>> 24, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...ascii(type), ...data, 0, 0, 0, 0]
}

const u32 = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]

export function png({ width = 800, height = 600, trailing = true } = {}): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', [...u32(width), ...u32(height), 8, 6, 0, 0, 0]),
    ...chunk('tEXt', [...ascii('Author'), 0, ...ascii(SECRET)]),
    ...chunk('eXIf', ascii(SECRET)),
    ...chunk('iTXt', [...ascii('Comment'), 0, 0, 0, 0, 0, ...ascii(SECRET)]),
    ...chunk('tIME', [7, 234, 10, 18, 9, 0, 0]),
    ...chunk('sRGB', [0]),
    ...chunk('IDAT', [1, 2, 3, 4]),
    ...chunk('IEND', []),
    ...(trailing ? ascii(`appended ${SECRET}`) : []),
  ])
}

export const contains = (data: Uint8Array, text: string) => new TextDecoder('latin1').decode(data).includes(text)
