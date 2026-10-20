// Pure helpers for the screenshot chunk, kept apart so they can be tested
// without a canvas.

/** Elements whose pixels never leave the browser. Hidden in the rendered clone
 *  and painted over afterwards, so either mechanism alone is enough. */
export const MASK_SELECTOR = '[data-bugzap-mask], input[type="password"], input[autocomplete^="cc-"]'

export const CROP_WIDTH = 1200
export const CROP_HEIGHT = 800

export type Rect = { x: number; y: number; width: number; height: number }

/** A crop of at most width×height in viewport coordinates, centered on the pin
 *  (or the viewport) and clamped inside the viewport. */
export function cropRect(
  viewportWidth: number,
  viewportHeight: number,
  point: { x: number; y: number } | null,
  width = CROP_WIDTH,
  height = CROP_HEIGHT,
): Rect {
  const w = Math.max(1, Math.round(Math.min(width, viewportWidth)))
  const h = Math.max(1, Math.round(Math.min(height, viewportHeight)))
  const cx = point?.x ?? viewportWidth / 2
  const cy = point?.y ?? viewportHeight / 2
  const clamp = (value: number, max: number) => Math.round(Math.min(Math.max(value, 0), Math.max(0, max)))
  return { x: clamp(cx - w / 2, viewportWidth - w), y: clamp(cy - h / 2, viewportHeight - h), width: w, height: h }
}

/** The part of `rect` inside `crop`, translated into crop coordinates, or null. */
export function intersect(rect: Rect, crop: Rect): Rect | null {
  const x = Math.max(rect.x, crop.x)
  const y = Math.max(rect.y, crop.y)
  const right = Math.min(rect.x + rect.width, crop.x + crop.width)
  const bottom = Math.min(rect.y + rect.height, crop.y + crop.height)
  if (right <= x || bottom <= y) return null
  return { x: x - crop.x, y: y - crop.y, width: right - x, height: bottom - y }
}

/** True when every pixel is within `tolerance` of the others on every channel,
 *  which is how a WebGL map, an unrendered iframe, or a failed tile comes out. */
export function isUniform(rgba: ArrayLike<number>, tolerance = 6): boolean {
  if (rgba.length < 4) return true
  const min = [255, 255, 255]
  const max = [0, 0, 0]
  for (let i = 0; i + 3 < rgba.length; i += 4)
    for (let c = 0; c < 3; c++) {
      const value = rgba[i + c]!
      if (value < min[c]!) min[c] = value
      if (value > max[c]!) max[c] = value
      if (max[c]! - min[c]! > tolerance) return false
    }
  return true
}

/** Content a DOM render cannot reproduce: frames and plugins show up empty. */
export function opaqueAt(doc: Document, x: number, y: number): boolean {
  const stack = typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(x, y) : []
  const top = stack.find((el) => !el.closest('[data-bugzap-root]'))
  return !!top && ['IFRAME', 'EMBED', 'OBJECT'].includes(top.tagName)
}
