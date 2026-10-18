# Bugzap roadmap

Brainstorm started 2026-10-17 in Routeloop (`~/www/moto/routeloop`) and moved here on 2026-10-18.

## Goal

A pin-drop feedback tool. A user or client clicks anything on a page, a pin drops there, and a report goes out carrying the URL, the element under the pin, the click point, the viewport, and a screenshot. One tool for Routeloop and every other Feral Creative project.

## Shape

Proposed 2026-10-17, not yet decided.

- **An embeddable, framework-free script** that drops the pin, takes the screenshot, and posts one JSON payload to an endpoint the host site configures. It runs in a shadow DOM so it cannot clash with any host's CSS.
- **A small hosted backend** (collector, dashboard, per-site keys, and screenshot storage) for projects with nothing of their own.
- **Routeloop points the script at its own `/feedback` intake** and keeps its queue, private-bug rule, status emails, and diagnostics (`public/js/feedback-buffer.js` there).

Standalone is roughly two or three sprints, against about one to build it inside Routeloop, because accounts, the queue, mail, storage, and the dashboard come free there and must be rebuilt here.

## What Routeloop already has to borrow from

Routeloop's feedback subsystem is the reference implementation for the intake side, and it was copied into [reference/routeloop/](../reference/routeloop/) on 2026-10-18. [reference/README.md](../reference/README.md) indexes every file and says which ones are portable and which are coupled to Routeloop. Its rules worth keeping: a bug report is private to its author and the owner until published, attachment bytes count against nobody's quota, and diagnostics never include a location.

## Known traps

- **Re-anchoring.** Pins must re-find their spot, and pages like Routeloop's builder rebuild their DOM with `innerHTML` on every edit, so a CSS selector alone goes stale. Prefer stable `data-*` attributes, with the click point plus the screenshot as the fallback.
- **Screenshots of embedded maps.** A DOM-to-image library renders cross-origin map tiles (Google Maps) blank, so the map comes out gray. `getDisplayMedia` captures true pixels but prompts every time and does not work on iOS.

## Name

Bugzap, chosen 2026-10-18. A bug bomb clears the whole room and a zap hits one bug, which is what a pin does. The bare `bugzap` npm name was free on 2026-10-18; bugzap.com and bugzap.dev are registered.

Domain still open: bugzap.app or bugzap.io, both with no nameservers on 2026-10-18 (probably unregistered, not confirmed with a registrar). The lean is .app, because .io's future depends on the Chagos Islands handover to Mauritius. Bugbomb (.dev and .io) was the runner-up.

Rejected: client-feedback vocabulary (redline, markup, punchlist, and so on) and fine-tuning vocabulary. Avoid trademarks: Sharpie, Post-it, and Roach Motel were floated and are all brands.

## Open questions

- Domain: bugzap.app or bugzap.io.
- Where the hosted backend runs: the Synology NAS (the personal-project default) or Cloudflare Workers.
- Screenshot method: a DOM-to-image library (a dependency), `getDisplayMedia`, or none.
- Whether reporters on other projects are anonymous, or identified by the host site.
- Who sees pins after they are dropped: only the site owner, or the reporter as well.
