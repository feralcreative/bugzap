import { verifyIdentity } from '../core/identity'
import { decryptSiteSecret } from './crypto'
import type { IngestSite } from './db/scoped'
import { IngestError } from './ingest/body'

export async function siteIdentity(env: Env, site: IngestSite, token: unknown, now: number) {
  const secrets = [await decryptSiteSecret(site.secret_cipher, env.SITE_KEK, site.public_key)]
  if (site.previous_secret_cipher && (site.previous_secret_expires_at ?? 0) > now)
    secrets.push(await decryptSiteSecret(site.previous_secret_cipher, env.SITE_KEK, site.public_key))
  const result = await verifyIdentity(token, secrets, now)
  if (!result.ok) throw new IngestError(401, 'invalid_identity', 'Your identity token is invalid or expired.')
  return result.claims
}
