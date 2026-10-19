import { Hono } from 'hono'
import ingest from './ingest'
import { IngestError } from './ingest/body'

const app = new Hono<{ Bindings: Env }>()

// Liveness only: answers without touching D1 or R2, so a slow binding cannot make
// the Worker look down. Also what utils/open-when-ready.js polls in dev.
app.get('/healthz', (c) => c.text('ok'))
app.route('/v1/reports', ingest)

app.onError((error, c) => {
  if (error instanceof IngestError)
    return c.json({ ok: false, error: error.code, message: error.message }, error.status)
  console.error(JSON.stringify({ event: 'request_failed', path: c.req.path }))
  return c.json({ ok: false, error: 'service_unavailable', message: 'Please try again shortly.' }, 503)
})

export default app
