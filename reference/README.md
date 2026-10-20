# Reference code

Code copied from other projects to build Bugzap from. **Nothing in here is wired up or meant to run.** Each file still imports from the project it came from, so read it, take what is useful into `src/`, and rewrite the imports as you go. Delete a file from here once its useful parts have moved.

## routeloop/

Copied on 2026-10-18 from Routeloop (`~/www/moto/routeloop`) at commit `f46ca5a`, with the original paths kept so each file can be compared against its source. That source is Routeloop's rider-feedback system, which shipped on 2026-08-16 and has run in production since. It covers the intake, the triage queue, and the follow-up email; the pin-drop part is what Bugzap adds.

### Start here

- `docs/rider-feedback.md` is the design doc for the whole system: the vocabulary (a "report", never a "ticket"), the screens, why third-party tools were rejected, and every decision with its reasoning.

### Pure logic

Ported to `src/core/` on 2026-10-18 (issue #2) and deleted from here: `src/feedback/policy.ts` and `src/feedback/diagnostics.ts` (now `core/policy.ts` and `core/diagnostics.ts`), `src/images/policy.ts` (now `core/image-policy.ts`), and `src/maps/slug.ts` (now `core/ids.ts`), with their tests. `src/images/process.ts` and its test went at the same time without being ported, because Workers cannot run sharp; `core/image-strip.ts` does its metadata job instead.

- `src/feedback/faq.ts` tries to answer a question from the FAQ before the report is sent. Not part of v1; kept in case it is wanted later.

### Client side

Ported on 2026-10-19 (issue #4) and deleted from here: `public/js/feedback-buffer.js` and its test. The bounded recorder, host-safe hooks, and diagnostics collection now live in `src/widget/buffer.ts` and `src/widget/diagnostics.ts`, with widget tests under `test/widget/`. Routeloop-specific route patterns and preference blocks were not carried over.

- `public/js/feedback.js` re-encodes photos through a canvas to strip EXIF (GPS) and offers FAQ suggestions. It is progressive enhancement over a plain form POST.

### Server side, coupled to Routeloop

These import Routeloop's Drizzle `db`, its schema, its config, and its page layout.

- `src/db/schema-feedback.ts` is an excerpt of the four tables (`feedback`, `feedback_votes`, `feedback_diagnostics`, `feedback_attachments`) and three enums. It is a starting point for Bugzap's own schema, which will need a `pins` shape (URL, selector, click point, viewport) and a `sites` table for per-site keys.
- `src/feedback/service.ts` holds every query. Its one-want-per-user rule is enforced by a composite primary key, not by a check.
- `src/feedback/storage.ts` stores attachments on disk under integer ids, containment-checked so path traversal is structurally impossible.
- `src/feedback/notify.ts` emails the owner a new report and the reporter a status change, always after the transaction commits, and never throws.
- `src/routes/feedback.tsx` is the Hono routes for the multi-step intake, the reporter's own list, and the `/admin/feedback` triage queue.
- `src/auth/mailer.ts` is plain SMTP through nodemailer, so changing provider is a `.env` change.
- `src/emails/` holds the two feedback templates plus the shared shell, types, and theme they render through.
- `style/_feedback.scss` is styled in Routeloop's highway-sign visual language, so expect to take its layout ideas rather than the CSS itself.

### Tests

`test/` holds the remaining FAQ matcher tests.
