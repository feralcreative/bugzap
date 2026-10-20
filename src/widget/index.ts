import { safe } from './guard'
import { installWidget } from './runtime'

// Capture currentScript synchronously: it is null after an await or a callback.
// The queue can be initialized before or after the async embed arrives.
safe(() => {
  const script = document.currentScript as HTMLScriptElement | null
  const origin = script?.src ? new URL(script.src, location.href).origin : location.origin
  const nonce = script?.nonce
  if (document.documentElement) installWidget(window, origin, nonce)
  else
    document.addEventListener('DOMContentLoaded', () => safe(() => installWidget(window, origin, nonce), undefined), {
      once: true,
    })
}, undefined)
