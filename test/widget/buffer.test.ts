import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRecorder, makeRing, type Recorder } from '../../src/widget/buffer'
import { collectDiagnostics } from '../../src/widget/diagnostics'

let recorder: Recorder | undefined
afterEach(() => {
  recorder?.dispose()
  recorder = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('host error recorder', () => {
  it('keeps the oldest bounded samples and returns independent snapshots', () => {
    const ring = makeRing<number>(2)
    ring.push(1)
    ring.push(2)
    ring.push(3)
    const list = ring.list()
    list.pop()
    expect(ring.list()).toEqual([1, 2])
    ring.clear()
    expect(ring.list()).toEqual([])
  })

  it('records errors and rejections without intercepting their propagation', () => {
    recorder = createRecorder(window)
    const message = 'Failure at https://host.example/editor?reset=private#hidden'
    const error = new ErrorEvent('error', { message, error: new Error(message), cancelable: true })
    window.dispatchEvent(error)
    const rejection = new Event('unhandledrejection', { cancelable: true })
    Object.defineProperty(rejection, 'reason', { value: new Error('Failed /api?token=private') })
    window.dispatchEvent(rejection)
    expect(error.defaultPrevented).toBe(false)
    expect(rejection.defaultPrevented).toBe(false)
    const entries = recorder.snapshot().errors
    expect(entries.map((e) => e.kind)).toEqual(['error', 'rejection'])
    expect(JSON.stringify(entries)).not.toContain('private')
  })

  it('tolerates a frozen console and hostile console arguments while preserving logging', () => {
    const error = vi.fn()
    const console = { ...globalThis.console, error }
    recorder = createRecorder(window, console)
    console.error({
      toString() {
        throw new Error('hostile')
      },
    })
    expect(error).toHaveBeenCalledTimes(1)
    recorder.dispose()
    const frozen = Object.freeze({ ...globalThis.console, error })
    recorder = createRecorder(window, frozen)
    expect(() => frozen.error('still works')).not.toThrow()
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('preserves fetch results and rejection identity, recording failed and slow requests only', async () => {
    const failure = new Error('original failure')
    const fetch = vi
      .fn<typeof window.fetch>()
      .mockResolvedValueOnce(new Response('ok'))
      .mockResolvedValueOnce(new Response('bad', { status: 500 }))
      .mockRejectedValueOnce(failure)
    vi.stubGlobal('fetch', fetch)
    recorder = createRecorder(window)
    expect(window.fetch).not.toBe(fetch)
    expect(await (await window.fetch('https://host.example/good')).text()).toBe('ok')
    expect((await window.fetch('https://host.example/bad?token=private')).status).toBe(500)
    await expect(window.fetch('https://host.example/missing?token=private')).rejects.toBe(failure)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(recorder.snapshot().net.map((n) => n.status)).toEqual([500, 0])
    expect(JSON.stringify(recorder.snapshot())).not.toContain('private')
  })

  it('stops collecting after logout even when a later host wrapper retains our wrapper', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof window.fetch>().mockResolvedValue(new Response('bad', { status: 500 })))
    recorder = createRecorder(window)
    const recordedFetch = window.fetch
    const laterWrapper: typeof fetch = (...args) => recordedFetch(...args)
    window.fetch = laterWrapper
    recorder.dispose()
    expect(window.fetch).toBe(laterWrapper)
    const result = await window.fetch('https://host.example/bad')
    expect(result.status).toBe(500)
    expect(recorder.snapshot()).toEqual({ errors: [], net: [] })
  })

  it('collects useful diagnostics with throwing storage access and no fetch API', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.stubGlobal('fetch', undefined)
    recorder = createRecorder(window)
    const data = collectDiagnostics(window, recorder, { build: 'local', token: 'private-token', latitude: 45 })
    expect(data.device?.width).toBeGreaterThan(0)
    expect(data.context?.build).toBe('local')
    expect(JSON.stringify(data)).not.toContain('private-token')
    expect(data.context?.latitude).toBeUndefined()
  })
})
