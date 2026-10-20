import { afterEach, describe, expect, it, vi } from 'vitest'
import { cropRect, intersect, isUniform, MASK_SELECTOR, opaqueAt } from '../../src/widget/capture/geometry'
import { createShots, shotPart } from '../../src/widget/shot'

const chunk = vi.hoisted(() => ({ capture: vi.fn(), shrink: vi.fn() }))
vi.mock('../../src/widget/capture/load', () => ({ loadCapture: async () => chunk }))

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('crop geometry', () => {
  it('centers on the pin, clamps inside the viewport, and shrinks to small viewports', () => {
    expect(cropRect(1600, 1000, { x: 800, y: 500 })).toEqual({ x: 200, y: 100, width: 1200, height: 800 })
    expect(cropRect(1600, 1000, { x: 10, y: 990 })).toEqual({ x: 0, y: 200, width: 1200, height: 800 })
    expect(cropRect(390, 700, { x: 380, y: 20 })).toEqual({ x: 0, y: 0, width: 390, height: 700 })
    expect(cropRect(1600, 1000, null)).toEqual({ x: 200, y: 100, width: 1200, height: 800 })
  })

  it('translates mask rectangles into crop coordinates and drops ones outside it', () => {
    const crop = { x: 200, y: 100, width: 1200, height: 800 }
    expect(intersect({ x: 150, y: 120, width: 100, height: 20 }, crop)).toEqual({ x: 0, y: 20, width: 50, height: 20 })
    expect(intersect({ x: 0, y: 0, width: 100, height: 100 }, crop)).toBeNull()
  })

  it('treats a flat sample as blank and any real detail as content', () => {
    const flat = new Uint8ClampedArray(96 * 96 * 4).fill(229)
    expect(isUniform(flat)).toBe(true)
    const text = flat.slice()
    text.set([20, 20, 20, 255], 400)
    expect(isUniform(text)).toBe(false)
  })

  it('masks passwords, card fields, and opted-in elements', () => {
    document.body.innerHTML = `<input type="password"><input autocomplete="cc-number">
      <div data-bugzap-mask><p>secret</p></div><input type="text" value="visible">`
    expect(document.querySelectorAll(MASK_SELECTOR)).toHaveLength(3)
  })

  it('flags frames under the point, skipping the widget itself', () => {
    const frame = document.createElement('iframe')
    const widget = document.createElement('div')
    widget.setAttribute('data-bugzap-root', '')
    const doc = { elementsFromPoint: () => [widget, frame] } as unknown as Document
    expect(opaqueAt(doc, 1, 1)).toBe(true)
    expect(opaqueAt({ elementsFromPoint: () => [document.body] } as unknown as Document, 1, 1)).toBe(false)
    expect(opaqueAt({} as Document, 1, 1)).toBe(false)
  })
})

describe('screenshot sessions', () => {
  it('gives up after five seconds and ignores the late capture', async () => {
    vi.useFakeTimers()
    let finish!: (shot: unknown) => void
    chunk.capture.mockReturnValue(
      new Promise((done) => {
        finish = done
      }),
    )
    const render = vi.fn()
    const shots = createShots(window, 'https://collector.example', undefined, render)
    shots.start({ x: 1, y: 1 })
    const settled = shots.settle()
    await vi.advanceTimersByTimeAsync(5000)
    expect(await settled).toEqual({ kind: 'missing', reason: 'timeout' })
    finish({ blob: new Blob(['late']), blank: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(render).toHaveBeenLastCalledWith({ kind: 'missing', reason: 'timeout' })
  })

  it('waits for an upload chosen while a capture was pending', async () => {
    chunk.capture.mockRejectedValue(new Error('failed'))
    let read!: (blob: Blob) => void
    chunk.shrink.mockReturnValue(
      new Promise((done) => {
        read = done
      }),
    )
    const shots = createShots(window, 'https://collector.example', undefined, () => {})
    shots.start(null)
    const settled = shots.settle()
    shots.choose(new Blob(['raw']))
    const blob = new Blob(['jpeg'])
    read(blob)
    expect(await settled).toEqual({ kind: 'ready', blob, mode: 'upload' })
  })

  it('describes each outcome in the payload', () => {
    const blob = new Blob(['x'])
    expect(shotPart({ kind: 'ready', blob, mode: 'auto' }, true)).toEqual({ screenshot: { mode: 'auto' }, blob })
    expect(shotPart({ kind: 'ready', blob, mode: 'upload' }, false).blob).toBeUndefined()
    expect(shotPart({ kind: 'missing', reason: 'blank' }, true)).toEqual({
      screenshot: { mode: 'none', failed: 'capture blank under the pin' },
    })
    expect(shotPart({ kind: 'off' }, true)).toEqual({ screenshot: { mode: 'none' } })
  })
})
