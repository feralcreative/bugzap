# First deploy to workers.dev

Written 2026-11-18. Nothing here has been run: Wrangler's login on this machine had expired, so none of these commands could be tried against Cloudflare. Each step creates something in the Cloudflare account and none touches DNS. v1 runs on the account's `workers.dev` subdomain; a custom domain and a mail sending domain are separate, later decisions.

## What gets created

- A Worker named `bugzap`, with its static assets (the widget) and an hourly cron trigger.
- A D1 database named `bugzap`.
- A private R2 bucket named `bugzap-shots`.
- Two Worker secrets, `SITE_KEK` and `SIGNUP_ALLOWLIST`.

## Before starting

`SITE_KEK` encrypts every site's signing secret. If it is lost, every site has to rotate its secret, and if it leaks, every stored secret can be decrypted. Make it once, keep it in 1Password, and read it from there:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Save the output as a 1Password item and note the item's UUID. The steps below read it with `op read` so it never lands in a file or in shell history.

## Steps

Sign in. This opens a browser:

```bash
cd /Users/ziad/www/bugzap
npx wrangler login
```

Confirm it is the personal Cloudflare account, not the acmpls one:

```bash
cd /Users/ziad/www/bugzap
npx wrangler whoami
```

Create the database and the bucket:

```bash
cd /Users/ziad/www/bugzap
npx wrangler d1 create bugzap --location wnam
npx wrangler r2 bucket create bugzap-shots
```

`d1 create` prints a `database_id`. Put it in `wrangler.jsonc` in place of the all-zero placeholder, and commit that change. The id is not a secret.

Apply the three migrations to the remote database:

```bash
cd /Users/ziad/www/bugzap
npx wrangler d1 migrations apply bugzap --remote
```

Set the two secrets. Replace `ITEM_UUID` with the 1Password item's UUID, and the address with the one that should be able to sign in. Wrangler may ask to create the Worker first; say yes.

```bash
cd /Users/ziad/www/bugzap
op read "op://Private/ITEM_UUID/credential" --account ziadezzat.1password.com | npx wrangler secret put SITE_KEK
print -n "you@example.com" | npx wrangler secret put SIGNUP_ALLOWLIST
```

Build the widget and deploy:

```bash
cd /Users/ziad/www/bugzap
npm run build:widget
npx wrangler deploy
```

`deploy` prints the Worker's URL, `https://bugzap.<subdomain>.workers.dev`.

## First sign-in

Mail is in `console` mode, so the sign-in link is written to the Worker's log. Start a tail in one terminal:

```bash
cd /Users/ziad/www/bugzap
npx wrangler tail bugzap
```

Open `/login` on the Worker's URL, enter the allowlisted address, and open the link the tail prints. Then create a site for Routeloop staging with its origin, and copy the signing secret it shows once.

## Checks after deploying

- `/healthz` answers `ok`.
- `/v1/bugzap.js` loads, with `Access-Control-Allow-Origin: *`.
- Signing in works over HTTPS; this is the first time the `__Host-bz_session` cookie is used for real.
- A report from the staging site appears in the inbox with its screenshot, and Open on page draws its pin.
- The cron trigger shows under the Worker's Triggers, and one hourly `sweep` event appears in the log.

## Known gaps on a deployed Worker

- Owners get sign-in links and new-report notices only through the log, until a sending domain exists.
- Screenshots are kept indefinitely; the proposed 180-day R2 lifecycle rule is not set.
- Capture speed on Routeloop's real builder page has not been measured. The staging embed is where that gets answered.

## Undoing it

```bash
cd /Users/ziad/www/bugzap
npx wrangler delete bugzap
npx wrangler d1 delete bugzap
npx wrangler r2 bucket delete bugzap-shots
```

The bucket must be empty before it can be deleted.
