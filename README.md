# Bugzap

Pin-drop feedback for websites. Someone clicks anything on a page, a pin drops there, and a report goes out with the URL, the element under the pin, the viewport, and a screenshot, so nobody has to describe where the problem is.

Built for Routeloop and every other Feral Creative project: a small embeddable script plus a hosted backend on Cloudflare Workers that collects the reports and shows them to the site owner.

## Status

In development. The decisions and open questions are in [docs/ROADMAP.md](docs/ROADMAP.md), and the build plan is in [_PLANS/v1-build-plan.md](_PLANS/v1-build-plan.md), tracked as GitHub issues #1–#8. Code being borrowed from other projects is in [reference/](reference/README.md), which is read-only source material and is never run.

## Development

Needs Node 22 or later.

```bash
npm install
npm start
```

`npm start` runs the Worker on <http://localhost:2833/> under `wrangler dev`, rebuilds the widget on every save under `src/widget`, and serves a stand-in host site from `demo/` on <http://localhost:2834/>, a separate origin, so the widget talks to the Worker cross-origin as it would on a real site. It opens the demo page once the Worker answers; `npm run start:no-open` (or `OPEN_BROWSER=0`) skips that. Ctrl-C stops all of it.

| Command | What it does |
| --- | --- |
| `npm test` | Vitest: `core` in Node, `widget` in happy-dom, `worker` inside the Workers runtime |
| `npm run typecheck` | `tsc` against each area's own tsconfig, plus the tests |
| `npm run types` | Regenerates `worker-configuration.d.ts` after a change to `wrangler.jsonc` |
| `npm run build:widget` | Builds `dist/assets/v1/bugzap.js` on its own |

## Layout

| Path | What lives there |
| --- | --- |
| `src/core/` | Pure logic shared by the widget and the Worker: no DOM, no Workers APIs |
| `src/widget/` | The embeddable script |
| `src/worker/` | The Hono app: ingest and read APIs, and the owner dashboard |
| `migrations/` | D1 schema migrations |
| `demo/` | The stand-in host site |
| `utils/` | Dev and build scripts |

## License

Source-available under the [Functional Source License 1.1, Apache 2.0 Future License](LICENSE.md) (FSL-1.1-ALv2). You may read, run, and modify it for any purpose except offering a competing product or service. Each release converts to Apache 2.0 two years after it is published.
