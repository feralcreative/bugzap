// The screenshot chunk. Built separately (utils/build-widget.js) and loaded on
// first use by ./load.ts, so modern-screenshot never counts against the embed's
// 15 KiB budget. It hands its API over through window.__bugzapCapture.

import { domToCanvas } from 'modern-screenshot'
import { MAX_IMAGE_BYTES } from '../../core/image-policy'
import { cropRect, intersect, isUniform, MASK_SELECTOR, opaqueAt } from './geometry'

export type Shot = { blob: Blob; blank: boolean }
export type CaptureModule = { capture: typeof capture; shrink: typeof shrink }

/** Uploads are scaled to this long edge, which also keeps them far below the pixel cap. */
const UPLOAD_EDGE = 2000
/** Refuse to decode anything larger: the canvas re-encode is in the reporter's own tab. */
const UPLOAD_BYTES_MAX = 20 * 1024 * 1024
const SAMPLE = 96

function jpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  const encode = (quality: number) => new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', quality))
  return (async () => {
    for (const quality of [0.85, 0.7, 0.5]) {
      const blob = await encode(quality)
      if (!blob) throw new Error('encode failed')
      if (blob.size <= MAX_IMAGE_BYTES) return blob
    }
    throw new Error('image too large')
  })()
}

function background(win: Window): string {
  for (const node of [win.document.body, win.document.documentElement]) {
    const color = node ? win.getComputedStyle(node).backgroundColor : ''
    if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) return color
  }
  return '#fff'
}

/** Renders the viewport around `point` (viewport coordinates, or null for the
 *  whole page) to a JPEG, with masked elements blanked and the pin drawn on. */
export async function capture(win: Window, point: { x: number; y: number } | null): Promise<Shot> {
  const doc = win.document
  const root = doc.documentElement
  const crop = cropRect(root.clientWidth, root.clientHeight, point)
  const masks = Array.from(doc.querySelectorAll(MASK_SELECTOR)).flatMap((el) => {
    const r = el.getBoundingClientRect()
    const hit = intersect({ x: r.left, y: r.top, width: r.width, height: r.height }, crop)
    return hit ? [hit] : []
  })
  const opaque = !!point && opaqueAt(doc, point.x, point.y)
  const { width, height } = win.getComputedStyle(root)
  const shiftX = win.scrollX + crop.x
  const shiftY = win.scrollY + crop.y
  const canvas = await domToCanvas(root, {
    width: crop.width,
    height: crop.height,
    scale: 1,
    timeout: 4000,
    backgroundColor: background(win),
    filter: (node) => !(node.nodeType === 1 && (node as Element).hasAttribute('data-bugzap-root')),
    onCloneEachNode: (node) => {
      if (node.nodeType === 1 && (node as Element).matches(MASK_SELECTOR))
        (node as HTMLElement).style.setProperty('visibility', 'hidden', 'important')
    },
    // The size options set the output frame. Restore the root's real layout size
    // inside it and shift the crop into view, so nothing reflows.
    onCloneNode: (clone) => {
      const style = (clone as HTMLElement).style
      style.setProperty('width', width, 'important')
      style.setProperty('height', height, 'important')
      style.setProperty('transform-origin', '0 0', 'important')
      style.setProperty('transform', `translate(${-shiftX}px, ${-shiftY}px)`, 'important')
    },
  })
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.fillStyle = '#8a8f98'
  for (const m of masks) ctx.fillRect(m.x, m.y, m.width, m.height)
  const px = point ? point.x - crop.x : 0
  const py = point ? point.y - crop.y : 0
  const sw = Math.min(SAMPLE, canvas.width)
  const sh = Math.min(SAMPLE, canvas.height)
  const clamp = (value: number, max: number) => Math.round(Math.min(Math.max(value, 0), max))
  const sample = point
    ? ctx.getImageData(clamp(px - sw / 2, canvas.width - sw), clamp(py - sh / 2, canvas.height - sh), sw, sh)
    : ctx.getImageData(0, 0, canvas.width, canvas.height)
  const blank = opaque || isUniform(sample.data)
  if (point) {
    ctx.lineWidth = 6
    ctx.strokeStyle = '#fff'
    ctx.beginPath()
    ctx.arc(px, py, 14, 0, Math.PI * 2)
    ctx.stroke()
    ctx.lineWidth = 3
    ctx.strokeStyle = '#e11d48'
    ctx.stroke()
  }
  return { blob: await jpeg(canvas), blank }
}

/** Re-encodes a reporter's own image through a canvas: no EXIF, no original
 *  filename, PNG/JPEG/WebP in and JPEG out, within the server's limits. */
export async function shrink(win: Window, file: Blob): Promise<Blob> {
  if (file.size > UPLOAD_BYTES_MAX) throw new Error('file too large')
  const bitmap = await win.createImageBitmap(file)
  try {
    const scale = Math.min(1, UPLOAD_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = win.document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await jpeg(canvas)
  } finally {
    bitmap.close()
  }
}

window.__bugzapCapture = { capture, shrink }
