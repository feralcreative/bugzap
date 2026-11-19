import { GUEST_SUBJECT_PREFIX, isGuestId, isGuestSubject } from '../core/guest'
import { base64UrlEncode, verifyIdentity } from '../core/identity'
import { decryptSiteSecret } from './crypto'
import type { IngestSite } from './db/scoped'
import { IngestError } from './ingest/body'

/** Who a request is from, however that was established. */
export type Reporter = { sub: string; email?: string; name?: string; guest: boolean }

export async function siteIdentity(env: Env, site: IngestSite, token: unknown, now: number) {
  const secrets = [await decryptSiteSecret(site.secret_cipher, env.SITE_KEK, site.public_key)]
  if (site.previous_secret_cipher && (site.previous_secret_expires_at ?? 0) > now)
    secrets.push(await decryptSiteSecret(site.previous_secret_cipher, env.SITE_KEK, site.public_key))
  const result = await verifyIdentity(token, secrets, now)
  // A host cannot sign its way into the guest namespace, so one guest's reports
  // can never be claimed by a token, even a genuine one.
  if (!result.ok || isGuestSubject(result.claims.sub))
    throw new IngestError(401, 'invalid_identity', 'Your identity token is invalid or expired.')
  return result.claims
}

/** The stored subject for a guest id: a hash, so the database never holds the
 *  value that reads a guest's pins. */
export async function guestSubject(guest: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(guest))
  return GUEST_SUBJECT_PREFIX + base64UrlEncode(new Uint8Array(digest))
}

/**
 * The reporter behind a request. A signed token is honoured on every site. A
 * guest id is honoured only where the owner has left the site open to guests;
 * elsewhere it is the same refusal as no identity at all.
 */
export async function reporterFor(
  env: Env,
  site: IngestSite,
  input: { identity?: unknown; guest?: unknown; reporter?: { name?: string; email?: string } },
  now: number,
): Promise<Reporter> {
  if (input.identity !== undefined && input.identity !== null && input.identity !== '')
    return { ...(await siteIdentity(env, site, input.identity, now)), guest: false }
  if (site.identity_mode !== 'guest')
    throw new IngestError(401, 'identity_required', 'This site takes reports only from signed-in users.')
  if (!isGuestId(input.guest)) throw new IngestError(401, 'invalid_identity', 'A reporter id is required.')
  return {
    sub: await guestSubject(input.guest),
    ...(input.reporter?.email && { email: input.reporter.email }),
    ...(input.reporter?.name && { name: input.reporter.name }),
    guest: true,
  }
}
