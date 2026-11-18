// Who may sign in. SIGNUP_ALLOWLIST is a comma- or whitespace-separated list of
// full addresses (`owner@example.com`) and whole domains (`@example.com`). An
// empty or missing list admits nobody: the dashboard fails closed.

export const EMAIL_MAX = 254

/** Trimmed and lowercased, or null when it is not a plain `local@domain` address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  if (email.length > EMAIL_MAX || !/^[^\s@<>(),;:"\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) return null
  return email
}

export function isAllowed(email: string, allowlist: string | undefined): boolean {
  const domain = email.slice(email.lastIndexOf('@'))
  return (allowlist ?? '')
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((entry) => (entry.startsWith('@') ? entry === domain : entry === email))
}
