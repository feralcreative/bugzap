import type { Anchor } from '../core/anchor'
import { redactDiagnostics, stripUrl } from '../core/diagnostics'
import { isPublicKey } from '../core/ids'
import { isGuestId, isPlainEmail } from '../core/guest'
import { base64UrlEncode, IDENTITY_TOKEN_MAX } from '../core/identity'
import type { ReportPayload } from '../core/payload'
import { BODY_MAX, BODY_MIN } from '../core/policy'
import { normalizeOrigin } from '../core/url'
import { canPin, captureAnchor } from './anchor/capture'
import { ReportError, sendReport } from './api'
import { createRecorder, type Recorder } from './buffer'
import { collectDiagnostics } from './diagnostics'
import { guard, safe } from './guard'
import { type PinWatcher, watchPins } from './pins'
import { createShots, shotPart } from './shot'
import type { BugzapApi, WidgetEvent, WidgetListener, WidgetOptions } from './types'
import { createView, type Phase, type WidgetView } from './ui/view'

export function installWidget(win: Window, defaultApi: string, nonce?: string): BugzapApi {
  if (win.Bugzap?.installed) return win.Bugzap
  const queued = safe(() => (win.Bugzap?.q ?? []).slice(0, 100).map((args) => Array.from(args)), [])
  const listeners = new Map<string, Set<WidgetListener>>()
  let config: { site: string; api: string; identity?: string; signed: boolean } | null = null
  let view: WidgetView | null = null
  let recorder: Recorder | null = null
  let saved: PinWatcher | null = null
  let phase: Phase = 'idle'
  let pin: Anchor | null = null
  let context: unknown = {}
  let pending: AbortController | null = null
  let epoch = 0
  let destroyed = false
  let previousFocus: HTMLElement | null = null
  let viewToken: string | undefined
  let viewing: string | null = null
  let viewShown = false
  const shots = createShots(win, defaultApi, nonce, (state) => view?.shot(state))
  const emit = (event: WidgetEvent, detail: Readonly<Record<string, unknown>> = {}) => {
    for (const listener of listeners.get(event) ?? []) guard(listener)(Object.freeze({ ...detail }))
  }
  // A reporter is known either by a host-signed token or, on a site whose embed
  // asks for none, as a guest.
  const identified = () => !!config && (!!config.identity || !config.signed)
  // A guest is one random id per browser per site, kept with the name and email
  // they last gave. It lives only in this browser; without storage it lasts the page.
  let guest: { t: string; n?: string; e?: string } | null = null
  const guestKey = () => `bugzap:${config?.site}`
  const loadGuest = () => {
    const kept = safe(() => JSON.parse(win.localStorage.getItem(guestKey()) ?? 'null') as typeof guest, null)
    guest = kept && isGuestId(kept.t) ? kept : { t: base64UrlEncode(win.crypto.getRandomValues(new Uint8Array(32))) }
    keepGuest()
  }
  const keepGuest = () => safe(() => win.localStorage.setItem(guestKey(), JSON.stringify(guest)), undefined)
  const asGuest = () => !!config && !config.identity && !config.signed
  const credential = () =>
    config?.identity ? `Bearer ${config.identity}` : asGuest() && guest ? `Guest ${guest.t}` : undefined
  // Run whenever who the reporter is may have changed.
  const settle = () => {
    if (asGuest() && !guest) loadGuest()
    view?.guest(asGuest(), guest?.n, guest?.e)
    view?.show('idle', identified())
  }
  const stopSelection = () => {
    win.document.removeEventListener('click', onClick, true)
    win.document.removeEventListener('pointermove', onMove, true)
  }
  const close = (announce = true) => {
    const wasOpen = phase !== 'idle'
    epoch++
    pending?.abort()
    pending = null
    stopSelection()
    shots.cancel()
    phase = 'idle'
    pin = null
    view?.clear()
    view?.sending(false)
    view?.show('idle', identified())
    if (wasOpen) {
      if (previousFocus?.isConnected && previousFocus !== view?.host) safe(() => previousFocus?.focus(), undefined)
      else if (identified()) view?.focusLauncher()
      if (announce) emit('close')
    }
  }
  const fail = () => {
    // Remove the event interceptors first, even if the view itself is broken.
    epoch++
    safe(stopSelection, undefined)
    safe(() => pending?.abort(), undefined)
    pending = null
    safe(shots.cancel, undefined)
    safe(() => saved?.dispose(), undefined)
    saved = null
    safe(() => view?.dispose(), undefined)
    view = null
    safe(() => recorder?.dispose(), undefined)
    recorder = null
    config = null
    context = {}
    pin = null
    phase = 'idle'
    safe(() => previousFocus?.focus(), undefined)
    emit('error', { code: 'widget_unavailable' })
  }
  const showComposer = () => {
    stopSelection()
    phase = 'compose'
    view?.show(phase, true, pin ? `Pinned to ${pin.tag}` : 'About this page')
    const point = pin && { x: pin.page.x - win.scrollX, y: pin.page.y - win.scrollY }
    if (point) view?.pin(point.x, point.y)
    shots.start(point)
  }
  const selection = () => {
    if (!identified() || !view || pending) return
    phase = 'pin'
    pin = null
    view.show(phase, true)
    win.document.addEventListener('click', onClick, true)
    win.document.addEventListener('pointermove', onMove, true)
  }
  const onMove = guard((event: PointerEvent) => {
    if (phase !== 'pin' || !view) return
    const target = event.target instanceof Element ? event.target : null
    view.highlight(target && canPin(target) ? target : null)
  }, fail)
  const onClick = guard((event: MouseEvent) => {
    if (phase !== 'pin' || !view || !(event.target instanceof Element)) return
    // Capture before consuming the click: a capture error must not swallow the
    // host's action. UI and ignored elements pass through untouched.
    const captured = captureAnchor(event.target, event.clientX, event.clientY, win)
    if (!captured) return
    event.preventDefault()
    event.stopImmediatePropagation()
    pin = captured
    showComposer()
  }, fail)
  const open = (page = false) => {
    if (!identified() || !view || phase !== 'idle') return
    previousFocus = win.document.activeElement instanceof HTMLElement ? win.document.activeElement : null
    view.clear()
    if (page) {
      pin = null
      showComposer()
    } else selection()
    emit('open')
  }
  const showSaved = (id: string) => {
    const placement = saved?.get(id)
    if (!placement || phase !== 'idle') return false
    previousFocus = win.document.activeElement instanceof HTMLElement ? win.document.activeElement : null
    phase = 'detail'
    view?.show(phase, true)
    view?.detail(placement)
    return true
  }
  // An owner arriving from the dashboard's "Open on page" carries a view token in
  // the fragment. Take it out of the address bar at once, so it is not bookmarked,
  // shared, or read by the host's own scripts later.
  // The token is an owner's, not the visitor's in general: it is dropped when the
  // host signs the visitor out or starts the widget over, so it can never follow
  // into a different person's session on the same page.
  const dropViewToken = () => {
    viewToken = undefined
    viewing = null
    viewShown = false
  }
  const takeViewToken = () => {
    const match = /(^#|&)bugzap-view=([\w.-]{1,120})/.exec(win.location.hash)
    if (!match) return
    viewToken = match[2]
    const rest = win.location.hash
      .replace(match[0], match[1] === '#' ? '#' : '')
      .replace(/^#&/, '#')
      .replace(/^#$/, '')
    win.history.replaceState(win.history.state, '', win.location.pathname + win.location.search + rest)
  }
  const startPins = () => {
    saved?.dispose()
    saved = null
    if (identified() || viewToken)
      saved = safe(
        () =>
          watchPins(
            win,
            config!.api,
            config!.site,
            credential(),
            (placements, truncated) => {
              view?.savedPins(placements, truncated)
              // One attempt, once the pin has been placed. If the visitor is in
              // the middle of something else by then, it stays a marker to click.
              if (viewing && saved?.get(viewing)) {
                showSaved(viewing)
                viewing = null
                viewShown = true
              }
            },
            viewToken
              ? {
                  token: viewToken,
                  found: (id) => {
                    if (!viewShown) viewing = id
                  },
                }
              : undefined,
          ),
        null,
      )
  }
  const submit = async () => {
    if (!config || !identified() || !view || phase !== 'compose' || pending) return
    const draft = view.draft()
    const body = draft.body.trim()
    if (body.length < BODY_MIN || body.length > BODY_MAX) {
      view.error(`Write between ${BODY_MIN} and ${BODY_MAX} characters.`)
      return
    }
    const name = draft.name.trim()
    const email = draft.email.trim()
    if (asGuest() && email && !isPlainEmail(email)) {
      view.error('Check the email address, or leave it empty.')
      return
    }
    if (asGuest() && guest) {
      guest = { t: guest.t, ...(name && { n: name }), ...(email && { e: email }) }
      keepGuest()
      view.guest(true, name, email)
    }
    const payload: ReportPayload = {
      v: 1,
      site: config.site,
      ...(config.identity
        ? { identity: config.identity }
        : { guest: guest?.t, reporter: { ...(name && { name }), ...(email && { email }) } }),
      kind: draft.kind,
      body,
      page: { url: stripUrl(win.location.href).slice(0, 2048), title: win.document.title.slice(0, 300) },
      pin,
      screenshot: { mode: 'none' },
      diagnostics: collectDiagnostics(win, recorder, context),
    }
    const api = config.api
    const controller = new AbortController()
    pending = controller
    const current = epoch
    view.error('')
    view.sending(true)
    try {
      const { screenshot, blob } = shotPart(await shots.settle(), draft.includeShot)
      if (epoch !== current) return
      payload.screenshot = screenshot
      const id = await sendReport(win, api, payload, controller, blob)
      if (epoch !== current) return
      pending = null
      phase = 'success'
      view?.show(phase, true)
      saved?.refresh()
      emit('submitted', { id })
    } catch (error) {
      if (epoch !== current) return
      pending = null
      view?.sending(false)
      view?.error(error instanceof ReportError ? error.message : 'The report could not be confirmed. Please try again.')
      emit('error', { code: error instanceof ReportError ? error.code : 'submission_failed' })
    }
  }
  const onKey = guard((event: KeyboardEvent) => {
    if (phase === 'idle') return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'Tab' && (phase === 'compose' || phase === 'success' || phase === 'detail'))
      view?.trapTab(event)
  }, fail)
  const onScroll = guard(() => {
    if (pin && phase !== 'idle') view?.pin(pin.page.x - win.scrollX, pin.page.y - win.scrollY)
    if (phase === 'pin') view?.highlight(null)
  }, fail)

  const command = guard((name: string, ...args: unknown[]) => {
    if (destroyed) return
    switch (name) {
      case 'on': {
        if (typeof args[0] !== 'string' || typeof args[1] !== 'function') return
        const set = listeners.get(args[0]) ?? new Set<WidgetListener>()
        set.add(args[1] as WidgetListener)
        listeners.set(args[0], set)
        break
      }
      case 'init': {
        const value = args[0] as Partial<WidgetOptions> | undefined
        const api = normalizeOrigin(value?.api ?? defaultApi)
        if (!isPublicKey(value?.site) || !api) {
          emit('error', { code: 'invalid_config' })
          return
        }
        const identity = value.identity ?? undefined
        if (identity !== undefined && (typeof identity !== 'string' || identity.length > IDENTITY_TOKEN_MAX)) {
          emit('error', { code: 'invalid_identity' })
          return
        }
        close(false)
        saved?.dispose()
        saved = null
        recorder?.dispose()
        view?.dispose()
        // The same site keeps its guest: with storage blocked, the id exists only here.
        if (config?.site !== value.site) guest = null
        config = { site: value.site, api, identity, signed: 'identity' in value }
        context = {}
        recorder = identified() ? createRecorder(win) : null
        view = createView(
          win.document,
          {
            open: () => open(),
            close: () => close(),
            page: () => {
              pin = null
              showComposer()
            },
            repin: selection,
            submit,
            fail,
            upload: (file) => {
              if (phase === 'compose' && !pending) shots.choose(file)
            },
            saved: (id) => void showSaved(id),
          },
          nonce,
        )
        settle()
        dropViewToken()
        safe(takeViewToken, undefined)
        startPins()
        emit('ready')
        break
      }
      case 'identify': {
        if (!config || typeof args[0] !== 'string' || !args[0] || args[0].length > IDENTITY_TOKEN_MAX) return
        close(false)
        recorder?.dispose()
        config.identity = args[0]
        context = {}
        recorder = createRecorder(win)
        settle()
        startPins()
        break
      }
      case 'logout':
        close(false)
        dropViewToken()
        saved?.dispose()
        saved = null
        if (config) config.identity = undefined
        recorder?.dispose()
        // On a site open to guests, signing out leaves the visitor a guest.
        recorder = identified() ? createRecorder(win) : null
        context = {}
        settle()
        startPins()
        break
      case 'open':
        open(!!(args[0] && typeof args[0] === 'object' && 'page' in args[0] && args[0].page === true))
        break
      case 'close':
        close()
        break
      case 'context':
        context = safe(() => redactDiagnostics({ context: args[0] }).context ?? {}, {})
        break
      case 'refresh':
        saved?.refresh()
        break
      case 'destroy':
        close(false)
        saved?.dispose()
        saved = null
        recorder?.dispose()
        recorder = null
        view?.dispose()
        view = null
        config = null
        context = {}
        win.document.removeEventListener('keydown', onKey, true)
        win.removeEventListener('scroll', onScroll, true)
        win.removeEventListener('resize', onScroll)
        listeners.clear()
        destroyed = true
        win.Bugzap = undefined
        break
    }
  }, fail)
  const api: BugzapApi = Object.assign(command, { installed: true })
  win.Bugzap = api
  win.document.addEventListener('keydown', onKey, true)
  win.addEventListener('scroll', onScroll, true)
  win.addEventListener('resize', onScroll)
  for (const args of queued) {
    const [name, ...rest] = args
    if (typeof name === 'string') api(name, ...rest)
  }
  return api
}
