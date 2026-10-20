import { parseSavedPin, PINS_MAX, type SavedPin } from '../core/pins'
import { urlKey } from '../core/url'
import { locate, type Resolution, resolveAnchor, type ResolveCache } from './anchor/resolve'
import { guard, safe } from './guard'

export type PinPlacement = { pin: SavedPin; resolution: Resolution }
export function watchPins(
  win: Window,
  api: string,
  site: string,
  identity: string,
  render: (pins: PinPlacement[], truncated: boolean) => void,
) {
  let active = true
  let controller: AbortController | null = null
  let page = ''
  let generation = 0
  let pins: SavedPin[] = []
  let placements: PinPlacement[] = []
  let truncated = false
  let frame: number | null = null
  let needsResolve = false
  const observed = new Set<Element>()
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(guard(() => schedule())) : null
  const paint = guard(() => {
    const cache: ResolveCache = new Map()
    placements = pins.map((pin) => {
      const old = placements.find((p) => p.pin.id === pin.id)?.resolution
      return {
        pin,
        resolution:
          needsResolve || !old || !old.element?.isConnected
            ? resolveAnchor(pin.anchor, win, cache)
            : locate(pin.anchor, old.element, old.strategy, win),
      }
    })
    needsResolve = false
    const targets = new Set(placements.flatMap((p) => (p.resolution.element ? [p.resolution.element] : [])))
    for (const el of observed)
      if (!targets.has(el)) {
        resize?.unobserve(el)
        observed.delete(el)
      }
    for (const el of targets)
      if (!observed.has(el)) {
        resize?.observe(el)
        observed.add(el)
      }
    render(placements, truncated)
  })
  function schedule(resolve = false) {
    if (!active) return
    needsResolve ||= resolve
    if (frame !== null) return
    frame = win.requestAnimationFrame(() => {
      frame = null
      if (active) paint()
    })
  }
  async function refresh(force = true) {
    if (!active) return
    const key = urlKey(win.location.href)
    if (!key || (!force && key === page)) return
    const changed = key !== page
    page = key
    const current = ++generation
    controller?.abort()
    controller = new AbortController()
    if (changed) {
      pins = []
      placements = []
      render([], false)
    }
    if (typeof win.fetch !== 'function') return
    const pending = controller
    const timer = win.setTimeout(() => pending.abort(), 15000)
    try {
      const response = await win.fetch(
        `${api}/v1/pins?site=${encodeURIComponent(site)}&page=${encodeURIComponent(key)}`,
        {
          method: 'GET',
          credentials: 'omit',
          headers: { Authorization: `Bearer ${identity}` },
          signal: pending.signal,
        },
      )
      if (response.status !== 200) throw new Error('Pins unavailable')
      const raw: unknown = await response.json()
      if (!active || current !== generation) return
      if (!raw || typeof raw !== 'object' || !('pins' in raw) || !Array.isArray(raw.pins) || raw.pins.length > PINS_MAX)
        throw new Error('Invalid pins')
      pins = raw.pins.flatMap((value) => {
        const pin = parseSavedPin(value)
        return pin ? [pin] : []
      })
      truncated = 'truncated' in raw && raw.truncated === true
      schedule(true)
    } catch {
      if (active && current === generation) {
        pins = []
        placements = []
        render([], false)
      }
    } finally {
      win.clearTimeout(timer)
    }
  }
  const route = guard(() => refresh(false))
  const mutated = guard((records: MutationRecord[]) => {
    route()
    if (records.some((r) => !(r.target instanceof Element && r.target.closest('[data-bugzap-root]')))) schedule(true)
  })
  const mutation = typeof MutationObserver === 'function' ? new MutationObserver(mutated) : null
  mutation?.observe(win.document.documentElement, {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: true,
  })
  if (win.document.body) resize?.observe(win.document.body)
  const geometry = guard(() => schedule())
  win.addEventListener('scroll', geometry, true)
  win.addEventListener('resize', geometry)
  win.addEventListener('load', geometry, true)
  win.addEventListener('popstate', route)
  win.addEventListener('hashchange', route)
  const restores: (() => void)[] = []
  for (const method of ['pushState', 'replaceState'] as const)
    safe(() => {
      const original = win.history[method]
      const wrapped: typeof original = (...args) => {
        const result = original.apply(win.history, args)
        route()
        return result
      }
      win.history[method] = wrapped
      restores.push(() => {
        if (win.history[method] === wrapped) win.history[method] = original
      })
    }, undefined)
  guard(() => refresh())()
  return {
    refresh: guard(() => refresh()),
    get: (id: string) => placements.find((p) => p.pin.id === id),
    dispose() {
      active = false
      generation++
      controller?.abort()
      if (frame !== null) win.cancelAnimationFrame(frame)
      mutation?.disconnect()
      resize?.disconnect()
      win.removeEventListener('scroll', geometry, true)
      win.removeEventListener('resize', geometry)
      win.removeEventListener('load', geometry, true)
      win.removeEventListener('popstate', route)
      win.removeEventListener('hashchange', route)
      for (const restore of restores) safe(restore, undefined)
      pins = []
      placements = []
      safe(() => render([], false), undefined)
    },
  }
}

export type PinWatcher = ReturnType<typeof watchPins>
