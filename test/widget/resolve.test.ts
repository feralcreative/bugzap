import { afterEach, expect, it, vi } from 'vitest'
import { captureAnchor } from '../../src/widget/anchor/capture'
import { locate, resolveAnchor } from '../../src/widget/anchor/resolve'
import { watchPins } from '../../src/widget/pins'

function target(id = 'save', x = 20) {
  const el = document.createElement('button')
  el.dataset.bugzapId = id
  el.textContent = 'Save changes'
  document.body.append(el)
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, 40, 100, 30))
  return el
}
afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('survives 20 complete replacements and reordering by stable identity', () => {
  let el = target()
  const anchor = captureAnchor(el, 45, 55, window)!
  for (let n = 0; n < 20; n++) {
    el.remove()
    target(`other-${n}`)
    el = target('save', 100 + n)
    const found = resolveAnchor(anchor, window)
    expect(found.element).toBe(el)
    expect(found.x).toBe(125 + n)
    expect(found.approximate).toBe(false)
  }
})
it('does not jump to a similar sibling when the stable target disappears or becomes hidden', () => {
  const el = target()
  const anchor = captureAnchor(el, 45, 55, window)!
  target('other')
  el.hidden = true
  expect(locate(anchor, el, 'attribute', window).approximate).toBe(true)
  el.remove()
  expect(resolveAnchor(anchor, window).approximate).toBe(true)
})
it('uses text to reject a positional selector after a reorder, and refuses ambiguous matches', () => {
  const el = target()
  el.removeAttribute('data-bugzap-id')
  const anchor = captureAnchor(el, 45, 55, window)!
  el.remove()
  const other = target('other')
  other.removeAttribute('data-bugzap-id')
  other.textContent = 'Delete everything'
  const moved = target('new')
  moved.removeAttribute('data-bugzap-id')
  expect(resolveAnchor(anchor, window).element).toBe(moved)
  anchor.selector = '['
  const duplicate = target('duplicate')
  duplicate.removeAttribute('data-bugzap-id')
  expect(resolveAnchor(anchor, window).approximate).toBe(true)
})
it('coalesces DOM rebuilds without refetching and restores history on disposal', async () => {
  const el = target()
  const anchor = captureAnchor(el, 45, 55, window)!
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        pins: [
          { id: 'ABCDEFGHIJKLMNOPQRSTUV', kind: 'bug', status: 'new', title: 'Save', body: 'Does not save', anchor },
        ],
      }),
    ),
  )
  // Every refresh needs its own consumable response.
  fetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          pins: [
            { id: 'ABCDEFGHIJKLMNOPQRSTUV', kind: 'bug', status: 'new', title: 'Save', body: 'Does not save', anchor },
          ],
        }),
      ),
  )
  vi.stubGlobal('fetch', fetch)
  const render = vi.fn()
  const original = window.history.pushState
  const watcher = watchPins(window, 'https://collector.example', 'site', 'identity', render)
  await vi.waitFor(() => expect(watcher.get('ABCDEFGHIJKLMNOPQRSTUV')?.resolution.element).toBe(el))
  let replacement = el
  for (let n = 0; n < 20; n++) {
    replacement.remove()
    replacement = target()
  }
  await vi.waitFor(() => expect(watcher.get('ABCDEFGHIJKLMNOPQRSTUV')?.resolution.element).toBe(replacement))
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', headers: { Authorization: 'Bearer identity' } })
  watcher.dispose()
  expect(window.history.pushState).toBe(original)
  expect(watcher.get('ABCDEFGHIJKLMNOPQRSTUV')).toBeUndefined()
})
it('ignores a late read after disposal', async () => {
  let finish!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
  )
  const render = vi.fn()
  const watcher = watchPins(window, 'https://collector.example', 'site', 'identity', render)
  watcher.dispose()
  finish(new Response(JSON.stringify({ pins: [] })))
  await Promise.resolve()
  await Promise.resolve()
  expect(render.mock.calls.every(([pins]) => pins.length === 0)).toBe(true)
})
it('refetches on SPA paths, excludes query secrets and discards a stale route response', async () => {
  const requests: { url: string; finish: (response: Response) => void; signal?: AbortSignal | null }[] = []
  vi.stubGlobal(
    'fetch',
    (url: string, init?: RequestInit) =>
      new Promise<Response>((finish) => {
        requests.push({ url, finish, signal: init?.signal })
      }),
  )
  const original = window.location.href
  const render = vi.fn()
  const watcher = watchPins(window, 'https://collector.example', 'site', 'identity', render)
  try {
    window.history.pushState({}, '', '/next?token=secret#private')
    expect(requests).toHaveLength(2)
    expect(requests[0]?.signal?.aborted).toBe(true)
    expect(requests[1]?.url).toContain(encodeURIComponent('/next'))
    expect(requests[1]?.url).not.toContain('secret')
    requests[1]!.finish(new Response(JSON.stringify({ pins: [] })))
    requests[0]!.finish(new Response(JSON.stringify({ pins: [] })))
    await Promise.resolve()
    await Promise.resolve()
    expect(watcher.get('ABCDEFGHIJKLMNOPQRSTUV')).toBeUndefined()
  } finally {
    watcher.dispose()
    window.history.replaceState({}, '', original)
  }
})
