# Bugzap roadmap

Brainstorm started 2026-10-17 in Routeloop (`~/www/moto/routeloop`) and moved here on 2026-10-18.

## Goal

A pin-drop feedback tool. A user or client clicks anything on a page, a pin drops there, and a report goes out carrying the URL, the element under the pin, the click point, the viewport, and a screenshot. One tool for Routeloop and every other Feral Creative project.

## Shape

Decided 2026-10-18. The full build plan, with the schema, the APIs, and eight milestones (issues #1–#8), is [_PLANS/v1-build-plan.md](../_PLANS/v1-build-plan.md).

- **An embeddable, framework-free script** that drops the pin, takes the screenshot, and posts the report to the hosted backend. It runs in a shadow DOM so it cannot clash with any host's CSS.
- **A hosted backend on Cloudflare Workers**: D1 for data, R2 for screenshots, the widget served as a static asset, and an owner dashboard rendered by the same Worker. v1 ships the widget and the backend together.
- **Reporters are identified by the host site**, which signs an HS256 token over the user's id, email, and name with a per-site secret. Sites with no login of their own cannot use v1.
- **Screenshots are automatic DOM capture** (modern-screenshot), cropped around the pin, with a file upload when the capture comes out blank.
- **Routeloop moves to the hosted backend** like any other site, rather than keeping its own `/feedback` intake.
- **Report kinds are bug, idea, and question**, as in Routeloop.
- **Multi-tenant from the start** (accounts, sites, reports) so it can become a freemium product under FSL-1.1-ALv2, but billing is not in v1.

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

- Domain: bugzap.app or bugzap.io. v1 runs on `workers.dev` until then, and the email sending domain waits on the same decision, since both are DNS changes.
- Screenshot retention: proposed as an R2 lifecycle rule at 180 days.
- Query strings: proposed as stripped by default, with a per-site list of parameters to keep.
- Sites with no login of their own: proposed as reviewer invites over a magic link, after v1.

Settled 2026-10-18: hosting (Cloudflare Workers), screenshots (DOM capture with upload fallback), reporters (host-identified), and who sees pins (the reporter sees their own, the owner sees all of them through the dashboard).
