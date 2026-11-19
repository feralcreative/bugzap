# Owner dashboard

The dashboard is where a site's owner signs in, manages sites and keys, and reads and triages reports. It is server-rendered by the same Worker that takes reports, on the Worker's own origin, so it needs no CORS and no client script.

## Try it locally

```bash
npm run setup:local
npm start
npm run login:local
```

`setup:local` applies any new migrations, adds the seeded owner to `SIGNUP_ALLOWLIST` in `.dev.vars` when that setting is absent, and leaves an existing list alone. `login:local` prints a one-time sign-in link for that owner. Open it, press Sign in, and the seeded Local demo site is listed.

The real flow works too: open <http://localhost:2833/login>, enter the seeded address, and take the link from the terminal running the Worker. `MAIL_MODE` is `console`, so mail is printed, not sent.

## Sign-in

Owners sign in with a link sent to their email address. There are no passwords.

- **Allowlist.** `SIGNUP_ALLOWLIST` is a required secret holding addresses (`owner@example.com`) and whole domains (`@example.com`), separated by commas or whitespace. An empty list admits nobody. It is checked when a link is requested and again on every signed-in request, so removing an address ends that owner's sessions and unused links at once.
- **No enumeration.** Every well-formed address gets the same "check your email" page, whether or not it is allowed, and a storage failure gets that page too.
- **Links.** A link carries 256 random bits, works once, and expires after 15 minutes. Only its SHA-256 is stored. Following the link shows a button; pressing the button is what signs in, so mail scanners and link previews cannot spend it.
- **Limits.** Link requests are limited to five a minute per IP address and per email address, and one address can hold at most five unused links.
- **Accounts.** The first successful sign-in creates the owner's account. Requesting a link creates only a bare user row, so links requested for addresses nobody controls do not create tenants.
- **Sessions.** A session lasts 30 days. The cookie is `__Host-bz_session` (`HttpOnly`, `Secure`, `SameSite=Lax`), holding a random token whose hash is stored. Plain-HTTP localhost uses `bz_session`, because browsers refuse the `__Host-` prefix without `Secure`. Signing out deletes the session on the server.
- **Cross-site requests.** Every state change is a form post, refused unless its `Origin` header is the dashboard's own origin, or the browser withholds the origin and marks the request `Sec-Fetch-Site: same-origin`.
- **Roles.** Only a membership with the `owner` role can use the dashboard. The `member` role exists in the schema and has no screens yet.

Every page is sent with `Cache-Control: no-store`, `Referrer-Policy: same-origin`, and a Content Security Policy that allows the dashboard stylesheet and nothing else: no script, no frames, no other origin.

## Sites

- **Create.** A site needs a name and at least one allowed origin. Origins are HTTPS, or HTTP on localhost, and anything after the host is dropped. An account can hold 10 sites, and a site 20 origins.
- **Keys.** The public key (`bz_pk_…`) goes in the embed snippet, which the site page shows ready to copy. The signing secret (`bz_sk_…`) is shown once, in the response that created it, and is stored only encrypted under `SITE_KEK`. It cannot be shown again.
- **Rotate.** Rotating makes a new secret and shows it once. The secret it replaces keeps verifying identity tokens for 24 hours, so pages already open keep reporting. Only one previous secret is kept: rotating twice inside 24 hours ends the oldest one immediately. Two rotations sent at the same moment produce one new secret; the other request is refused.
- **Origins.** Add or remove origins on the site page. A site with no origins accepts no reports.

Every query carries the account id from the session. A site key belonging to another account gets the same 404 page as a key that was never issued.

## Reports

Each site has an inbox at `/sites/<key>/reports`, newest first, 50 to a page, with a tab per state and a count on each.

- **States.** Every report arrives in the Inbox (`pending`), private to its reporter and the account. Archived and Spam hide it from the reporter's page. Published is reserved for a future public board and changes nothing else yet.
- **Detail.** The report page shows the reporter's words exactly as written, who sent it, the page, the pinned element (tag, label, text, and selector), the screenshot and attachments, and the redacted diagnostics. Everything a reporter supplied is rendered as text.
- **Triage.** The owner can change the title, the state, the status the reporter is told, a priority from P0 to P3, and a private note. The reporter's words are never edited.
- **Images.** The screenshot bucket is private. Images are served only through `/reports/<id>/images/<image>`, which needs the owner's session and sends `nosniff`, a sandboxing Content Security Policy, and `Cache-Control: private, no-store`.
- **Open on page.** This opens the report's page with that report's pin drawn on it, even though the owner is not the reporter and may not be signed in to the host site. The link carries a token in the URL fragment that names one report and lasts 15 minutes. The widget removes it from the address bar and uses it to fetch that single pin. It works only on the report's own page, on an origin the site still allows; spam is never drawn. A whole-page report opens its page with no token. Two limits: the token is readable by the host page's own scripts for the moment before the widget removes it, as anything in a page's URL is, so it is scoped to one pin and 15 minutes; and reports store their page without its fragment, so on an app that routes on the fragment the link opens the app's root, not the screen the report was filed on.
- **New-report mail.** When a report commits, each owner of the account is mailed the reporter's words and a link to the report. In `console` mode only the link is printed, so a reporter's words and name stay out of the logs.

## Hourly sweep

A cron trigger runs once an hour and removes expired sign-in links and sessions, user rows for addresses that asked for a link and never signed in, the stored copy of a rotated-out secret once its 24 hours are up, and screenshots in the bucket that no report claims and that are more than a day old. Each run handles at most 2,000 rows per table and 1,000 bucket objects, and carries on where it stopped. Locally, `curl http://localhost:2833/cdn-cgi/handler/scheduled` runs it once.

## Deploying

A deployed Worker needs the `SIGNUP_ALLOWLIST` secret alongside `SITE_KEK`, both migrations applied to the remote database, and the cron trigger in `wrangler.jsonc`. Until a sending domain exists, `MAIL_MODE` stays `console` and sign-in links and new-report notices are read from the Worker's logs (`wrangler tail`), which only the Cloudflare account owner can see. Switching to real mail needs SPF and DKIM records on the sending domain.
