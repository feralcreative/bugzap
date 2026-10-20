import { type Diagnostics, redactDiagnostics } from '../core/diagnostics'
import type { Recorder } from './buffer'
import { safe } from './guard'

// No cookies, storage contents, permission prompts, or location coordinates.
export function collectDiagnostics(win: Window, recorder: Recorder | null, context: unknown): Diagnostics {
  return safe(
    () =>
      redactDiagnostics({
        ...recorder?.snapshot(),
        context,
        app: { referrer: win.document.referrer },
        device: {
          userAgent: safe(() => win.navigator.userAgent, ''),
          language: safe(() => win.navigator.language, ''),
          online: safe(() => win.navigator.onLine, true),
          width: win.innerWidth,
          height: win.innerHeight,
          dpr: win.devicePixelRatio,
        },
      }),
    {},
  )
}
