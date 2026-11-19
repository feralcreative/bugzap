# Owner dashboard

The dashboard is where a site's owner signs in, manages sites and keys, and reads and triages reports. It is server-rendered by the same Worker that takes reports, on the Worker's own origin, so it needs no CORS and no client script.

## Try it locally

```bash
npm run setup:local
npm start
npm run login:local
```

`setup:local` applies any new migrations and adds the seeded owner to `SIGNUP_ALLOWLIST` in `.dev.vars` when that setting is absent, leaving an existing list alone. The seeded owner's address is not a real Google account, so `login:local` creates a one-day session for it directly and prints a one-line `document.cookie` command: open <http://localhost:2833/login>, paste the line into the browser console, and reload.

To use real Google sign-in locally, add `http://localhost:2833/login/google/callback` to the OAuth client's redirect URIs, put the client's values in `.dev.vars` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and add your own address to `SIGNUP_ALLOWLIST`. While those two are empty the sign-in button answers that Google sign-in is not set up.

## Sign-in

Owners sign in with Google. There are no passwords and no email from Bugzap. Sign-in by emailed link was replaced on 2026-11-18, before any owner had used it.

- **The flow.** The Sign in with Google link sends the browser to Google with a `state`, a `nonce`, and a PKCE challenge, and keeps their originals in a cookie that lasts ten minutes and is used once. Google sends the browser back to `/login/google/callback` with a code. The Worker checks the `state` against the cookie, then exchanges the code for an ID token directly with Google, using the client secret and the PKCE verifier.
- **What is checked.** The token must be issued by Google, for this app's client id, unexpired, carrying this attempt's `nonce`, with an email address Google marks as verified and is the authority for: a Gmail address, or a Google Workspace account whose hosted domain (`hd`) is the address's domain. A personal Google account made with an outside address is refused, because Google verified that address once and cannot say who holds it now. The token is trusted because it comes straight from Google's token endpoint over TLS; a token arriving any other way is never read.
- **Allowlist.** `SIGNUP_ALLOWLIST` is a required secret holding addresses (`owner@example.com`) and whole domains (`@example.com`), separated by commas or whitespace. An empty list admits nobody. It is checked at sign-in and again on every signed-in request, so removing an address ends that owner's sessions at once.
- **Identity.** A person is known by Google's stable account id, stored on first sign-in, not by their address. If their address changes at Google their account follows. If an address later belongs to a different Google account, that account is refused: it does not inherit the previous holder's sites. If a known person's address moves off the allowlist, their existing sessions end the next time they try to sign in, as well as on their next request.
- **Accounts.** The first successful sign-in creates the owner's account. Nothing is stored for a Google account that is not on the allowlist.
- **Sessions.** A session lasts 30 days. The cookie is `__Host-bz_session` (`HttpOnly`, `Secure`, `SameSite=Lax`), holding a random token whose hash is stored. Plain-HTTP localhost uses `bz_session`, because browsers refuse the `__Host-` prefix without `Secure`. Signing out deletes the session on the server.
- **Cross-site requests.** Every state change is a form post, refused unless its `Origin` header is the dashboard's own origin, or the browser withholds the origin and marks the request `Sec-Fetch-Site: same-origin`.
- **Roles.** Only a membership with the `owner` role can use the dashboard. The `member` role exists in the schema and has no screens yet.

Every page is sent with `Cache-Control: no-store`, `Referrer-Policy: same-origin`, and a Content Security Policy that allows the dashboard stylesheet and nothing else: no script, no frames, no other origin.

## Sites

- **Create.** A site needs a name, at least one allowed origin, and a choice of who can send reports. Origins are HTTPS, or HTTP on localhost, and anything after the host is dropped. An account can hold 10 sites, and a site 20 origins.
- **Embed.** The site page shows the snippet ready to paste, with the public key (`bz_pk_…`) filled in. For a site open to guests that is everything the owner needs; no secret is shown.
- **Who can send reports.** Open to guests is the default: anyone on an allowed origin can report, with an optional, unverified name and email, and each browser sees only its own pins. Require signed identity turns guests away and accepts only reporters the host's server vouches for with a signed token. Either can be changed later on the site page. Sites created before guests existed stay on signed identity until their owner changes them.
- **Signing secret.** Only a site that requires signed identity needs it. The secret (`bz_sk_…`) is shown once, when the site is created that way or switched to it, and is stored only encrypted under `SITE_KEK`. Switching a guest site to signed identity always issues a fresh secret.
- **Rotate.** Rotating makes a new secret and shows it once. The secret it replaces keeps verifying identity tokens for 24 hours, so pages already open keep reporting. Only one previous secret is kept: rotating twice inside 24 hours ends the oldest one immediately. Two rotations sent at the same moment produce one new secret; the other request is refused.
- **Origins.** Add or remove origins on the site page. A site with no origins accepts no reports.

Every query carries the account id from the session. A site key belonging to another account gets the same 404 page as a key that was never issued.

## Reports

Each site has an inbox at `/sites/<key>/reports`, newest first, 50 to a page, with a tab per state and a count on each.

- **States.** Every report arrives in the Inbox (`pending`), private to its reporter and the account. Archived and Spam hide it from the reporter's page. Published is reserved for a future public board and changes nothing else yet.
- **Detail.** The report page shows the reporter's words exactly as written, who sent it (marked as a guest, with an unverified name and email, when no token vouched for them), the page, the pinned element (tag, label, text, and selector), the screenshot and attachments, and the redacted diagnostics. Everything a reporter supplied is rendered as text.
- **Triage.** The owner can change the title, the state, the status the reporter is told, a priority from P0 to P3, and a private note. The reporter's words are never edited.
- **Images.** The screenshot bucket is private. Images are served only through `/reports/<id>/images/<image>`, which needs the owner's session and sends `nosniff`, a sandboxing Content Security Policy, and `Cache-Control: private, no-store`.
- **Open on page.** This opens the report's page with that report's pin drawn on it, even though the owner is not the reporter and may not be signed in to the host site. The link carries a token in the URL fragment that names one report and lasts 15 minutes. The widget removes it from the address bar and uses it to fetch that single pin. It works only on the report's own page, on an origin the site still allows; spam is never drawn. A whole-page report opens its page with no token. Two limits: the token is readable by the host page's own scripts for the moment before the widget removes it, as anything in a page's URL is, so it is scoped to one pin and 15 minutes; and reports store their page without its fragment, so on an app that routes on the fragment the link opens the app's root, not the screen the report was filed on.
- **New-report notice.** When a report commits, a notice is prepared for each owner of the account with the reporter's words and a link to the report. No mail is sent yet: `MAIL_MODE` is `console`, which writes only the link to the Worker's log, so a reporter's words and name stay out of the logs. Real delivery needs a sending domain.

## Hourly sweep

A cron trigger runs once an hour and removes expired sessions, the stored copy of a rotated-out secret once its 24 hours are up, and screenshots in the bucket that no report claims and that are more than a day old. Each run handles at most 2,000 rows per table and 1,000 bucket objects, and carries on where it stopped. Locally, `curl http://localhost:2833/cdn-cgi/handler/scheduled` runs it once.

## Deploying

[deploy.md](deploy.md) covers the environments, the secrets, the Google OAuth client, and the deploy scripts.
