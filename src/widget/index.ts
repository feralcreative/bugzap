// The embeddable widget. Built to dist/assets/v1/bugzap.js by utils/build-widget.js.
// Milestone 4 (#4) fills this in; until then it only drains the queue stub so
// hosts that already embed the snippet are left untouched.

type Stub = ((...args: unknown[]) => void) & { q?: unknown[][] }

const w = window as unknown as { Bugzap?: Stub }
if (w.Bugzap?.q) w.Bugzap.q.length = 0
