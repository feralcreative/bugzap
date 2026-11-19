// A guest reporter: someone on a site that asks nothing of its visitors.
//
// The widget makes one random id per browser per site and keeps it in that
// browser's storage. It is what lets a guest see their own pins again, and it is
// all that does: whoever holds it can read that one guest's reports. So it is
// long, random, never shown, and stored on the server only as a hash.
//
// A guest's name and email are whatever they typed. Nothing verifies them, and
// the dashboard says so wherever it shows them.

export const GUEST_SUBJECT_PREFIX = 'guest:'
export const REPORTER_NAME_MAX = 100
export const REPORTER_EMAIL_MAX = 254

/** 32 random bytes as base64url: the same shape as every other bearer value here. */
export function isGuestId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw)
}

export const isGuestSubject = (subject: string) => subject.startsWith(GUEST_SUBJECT_PREFIX)

/** Loose on purpose: this is a contact detail someone typed, not a login. */
export function isPlainEmail(raw: string): boolean {
  return raw.length <= REPORTER_EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)
}
