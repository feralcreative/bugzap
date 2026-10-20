import type { CaptureModule } from './index'

// Replaced by utils/build-widget.js with the content-hashed chunk path.
declare const __BUGZAP_CAPTURE__: string | undefined
const PATH = typeof __BUGZAP_CAPTURE__ === 'string' ? __BUGZAP_CAPTURE__ : '/v1/capture.js'

let loading: Promise<CaptureModule> | null = null

/** Loads the screenshot chunk once, through a classic script tag so the host's
 *  CSP nonce applies to it the same way it does to the embed. */
export function loadCapture(win: Window, origin: string, nonce?: string): Promise<CaptureModule> {
  if (win.__bugzapCapture) return Promise.resolve(win.__bugzapCapture)
  loading ??= new Promise<CaptureModule>((resolve, reject) => {
    const script = win.document.createElement('script')
    script.async = true
    if (nonce) script.nonce = nonce
    script.src = new URL(PATH, origin).href
    script.onload = () => {
      script.remove()
      if (win.__bugzapCapture) resolve(win.__bugzapCapture)
      else reject(new Error('capture chunk did not register'))
    }
    script.onerror = () => {
      script.remove()
      reject(new Error('capture chunk failed to load'))
    }
    ;(win.document.head ?? win.document.documentElement).append(script)
  }).catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}
