# Reference code

Code copied from other projects to build Bugzap from. **Nothing in here is wired up or meant to run.** Each file still imports from the project it came from, so read it, take what is useful into `src/`, and rewrite the imports as you go. Delete a file from here once its useful parts have moved.

## routeloop/

Copied on 2026-10-18 from Routeloop (`~/www/moto/routeloop`) at commit `f46ca5a`, with the original paths kept so each file can be compared against its source. That source is Routeloop's rider-feedback system, which shipped on 2026-08-16 and has run in production since. It covers the intake, the triage queue, and the follow-up email; the pin-drop part is what Bugzap adds.

### Start here

- `docs/rider-feedback.md` is the design doc for the whole system: the vocabulary (a "report", never a "ticket"), the screens, why third-party tools were rejected, and every decision with its reasoning.

### Pure logic, the most portable

These import nothing but types, and each has a test in `test/` that runs with no database.

- `src/feedback/policy.ts` defines what a report is, who may see it, rate limits, and every status label. Its key rule is that a bug stays private to its author and the owner until published, which is a `state` column separate from the reporter-facing `status`.
- `src/feedback/diagnostics.ts` redacts browser diagnostics on the server before they are stored: query strings stripped, no location ever, and only permission states rather than values.
- `src/feedback/faq.ts` tries to answer a question from the FAQ before the report is sent.
- `src/images/policy.ts` is the upload security boundary. It sniffs the magic number and refuses SVG, which is the rule screenshot uploads need.
- `src/maps/slug.ts` makes unguessable 22-character base62 public ids.

### Client side

- `public/js/feedback-buffer.js` is a crash-proof ring buffer of console errors and failed requests, plus the diagnostics shaper. It is the closest thing here to Bugzap's embeddable script, and it already follows the rule that an error reporter must never crash the page.
- `public/js/feedback.js` re-encodes photos through a canvas to strip EXIF (GPS) and offers FAQ suggestions. It is progressive enhancement over a plain form POST.

### Server side, coupled to Routeloop

These import Routeloop's Drizzle `db`, its schema, its config, and its page layout.

- `src/db/schema-feedback.ts` is an excerpt of the four tables (`feedback`, `feedback_votes`, `feedback_diagnostics`, `feedback_attachments`) and three enums. It is a starting point for Bugzap's own schema, which will need a `pins` shape (URL, selector, click point, viewport) and a `sites` table for per-site keys.
- `src/feedback/service.ts` holds every query. Its one-want-per-user rule is enforced by a composite primary key, not by a check.
- `src/feedback/storage.ts` stores attachments on disk under integer ids, containment-checked so path traversal is structurally impossible.
- `src/feedback/notify.ts` emails the owner a new report and the reporter a status change, always after the transaction commits, and never throws.
- `src/routes/feedback.tsx` is the Hono routes for the multi-step intake, the reporter's own list, and the `/admin/feedback` triage queue.
- `src/images/process.ts` re-encodes every upload to WebP with sharp, stripping anything the decoder did not understand.
- `src/auth/mailer.ts` is plain SMTP through nodemailer, so changing provider is a `.env` change.
- `src/emails/` holds the two feedback templates plus the shared shell, types, and theme they render through.
- `style/_feedback.scss` is styled in Routeloop's highway-sign visual language, so expect to take its layout ideas rather than the CSS itself.

### Tests

`test/` holds the six tests covering the pure modules above. They run under Vitest.
