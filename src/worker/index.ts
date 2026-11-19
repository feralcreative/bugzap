import { Hono } from 'hono'
import dashboard from './dashboard'
import ingest from './ingest'
import { IngestError } from './ingest/body'
import pins from './pins'
import { sweep } from './sweep'

const app = new Hono<{ Bindings: Env }>()

// Liveness only: answers without touching D1 or R2, so a slow binding cannot make
// the Worker look down. Also what utils/open-when-ready.js polls in dev.
app.get('/healthz', (c) => c.text('ok'))
app.route('/v1/reports', ingest)
app.route('/v1/pins', pins)
// The owner dashboard: server-rendered pages on the Worker's own origin.
app.route('/', dashboard)

app.onError((error, c) => {
  if (error instanceof IngestError)
    return c.json({ ok: false, error: error.code, message: error.message }, error.status)
  console.error(JSON.stringify({ event: 'request_failed', path: c.req.path }))
  return c.json({ ok: false, error: 'service_unavailable', message: 'Please try again shortly.' }, 503)
})

// `fetch` stays a plain property so tests can call it as they would the app.
export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sweep(env, Math.floor(Date.now() / 1000)))
  },
} satisfies ExportedHandler<Env>
