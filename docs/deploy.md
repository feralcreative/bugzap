# Deploying

Bugzap deploys as a Cloudflare Worker with Wrangler, to two environments on the Feral Creative Cloudflare account. Each is a custom domain in the `bugzap.app` zone: staging at `stage.bugzap.app` and production at `bugzap.app`. Deploying an environment creates and manages the one DNS record for its hostname; nothing else in the zone is touched. A mail sending domain is a separate, later decision.

| Environment | Script                    | Worker           | Database            | Bucket                    |
| ----------- | ------------------------- | ---------------- | ------------------- | ------------------------- |
| Staging     | `./utils/deploy/stage.sh` | `bugzap-staging` | `bugzap-staging`    | `bugzap-shots-staging`    |
| Production  | `./utils/deploy/prod.sh`  | `bugzap`         | `bugzap-production` | `bugzap-shots-production` |

Staging was first deployed on 2026-11-18 and answers at <https://stage.bugzap.app>. Its `workers.dev` address, <https://bugzap-staging.ziad-af.workers.dev>, is still on until the custom domain has been used for a sign-in; turn it off by setting `workers_dev` to `false` under `env.staging`. Production does not exist yet. One thing the first setup turned up: R2 has to be enabled once for the account in the Cloudflare dashboard before any bucket can be created, and when `wrangler d1 create` or `wrangler r2 bucket create` offers to add the binding to the config on your behalf, answer no, because it rewrites `wrangler.jsonc` and adds a stray top-level binding.

## The scripts

```bash
cd /Users/ziad/www/bugzap
./utils/deploy/stage.sh
```

Each run does the same things in order and stops at the first failure:

1. Runs the type check and the full test suite.
2. Builds the widget, which fails if the embed is over its 15 KiB budget.
3. Refuses to go on if the environment's database has unapplied migrations, and prints the command that applies them. Migrations and secrets are never applied by the script.
4. Deploys with `wrangler deploy --env`.
5. Prints a summary with the URL, the commit, and the timings.

`prod.sh` also refuses a dirty working tree or a branch other than `main`, and asks you to type `yes`. `--force` skips the tree and branch checks, never the question. `--dry-run` runs the checks and bundles the Worker without uploading anything, and only warns where a real deploy would stop. `--help` prints the usage.

A plain `npx wrangler deploy` with no `--env` targets a Worker called `bugzap-local` with no real database. That name exists so a deploy without an environment cannot replace either real Worker; do not use it.

## One-time setup for an environment

Do this once for staging. For production, repeat it with `production` in place of `staging` in every name and `--env` flag, `bugzap` as the Worker to tail, and `./utils/deploy/prod.sh` as the script.

### 1. Sign in

This opens a browser. Check afterwards that the account listed is Feral Creative's.

```bash
cd /Users/ziad/www/bugzap
npx wrangler login
npx wrangler whoami
```

### 2. Make the encryption key

`SITE_KEK` encrypts every site's signing secret. If it is lost, every site has to rotate its secret; if it leaks, every stored secret can be decrypted. Use a different key for each environment.

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Save the output as a 1Password item and note the item's UUID.

### 3. Create the database and the bucket

```bash
cd /Users/ziad/www/bugzap
export CLOUDFLARE_ACCOUNT_ID=30aa05fc7822ef63635046e5c7771a9a
npx wrangler d1 create bugzap-staging --location wnam
npx wrangler r2 bucket create bugzap-shots-staging
```

`d1 create` prints a `database_id`. Put it in `wrangler.jsonc` under `env.staging.d1_databases`, in place of the all-zero placeholder, and commit that change. The id is not a secret. The deploy script refuses to run while the placeholder is still there.

### 4. Apply the migrations

```bash
cd /Users/ziad/www/bugzap
export CLOUDFLARE_ACCOUNT_ID=30aa05fc7822ef63635046e5c7771a9a
npx wrangler d1 migrations apply DB --env staging --remote
```

### 5. Create the Google OAuth client

Owners sign in with Google, so the Worker needs an OAuth client. One client can serve every environment. In the Google Cloud console, under APIs & Services:

1. Configure the OAuth consent screen if the project has none: an app name, a support address, and the `openid`, `email`, and `profile` scopes. For a consent screen in Testing, add each owner's address as a test user; publish it to let any allowlisted Google account sign in.
2. Under Credentials, create an OAuth client ID of type Web application.
3. Add these authorized redirect URIs, exactly:

```text
https://stage.bugzap.app/login/google/callback
https://bugzap.app/login/google/callback
http://localhost:2833/login/google/callback
```

Save the client ID and the client secret in one 1Password item, and note the item's UUID.

### 6. Set the secrets

Replace the two `ITEM_UUID`s and the field names with the 1Password items' own, and the allowlist with the addresses or `@domain`s that may sign in. Wrangler may ask to create the Worker first; say yes.

```bash
cd /Users/ziad/www/bugzap
export CLOUDFLARE_ACCOUNT_ID=30aa05fc7822ef63635046e5c7771a9a
op read "op://VAULT/ITEM_UUID/credential" --account ziadezzat.1password.com | npx wrangler secret put SITE_KEK --env staging
print -n "@example.com" | npx wrangler secret put SIGNUP_ALLOWLIST --env staging
op read "op://VAULT/GOOGLE_ITEM_UUID/username" --account ziadezzat.1password.com | npx wrangler secret put GOOGLE_CLIENT_ID --env staging
op read "op://VAULT/GOOGLE_ITEM_UUID/credential" --account ziadezzat.1password.com | npx wrangler secret put GOOGLE_CLIENT_SECRET --env staging
```

### 7. Deploy

```bash
cd /Users/ziad/www/bugzap
./utils/deploy/stage.sh
```

## First sign-in

Open `/login` on the environment's URL and press Sign in with Google. A Google account on the allowlist lands on Sites; any other is told it cannot sign in. The account must be a Google Workspace account for its address's domain, or a Gmail account. Then create a site for the host that will embed the widget, with its origin, and copy the signing secret it shows once.

## Checks after a first deploy

- `/healthz` answers `ok`. The script does not check this itself.
- `/v1/bugzap.js` loads, with `Access-Control-Allow-Origin: *`.
- Signing in with Google works; this is the first time the `__Host-` cookies and the real Google exchange are used.
- A report from the embedding site appears in the inbox with its screenshot, and Open on page draws its pin.
- The hourly cron trigger shows under the Worker's Triggers in the Cloudflare dashboard, and a `sweep` event appears in the log within the hour. The trigger is declared once at the top of `wrangler.jsonc` and inherited by both environments; this is the check that it was.

## Later deploys

Run the script. When a change adds a migration, the script stops and prints the `migrations apply` command for that environment; run it, then run the script again.

## Known gaps on a deployed Worker

- No mail is sent. A new report writes a one-line notice with its link to the Worker's log (`npx wrangler tail`), until a sending domain exists.
- Screenshots are kept indefinitely; the proposed 180-day R2 lifecycle rule is not set.
- Capture speed on Routeloop's real builder page has not been measured. The staging embed is where that gets answered.

## Removing an environment

The bucket must be empty before it can be deleted.

```bash
cd /Users/ziad/www/bugzap
export CLOUDFLARE_ACCOUNT_ID=30aa05fc7822ef63635046e5c7771a9a
npx wrangler delete --env staging
npx wrangler d1 delete bugzap-staging
npx wrangler r2 bucket delete bugzap-shots-staging
```
