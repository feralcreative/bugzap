import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let loadCapture: typeof import('../../src/widget/capture/load').loadCapture

const chunk = { capture: async () => ({ blob: new Blob(), blank: false }), shrink: async () => new Blob() }
// happy-dom fails real script loads immediately, so hold the tag instead of connecting it.
function appended() {
  const scripts: HTMLScriptElement[] = []
  vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
    scripts.push(...(nodes as HTMLScriptElement[]))
  })
  return scripts
}

beforeEach(async () => {
  vi.resetModules()
  ;({ loadCapture } = await import('../../src/widget/capture/load'))
})
afterEach(() => {
  window.__bugzapCapture = undefined
  vi.restoreAllMocks()
})

describe('screenshot chunk loader', () => {
  it('loads once through a nonced script tag on the embed origin', async () => {
    const scripts = appended()
    const first = loadCapture(window, 'https://collector.example', 'n0nce')
    expect(loadCapture(window, 'https://collector.example')).toBe(first)
    expect(scripts).toHaveLength(1)
    expect(scripts[0]!.src).toBe('https://collector.example/v1/capture.js')
    expect(scripts[0]!.nonce).toBe('n0nce')
    window.__bugzapCapture = chunk
    scripts[0]!.dispatchEvent(new Event('load'))
    expect(await first).toBe(chunk)
    expect(await loadCapture(window, 'https://collector.example')).toBe(chunk)
  })

  it('can retry after the chunk fails to load', async () => {
    const scripts = appended()
    const failed = loadCapture(window, 'https://collector.example')
    scripts[0]!.dispatchEvent(new Event('error'))
    await expect(failed).rejects.toThrow('failed to load')
    const retry = loadCapture(window, 'https://collector.example')
    expect(scripts).toHaveLength(2)
    window.__bugzapCapture = chunk
    scripts[1]!.dispatchEvent(new Event('load'))
    expect(await retry).toBe(chunk)
  })
})
