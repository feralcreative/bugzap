import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

// Liveness only: answers without touching D1 or R2, so a slow binding cannot make
// the Worker look down. Also what utils/open-when-ready.js polls in dev.
app.get('/healthz', (c) => c.text('ok'))

export default app
