export type WidgetOptions = { site: string; identity?: string; api?: string }
export type WidgetEvent = 'ready' | 'open' | 'close' | 'submitted' | 'error'
export type WidgetListener = (detail: Readonly<Record<string, unknown>>) => void
export type BugzapApi = ((command: string, ...args: unknown[]) => void) & {
  q?: ArrayLike<unknown>[]
  installed?: boolean
}

declare global {
  interface Window {
    Bugzap?: BugzapApi
  }
}
