# Owner dashboard

Milestone 7 adds sign-in and site management. The dashboard is server-rendered by the same Worker that takes reports, on the Worker's own origin, so it needs no CORS and no client script. The reports inbox, report detail, and the screenshot proxy are milestone 8.

## Try it locally

```bash
npm run setup:local
npm start
npm run login:local
```

`setup:local` adds the seeded owner to `SIGNUP_ALLOWLIST` in `.dev.vars` when that setting is absent, and leaves an existing list alone. `login:local` prints a one-time sign-in link for that owner. Open it, press Sign in, and the seeded Local demo site is listed.

The real flow works too: open <http://localhost:2833/login>, enter the seeded address, and take the link from the terminal running the Worker. `MAIL_MODE` is `console`, so mail is printed, not sent.

## Sign-in

Owners sign in with a link sent to their email address. There are no passwords.

- **Allowlist.** `SIGNUP_ALLOWLIST` is a required secret holding addresses (`owner@example.com`) and whole domains (`@example.com`), separated by commas or whitespace. An empty list admits nobody. It is checked when a link is requested and again on every signed-in request, so removing an address ends that owner's sessions and unused links at once.
- **No enumeration.** Every well-formed address gets the same "check your email" page, whether or not it is allowed, and a storage failure gets that page too.
- **Links.** A link carries 256 random bits, works once, and expires after 15 minutes. Only its SHA-256 is stored. Following the link shows a button; pressing the button is what signs in, so mail scanners and link previews cannot spend it.
- **Limits.** Link requests are limited to five a minute per IP address and per email address, and one address can hold at most five unused links.
- **Accounts.** The first successful sign-in creates the owner's account. Requesting a link creates only a bare user row, so links requested for addresses nobody controls do not create tenants.
- **Sessions.** A session lasts 30 days. The cookie is `__Host-bz_session` (`HttpOnly`, `Secure`, `SameSite=Lax`), holding a random token whose hash is stored. Plain-HTTP localhost uses `bz_session`, because browsers refuse the `__Host-` prefix without `Secure`. Signing out deletes the session on the server.
- **Cross-site requests.** Every state change is a form post, refused unless its `Origin` header is the dashboard's own origin.
- **Roles.** Only a membership with the `owner` role can use the dashboard. The `member` role exists in the schema and has no screens yet.

Every page is sent with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and a Content Security Policy that allows the dashboard stylesheet and nothing else: no script, no frames, no other origin.

## Sites

- **Create.** A site needs a name and at least one allowed origin. Origins are HTTPS, or HTTP on localhost, and anything after the host is dropped. An account can hold 10 sites, and a site 20 origins.
- **Keys.** The public key (`bz_pk_…`) goes in the embed snippet, which the site page shows ready to copy. The signing secret (`bz_sk_…`) is shown once, in the response that created it, and is stored only encrypted under `SITE_KEK`. It cannot be shown again.
- **Rotate.** Rotating makes a new secret and shows it once. The secret it replaces keeps verifying identity tokens for 24 hours, so pages already open keep reporting. Only one previous secret is kept: rotating twice inside 24 hours ends the oldest one immediately. Two rotations sent at the same moment produce one new secret; the other request is refused.
- **Origins.** Add or remove origins on the site page. A site with no origins accepts no reports.

Every query carries the account id from the session. A site key belonging to another account gets the same 404 page as a key that was never issued.

## Deploying

A deployed Worker needs the `SIGNUP_ALLOWLIST` secret alongside `SITE_KEK`. Until a sending domain exists, `MAIL_MODE` stays `console` and the sign-in link is read from the Worker's logs (`wrangler tail`), which only the Cloudflare account owner can see. Switching to real mail needs SPF and DKIM records on the sending domain.
