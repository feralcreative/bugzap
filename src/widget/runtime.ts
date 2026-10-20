import type { Anchor } from '../core/anchor'
import { redactDiagnostics, stripUrl } from '../core/diagnostics'
import { isPublicKey } from '../core/ids'
import { IDENTITY_TOKEN_MAX } from '../core/identity'
import type { ReportPayload } from '../core/payload'
import { BODY_MAX, BODY_MIN } from '../core/policy'
import { normalizeOrigin } from '../core/url'
import { canPin, captureAnchor } from './anchor/capture'
import { ReportError, sendReport } from './api'
import { createRecorder, type Recorder } from './buffer'
import { collectDiagnostics } from './diagnostics'
import { guard, safe } from './guard'
import { type PinWatcher, watchPins } from './pins'
import type { BugzapApi, WidgetEvent, WidgetListener, WidgetOptions } from './types'
import { createView, type Phase, type WidgetView } from './ui/view'

export function installWidget(win: Window, defaultApi: string, nonce?: string): BugzapApi {
  if (win.Bugzap?.installed) return win.Bugzap
  const queued = safe(() => (win.Bugzap?.q ?? []).slice(0, 100).map((args) => Array.from(args)), [])
  const listeners = new Map<string, Set<WidgetListener>>()
  let config: WidgetOptions | null = null
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
  const emit = (event: WidgetEvent, detail: Readonly<Record<string, unknown>> = {}) => {
    for (const listener of listeners.get(event) ?? []) guard(listener)(Object.freeze({ ...detail }))
  }
  const identified = () => !!config?.identity
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
    if (pin) view?.pin(pin.page.x - win.scrollX, pin.page.y - win.scrollY)
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
  const startPins = () => {
    saved?.dispose()
    saved = null
    if (config?.identity)
      saved = safe(
        () =>
          watchPins(win, config!.api!, config!.site, config!.identity!, (placements, truncated) =>
            view?.savedPins(placements, truncated),
          ),
        null,
      )
  }
  const submit = async () => {
    if (!config?.identity || !view || phase !== 'compose' || pending) return
    const draft = view.draft()
    const body = draft.body.trim()
    if (body.length < BODY_MIN || body.length > BODY_MAX) {
      view.error(`Write between ${BODY_MIN} and ${BODY_MAX} characters.`)
      return
    }
    const payload: ReportPayload = {
      v: 1,
      site: config.site,
      identity: config.identity,
      kind: draft.kind,
      body,
      page: { url: stripUrl(win.location.href).slice(0, 2048), title: win.document.title.slice(0, 300) },
      pin,
      screenshot: { mode: 'none' },
      diagnostics: collectDiagnostics(win, recorder, context),
    }
    const controller = new AbortController()
    pending = controller
    const current = epoch
    view.error('')
    view.sending(true)
    try {
      const id = await sendReport(win, config.api!, payload, controller)
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
        const identity = value.identity
        if (identity !== undefined && (typeof identity !== 'string' || identity.length > IDENTITY_TOKEN_MAX)) {
          emit('error', { code: 'invalid_identity' })
          return
        }
        close(false)
        saved?.dispose()
        saved = null
        recorder?.dispose()
        view?.dispose()
        config = { site: value.site, api, identity }
        context = {}
        recorder = identity ? createRecorder(win) : null
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
            saved: (id) => {
              const placement = saved?.get(id)
              if (!placement || phase !== 'idle') return
              previousFocus = win.document.activeElement instanceof HTMLElement ? win.document.activeElement : null
              phase = 'detail'
              view?.show(phase, true)
              view?.detail(placement)
            },
          },
          nonce,
        )
        view.show('idle', identified())
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
        view?.show('idle', true)
        startPins()
        break
      }
      case 'logout':
        close(false)
        saved?.dispose()
        saved = null
        if (config) config.identity = undefined
        recorder?.dispose()
        recorder = null
        context = {}
        view?.show('idle', false)
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
