# Deploying

Bugzap deploys as a Cloudflare Worker with Wrangler, to two environments on the Feral Creative Cloudflare account. Both run on `workers.dev` for now; a custom domain and a mail sending domain are separate, later decisions, and nothing here touches DNS.

| Environment | Script                    | Worker           | Database            | Bucket                    |
| ----------- | ------------------------- | ---------------- | ------------------- | ------------------------- |
| Staging     | `./utils/deploy/stage.sh` | `bugzap-staging` | `bugzap-staging`    | `bugzap-shots-staging`    |
| Production  | `./utils/deploy/prod.sh`  | `bugzap`         | `bugzap-production` | `bugzap-shots-production` |

As of 2026-11-18 neither environment exists yet, and only `--dry-run` has been exercised: Wrangler's login on this machine had expired, so no command here has been run against Cloudflare.

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

### 5. Set the secrets

Replace `ITEM_UUID` with the 1Password item's UUID, and the address with the one that may sign in to the dashboard. Wrangler may ask to create the Worker first; say yes.

```bash
cd /Users/ziad/www/bugzap
export CLOUDFLARE_ACCOUNT_ID=30aa05fc7822ef63635046e5c7771a9a
op read "op://Private/ITEM_UUID/credential" --account ziadezzat.1password.com | npx wrangler secret put SITE_KEK --env staging
print -n "you@example.com" | npx wrangler secret put SIGNUP_ALLOWLIST --env staging
```

### 6. Deploy

```bash
cd /Users/ziad/www/bugzap
./utils/deploy/stage.sh
```

## First sign-in

Mail is in `console` mode, so the sign-in link is written to the Worker's log. Start a tail in one terminal:

```bash
cd /Users/ziad/www/bugzap
npx wrangler tail bugzap-staging
```

Open `/login` on the URL the deploy printed, enter the allowlisted address, and open the link the tail prints. Then create a site for Routeloop staging with its origin, and copy the signing secret it shows once.

## Checks after a first deploy

- `/healthz` answers `ok`. The script does not check this itself.
- `/v1/bugzap.js` loads, with `Access-Control-Allow-Origin: *`.
- Signing in works over HTTPS; this is the first time the `__Host-bz_session` cookie is used for real.
- A report from the embedding site appears in the inbox with its screenshot, and Open on page draws its pin.
- The hourly cron trigger shows under the Worker's Triggers in the Cloudflare dashboard, and a `sweep` event appears in the log within the hour. The trigger is declared once at the top of `wrangler.jsonc` and inherited by both environments; this is the check that it was.

## Later deploys

Run the script. When a change adds a migration, the script stops and prints the `migrations apply` command for that environment; run it, then run the script again.

## Known gaps on a deployed Worker

- Owners get sign-in links and new-report notices only through the log, until a sending domain exists.
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
