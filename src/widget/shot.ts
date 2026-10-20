import type { ReportPayload } from '../core/payload'
import { loadCapture } from './capture/load'

export const CAPTURE_TIMEOUT = 5000

export type ShotState =
  | { kind: 'off' }
  | { kind: 'capturing' }
  | { kind: 'reading' }
  | { kind: 'ready'; blob: Blob; mode: 'auto' | 'upload' }
  | { kind: 'missing'; reason: 'blank' | 'failed' | 'timeout' | 'unreadable' }

const FAILED = {
  blank: 'capture blank under the pin',
  failed: 'capture failed',
  timeout: 'capture timed out',
  unreadable: 'upload unreadable',
} as const

/** What the payload says about the screenshot, and the file to send with it. */
export function shotPart(state: ShotState, include: boolean): { screenshot: ReportPayload['screenshot']; blob?: Blob } {
  if (state.kind === 'ready')
    return include
      ? { screenshot: { mode: state.mode }, blob: state.blob }
      : { screenshot: { mode: 'none', failed: 'excluded by reporter' } }
  if (state.kind === 'missing') return { screenshot: { mode: 'none', failed: FAILED[state.reason] } }
  return { screenshot: { mode: 'none' } }
}

/** One screenshot per composer session: an automatic capture first, replaced by
 *  the reporter's own upload when the capture is blank, fails, or is unwanted.
 *  Late results from an older session are dropped. */
export function createShots(
  win: Window,
  origin: string,
  nonce: string | undefined,
  render: (state: ShotState) => void,
) {
  let state: ShotState = { kind: 'off' }
  let run = 0
  let waiting: Promise<void> = Promise.resolve()
  const set = (id: number, next: ShotState) => {
    if (id !== run) return
    state = next
    render(state)
  }
  return {
    start(point: { x: number; y: number } | null) {
      const id = ++run
      set(id, { kind: 'capturing' })
      waiting = new Promise<void>((done) => {
        let settled = false
        const finish = (next: ShotState) => {
          if (settled) return
          settled = true
          win.clearTimeout(timer)
          set(id, next)
          done()
        }
        const timer = win.setTimeout(() => finish({ kind: 'missing', reason: 'timeout' }), CAPTURE_TIMEOUT)
        loadCapture(win, origin, nonce)
          .then((chunk) => chunk.capture(win, point))
          .then(
            (shot) =>
              finish(
                shot.blank ? { kind: 'missing', reason: 'blank' } : { kind: 'ready', blob: shot.blob, mode: 'auto' },
              ),
            () => finish({ kind: 'missing', reason: 'failed' }),
          )
      })
    },
    choose(file: Blob) {
      const id = ++run
      set(id, { kind: 'reading' })
      waiting = loadCapture(win, origin, nonce)
        .then((chunk) => chunk.shrink(win, file))
        .then(
          (blob) => set(id, { kind: 'ready', blob, mode: 'upload' }),
          () => set(id, { kind: 'missing', reason: 'unreadable' }),
        )
    },
    /** Waits for the capture or upload in progress, then reports the outcome. */
    settle: async (): Promise<ShotState> => {
      let current: Promise<void>
      do {
        current = waiting
        await current
      } while (current !== waiting)
      return state
    },
    cancel() {
      run++
      state = { kind: 'off' }
      waiting = Promise.resolve()
    },
  }
}

export type Shots = ReturnType<typeof createShots>
