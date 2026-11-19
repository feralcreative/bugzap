import type { CaptureModule } from './capture/index'

/**
 * `identity` decides how reporters are known. Leave the key out and visitors
 * report as guests. Include it, even as null, and the widget waits for a
 * host-signed token before it shows itself.
 */
export type WidgetOptions = { site: string; identity?: string | null; api?: string }
export type WidgetEvent = 'ready' | 'open' | 'close' | 'submitted' | 'error'
export type WidgetListener = (detail: Readonly<Record<string, unknown>>) => void
export type BugzapApi = ((command: string, ...args: unknown[]) => void) & {
  q?: ArrayLike<unknown>[]
  installed?: boolean
}

declare global {
  interface Window {
    Bugzap?: BugzapApi
    /** Set by the lazily loaded screenshot chunk. */
    __bugzapCapture?: CaptureModule
  }
}
