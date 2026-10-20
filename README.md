# Bugzap

Pin-drop feedback for websites. Someone clicks anything on a page, a pin drops there, and a report goes out with the URL, the element under the pin, the viewport, and a screenshot, so nobody has to describe where the problem is.

Built for Routeloop and every other Feral Creative project: a small embeddable script plus a hosted backend on Cloudflare Workers that collects the reports and shows them to the site owner.

## Status

In development. Milestones 1–5 are implemented locally: the dev loop, shared core, report ingestion API, pin-and-submit widget, and saved-pin re-anchoring. Open the demo, click Feedback, choose a target, and send a report. Use [the builder demo](http://localhost:2834/builder.html) to test saved pins through DOM rebuilds. Screenshots and the owner dashboard come next. The decisions and open questions are in [docs/ROADMAP.md](docs/ROADMAP.md), and the build plan is in [\_PLANS/v1-build-plan.md](_PLANS/v1-build-plan.md), tracked as GitHub issues #1–#8. Code being borrowed from other projects is in [reference/](reference/README.md), which is read-only source material and is never run.

## Development

Needs Node 22 or later.

```bash
npm ci
npm run setup:local
npm start
```

`npm start` runs the Worker on <http://localhost:2833/> under `wrangler dev`, rebuilds the widget on every save under `src/widget`, and serves a stand-in host site from `demo/` on <http://localhost:2834/>, a separate origin, so the widget talks to the Worker cross-origin as it would on a real site. It opens the demo page once the Worker answers; `npm run start:no-open` (or `OPEN_BROWSER=0`) skips that. Ctrl-C stops all of it.

`setup:local` applies local D1 migrations and seeds a demo account and site, allowing `http://localhost:2834`. It creates private, Git-ignored `.dev.vars` (the encryption key) and `.dev.vars.seed.json` (the site's signing credentials). Rerunning it preserves the site's keys and existing reports. Keep these files with the local database. The [ingestion API guide](docs/ingest.md) includes a signed curl smoke test.

The demo server signs a fresh one-hour identity token for its demo reviewer whenever the page is loaded. The signing secret stays in the local server process. See [the embed guide](docs/embed.md) for the widget commands and host-site setup.

| Command                                                                          | What it does                                                                       |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `npm test`                                                                       | Vitest: `core` in Node, `widget` in happy-dom, `worker` inside the Workers runtime |
| `npm run typecheck`                                                              | `tsc` against each area's own tsconfig, plus the tests                             |
| `npm run types`                                                                  | Regenerates `worker-configuration.d.ts` after a change to `wrangler.jsonc`         |
| `npm run build:widget`                                                           | Builds `dist/assets/v1/bugzap.js` on its own                                       |
| `npm run setup:local`                                                            | Applies migrations and seeds a site in local Wrangler storage                      |
| `npm run identity:local -- --sub reviewer --output /private/tmp/bugzap-identity` | Writes a signed identity token to a new private file                               |

## Layout

| Path          | What lives there                                                        |
| ------------- | ----------------------------------------------------------------------- |
| `src/core/`   | Pure logic shared by the widget and the Worker: no DOM, no Workers APIs |
| `src/widget/` | The embeddable script                                                   |
| `src/worker/` | The Hono app: ingest and read APIs, and the owner dashboard             |
| `migrations/` | D1 schema migrations                                                    |
| `demo/`       | The stand-in host site                                                  |
| `utils/`      | Dev and build scripts                                                   |

## License

Source-available under the [Functional Source License 1.1, Apache 2.0 Future License](LICENSE.md) (FSL-1.1-ALv2). You may read, run, and modify it for any purpose except offering a competing product or service. Each release converts to Apache 2.0 two years after it is published.
