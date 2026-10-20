# Embedding Bugzap

Milestones 4–5 support pinning an element, page-level feedback, sending reports, and displaying the reporter’s saved pins after reloads and DOM changes. Reports include the anchor and redacted diagnostics. Screenshots and the owner dashboard are later milestones.

## Try the local demo

```bash
npm ci
npm run setup:local
npm start
```

Open <http://localhost:2834/>. Click Feedback, then a host element such as Save changes. Pin selection consumes that click so the host action does not also run. Write a report and send it. The confirmation means the local Worker accepted the report into D1. Use Report this page to send a report without an element. Escape or Cancel closes the flow and restores host-page interaction. The ignored-area button continues to work during selection.

The Node demo server reads the private seed file and signs a one-hour token for `demo-reviewer` on each HTML request. It serves only the demo folder on localhost and rejects unrelated Host headers. Only the public site key and signed token reach the page; the signing secret and encryption key stay server-side. The HTML is served with `Cache-Control: no-store`.

## Add the embed to a host

Create a site and allow its exact origin in the backend. For now this is the local seed utility; site management through the dashboard is milestone 7. The host's server must sign an HS256 identity token with its site's secret, covering `sub`, optional `email` and `name`, `iat`, and `exp`. Use a lifetime of 24 hours or less; the server caps it at seven days. The [identity helper and intake contract](ingest.md) describe the local signing flow.

Render this snippet with the site's public key, a token signed for the signed-in user, and the address of the Bugzap Worker:

```html
<script>
  window.Bugzap =
    window.Bugzap ||
    function () {
      ;(window.Bugzap.q = window.Bugzap.q || []).push(arguments)
    }
  Bugzap('init', {
    site: 'YOUR_PUBLIC_SITE_KEY',
    identity: 'SERVER_SIGNED_IDENTITY_TOKEN',
  })
</script>
<script async src="https://YOUR_WORKER/v1/bugzap.js"></script>
```

Serialize template values as JSON and escape `<` as `\u003c` before placing them inside a script. Never put a `bz_sk_…` signing secret into a browser. The widget rejects a secret used as the site key. Its API origin defaults to the origin of its script; `api` in the init options can override it with an HTTPS origin or HTTP on localhost.

For hosts with a Content Security Policy, allow the Worker in `script-src` and `connect-src`. The widget copies the embed script's CSP nonce onto its shadow-root stylesheet, so put the host's current nonce on the embed script when nonce-based styles are required. Styles and controls live in an open shadow root. The UI uses a manual top-layer popover when available and falls back to a fixed layer. It builds DOM nodes directly and does not use `innerHTML`.

## Commands

The queue works before or after the async script loads. Calls return without throwing into the host page. Register events before `init` if you need the initial `ready` event.

| Command                                             | Behavior                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Bugzap('init', { site, identity, api? })`          | Creates the widget; repeated init replaces the previous instance's UI and clears its state                     |
| `Bugzap('identify', token)`                         | Supplies or refreshes an identity; clears the previous draft, context, and diagnostic buffer                   |
| `Bugzap('logout')`                                  | Aborts pending client work, clears identity and reporter state, and hides the launcher                         |
| `Bugzap('open')`                                    | Enters element-selection mode when identified                                                                  |
| `Bugzap('open', { page: true })`                    | Opens a page-level report directly, including for keyboard users                                               |
| `Bugzap('close')`                                   | Cancels selection/composition and clears the draft                                                             |
| `Bugzap('context', { build: 'v1', feature: true })` | Replaces the host's optional flat diagnostics context; secret/location keys and URL query strings are redacted |
| `Bugzap('on', event, callback)`                     | Listens for `ready`, `open`, `close`, `submitted`, or `error`                                                  |
| `Bugzap('refresh')`                                 | Reloads saved pins for the current identity and page                                                           |
| `Bugzap('destroy')`                                 | Removes the widget and its listeners and restores recorder hooks where it still owns them                      |

`submitted` receives `{ id }`, the report's public ID. `error` receives `{ code }`; raw exceptions, report text, and tokens are not sent to event callbacks. Callback exceptions and rejected promises are contained individually. `logout` or `identify` closes an open report; a late response from the previous identity cannot replace the current UI.

## Anchors and diagnostics

Use `data-bugzap-id="save"` for stable targets or ancestors. Capture also records test attributes and hand-written IDs, skipping generated IDs. An anchor includes ancestry, a CSS selector, tag, bounded text and label, element bounds, fractional click offset, page coordinates, and viewport size. Masked text, input values, textarea content, and editable content are excluded from anchor text. Saved pins are loaded for the current reporter and normalized page on subsequent visits.

Use `data-bugzap-ignore` on regions that must not be pinned. Use `data-bugzap-mask` on private content: its text is omitted from anchors now, and it is reserved for screenshot masking in milestone 6. A cross-origin iframe's contents cannot be inspected; its border can be selected as an iframe box. Interior iframe selection is not implemented in this milestone.

The recorder keeps the earliest 25 errors and ten failed or slow requests (at least three seconds). It preserves the host's console and fetch behavior, tolerates frozen or missing APIs, and stops collecting on logout. Diagnostics never read cookies or storage contents and never request a location. Query strings are stripped on the client and again by the Worker before storage. Oversized diagnostics are trimmed to fit the JSON cap so they cannot block a valid report.

Submission disables duplicate sends and ends the request after 15 seconds. Errors preserve the draft for a user-triggered retry; there is no automatic retry. Aborting a request cannot undo a report that already committed on the server.

## Build and verification

`npm run build:widget` emits `dist/assets/v1/bugzap.js` and the static asset headers. The public script is served with CORS enabled, `nosniff`, and a five-minute cache lifetime. The build enforces a 15 KiB gzip limit; screenshot code is not included in this milestone.

Widget tests run in happy-dom with their own DOM-only TypeScript config. Core and Worker tests use separate types so DOM `Element` and Workers HTMLRewriter `Element` do not collide. Coverage includes queue startup, pin capture, ignored regions, keyboard focus, error recovery, missing APIs, frozen console, logout isolation, cross-origin submission, retries, and diagnostics limits.

## Saved pins

Open <http://localhost:2834/builder.html>, pin Save changes, and submit. After Done, click the numbered pin to read the report and its status. Hide pins toggles the markers. Rebuild DOM 20 times replaces the entire card tree; Reorder cards moves the target; Remove target makes its pin dashed and approximate. Reload page restores the target and loads its persisted pin.

The resolver tries unique stable attributes, a selector scoped to a stable ancestor, the full selector, then a bounded fuzzy match. It preserves the fractional click position as the target moves or resizes. Missing stable targets and ambiguous matches use the original point scaled to the viewport, with an explicit approximate label. MutationObserver handles DOM replacement; ResizeObserver, scrolling, and resizing update geometry. Work is coalesced per animation frame. SPA pushState, replaceState, popstate, and hashchange refresh pins only when the normalized page changes. Logout and destroy cancel pending reads and remove observers and owned history hooks.

`GET /v1/pins?site=PUBLIC_KEY&page=NORMALIZED_PAGE_URL` requires `Authorization: Bearer SIGNED_IDENTITY_TOKEN`. Tokens never belong in the URL. The endpoint checks the site, exact allowed Origin, identity signature and rotation grace, and page origin. It returns `{ ok: true, pins, truncated }` with at most the latest 100 pinned reports owned by that subject on that site and page, in pending or published state. Each pin contains only public ID, kind, status, title, body, and anchor. Page-level, archived, and spam reports are excluded. Other reporters’ published reports and owner-only fields are excluded. Reporter tokens cannot request owner access. Reads use no cookies, responses are no-store, and the per-site/reporter read limit is 60/minute with Retry-After on 429. Read failures clear markers while leaving report composition available.
