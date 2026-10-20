// Ported from Routeloop's feedback-buffer.js. Keep the earliest entries: the first
// error is usually the cause; the next twenty are its consequences.
import { DIAG_ERRORS_MAX, DIAG_NET_MAX, type Diagnostics, scrubUrls, stripUrl } from '../core/diagnostics'
import { guard, safe } from './guard'

export function makeRing<T>(max: number) {
  const items: T[] = []
  return {
    push(item: T) {
      if (items.length < max) items.push(item)
    },
    list: () => items.slice(),
    clear() {
      items.length = 0
    },
  }
}

export function createRecorder(win: Window, console: Console = globalThis.console) {
  const errors = makeRing<NonNullable<Diagnostics['errors']>[number]>(DIAG_ERRORS_MAX)
  const net = makeRing<NonNullable<Diagnostics['net']>[number]>(DIAG_NET_MAX)
  const started = Date.now()
  let active = true
  const stamp = () => Date.now() - started
  const record = guard((kind: string, message: unknown, stack?: unknown) => {
    if (!active) return
    errors.push({
      at: stamp(),
      kind,
      message: scrubUrls(String(message ?? '').slice(0, 2000)),
      ...(typeof stack === 'string' && { stack: scrubUrls(stack.slice(0, 4000)) }),
    })
  })
  const onError = guard((event: ErrorEvent) => record('error', event.message, event.error?.stack))
  const onRejection = guard((event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason
    record(
      'rejection',
      reason instanceof Error ? reason.message : reason,
      reason instanceof Error ? reason.stack : undefined,
    )
  })
  win.addEventListener('error', onError)
  win.addEventListener('unhandledrejection', onRejection)

  const cleanup: (() => void)[] = [
    () => win.removeEventListener('error', onError),
    () => win.removeEventListener('unhandledrejection', onRejection),
  ]
  // Frozen/locked console and fetch properties are normal on some hosts. A failed
  // hook is simply absent. Original behavior and rejection reasons are preserved.
  safe(() => {
    const original = console.error
    if (typeof original !== 'function') return
    const wrapped: typeof original = (...args) => {
      safe(
        () => record('console', args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')),
        undefined,
      )
      return original.apply(console, args)
    }
    console.error = wrapped
    cleanup.push(() => {
      if (console.error === wrapped) console.error = original
    })
  }, undefined)

  safe(() => {
    const original = win.fetch
    if (typeof original !== 'function') return
    const recordRequest = guard(
      (input: RequestInfo | URL, init: RequestInit | undefined, status: number, began: number) => {
        if (!active) return
        const ms = Date.now() - began
        if (status !== 0 && status < 400 && ms < 3000) return
        const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        net.push({
          at: began - started,
          method: (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).slice(
            0,
            10,
          ),
          path: stripUrl(path).slice(0, 2048),
          status,
          ms,
        })
      },
    )
    const wrapped: typeof original = (input, init) => {
      const began = Date.now()
      return original.call(win, input, init).then(
        (response) => {
          recordRequest(input, init, response.status, began)
          return response
        },
        (error: unknown) => {
          recordRequest(input, init, 0, began)
          throw error
        },
      )
    }
    win.fetch = wrapped
    cleanup.push(() => {
      if (win.fetch === wrapped) win.fetch = original
    })
  }, undefined)

  return {
    snapshot: () => ({ errors: errors.list(), net: net.list() }),
    clear() {
      errors.clear()
      net.clear()
    },
    dispose() {
      active = false
      for (const restore of cleanup) safe(restore, undefined)
      errors.clear()
      net.clear()
    },
  }
}

export type Recorder = ReturnType<typeof createRecorder>
