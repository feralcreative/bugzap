# Report ingestion

Milestone 3 implements local report intake. Milestone 4 adds [the pin-and-submit widget](embed.md). The dashboard, email notifications, attachment proxy, and orphan sweep are later milestones. Nothing in the local setup utilities creates cloud resources.

## Run locally

From the repository root:

```bash
npm ci
npm run setup:local
npm start
```

The Worker listens on <http://localhost:2833> and the demo host on <http://localhost:2834>. Setup creates a free account, its owner, a site, and its allowed origin in local D1. The site secret is encrypted with AES-GCM under `SITE_KEK`, with the site's public key authenticated as additional data. Both `.dev.vars` and `.dev.vars.seed.json` are Git-ignored and written with mode `600`. Existing credentials are reused; an existing output file is never overwritten. Keep the local encryption key, seed file, and `.wrangler` database together.

To add a second local origin without changing the site's keys:

```bash
npm run setup:local -- --origin http://127.0.0.1:2834
```

## Signed curl smoke test

With the dev server running, use a second terminal in the repo root. This writes a short-lived token and payload into a private temporary directory. The token stays out of shell arguments and terminal output.

```bash
BUGZAP_TEST_DIR="$(mktemp -d)"
node utils/sign-identity.js --sub curl-reviewer --output "$BUGZAP_TEST_DIR/identity"
node --input-type=module - "$BUGZAP_TEST_DIR" <<'JS'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const directory = process.argv[2]
const seed = JSON.parse(await readFile('.dev.vars.seed.json', 'utf8'))
const identity = (await readFile(join(directory, 'identity'), 'utf8')).trim()
const payload = {
  v: 1,
  site: seed.site,
  identity,
  kind: 'bug',
  body: 'The save button does nothing.',
  page: { url: `${seed.origin}/editor?secret=removed`, title: 'Editor' },
  pin: null,
  screenshot: { mode: 'none' },
  diagnostics: { app: { version: 'local-smoke' } },
}
await writeFile(join(directory, 'payload.json'), JSON.stringify(payload), { flag: 'wx', mode: 0o600 })
JS
curl --fail-with-body --silent --show-error \
  -H 'Origin: http://localhost:2834' \
  --form "payload=<$BUGZAP_TEST_DIR/payload.json;type=application/json" \
  http://localhost:2833/v1/reports
```

A successful response is HTTP `201` with `{"ok":true,"id":"<22-character-public-id>"}`. Query local rows with:

```bash
npx wrangler d1 execute bugzap --local --command \
  'SELECT public_id, kind, state, status, page_url FROM reports ORDER BY id DESC LIMIT 5'
```

The token expires after 24 hours by default. `sign-identity.js` accepts `--sub`, optional `--email` and `--name`, `--ttl` in seconds (1–604800), and `--output`. Without `--output` it writes the token to stdout. Signing keys belong on the host server; only the public site key and resulting token belong in the browser.

## Wire contract

Send `POST /v1/reports?site=bz_pk_…` as browser-generated `multipart/form-data`; let `fetch` set its boundary. The query site must match `payload.site`. It is optional for POSTs without a preflight, including the curl example. Preflight requests require it so the server can check that site's origin allowlist without a request body. CORS permits only the exact allowed origin, POST, and the Content-Type header; it never enables credentials or a wildcard origin.

| Part          | Meaning                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `payload`     | Exactly one text field containing a version 1 report JSON object, at most 64 KiB in UTF-8         |
| `screenshot`  | One PNG or JPEG file when `screenshot.mode` is `auto` or `upload`; absent when the mode is `none` |
| `attachments` | Zero to two additional PNG or JPEG file fields                                                    |

The JSON fields are `v`, `site`, `identity`, `kind`, `body`, `page`, `pin`, `screenshot`, and optional `diagnostics`; the parser is in `src/core/payload.ts`. `pin: null` submits a page-level report. `screenshot: { "mode": "none", "failed": "capture timed out" }` records capture failure without blocking a text report. Every file is capped at 2 MiB and 40 million pixels. The whole request is capped at three file limits plus the JSON limit and 16 KiB for multipart overhead, even when Content-Length is absent.

The submitting Origin must be allowlisted and must match `page.url`'s origin. Credentials, query strings, and fragments are dropped from stored page URLs; `page_key` also normalizes trailing slashes. Diagnostics are redacted before storage. Client MIME types, filenames, account IDs, and reporter fields are never trusted. Images are sniffed and structurally checked, metadata is stripped, and the server generates each private R2 key. Uploaded images are not publicly served by this milestone.

## Responses and failure behavior

Failures return `{"ok":false,"error":"<code>","message":"<human-readable-detail>"}`. All responses from the report route use `Cache-Control: no-store` and `Vary: Origin`. Responses after a successful origin check include its CORS header, including identity and validation errors.

| HTTP | Error codes                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400  | `invalid_multipart`, `invalid_payload`, `invalid_site_key`, `invalid_page`, `invalid_parts`, `too_many_images`, `screenshot_mismatch`, `invalid_image` |
| 401  | `invalid_identity`                                                                                                                                     |
| 403  | `origin_forbidden`, `site_disabled`                                                                                                                    |
| 404  | `site_not_found`                                                                                                                                       |
| 413  | `request_too_large`, `payload_too_large`, `image_too_large`                                                                                            |
| 415  | `unsupported_media_type`, `invalid_image`                                                                                                              |
| 429  | `burst_limited` (Retry-After: 10), `hourly_limited` (Retry-After: 3600)                                                                                |
| 503  | `storage_unavailable`, `service_unavailable`                                                                                                           |

Limits are per signed reporter subject and site: five attempts per ten seconds through the Workers binding, plus ten accepted reports per rolling hour in D1. A database trigger repeats the hourly check inside the atomic batch, so concurrent requests cannot bypass it. The edge burst counter is an approximate, per-location guard; the D1 check enforces the hourly count. See [Cloudflare's rate limit semantics](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Reporter updates, report, pin, attachment records, and diagnostics commit in one D1 batch. Reports start `pending` and `new`; account/site composite foreign keys prevent cross-tenant child rows. Files are uploaded before this batch. A failed upload or confirmed database rollback triggers deletion of attempted R2 objects. If a database response is lost, intake checks whether the report committed before deleting anything. If D1 cannot confirm the result, or R2 cleanup fails, the handler logs only an event and the generated report ID and leaves the objects for the future orphan sweep. An HTTP retry can create a duplicate if the commit outcome remains unknown; request idempotency is not implemented yet.
