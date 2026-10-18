// What a report is, who may see it, and what every state is called in front of a
// reporter, as pure functions.
//
// Ported from Routeloop's src/feedback/policy.ts. This file is the RULE, asserted as
// tables in test/core/policy.test.ts and test/core/status-labels.test.ts; the Worker
// holds the queries. Everything here is a function of its arguments, which is what
// lets the tests import it with no database.
//
// Routeloop's areas, frequencies, impacts and wants are not carried over: they were
// questions about one app's screens, and Bugzap runs on any site. The pin answers
// "where" better than an area chip did.

/** Reports one reporter may submit per hour on one site. Generous: the cost of
 *  blocking a real bug report is far higher than the cost of storing a few junk rows. */
export const SUBMIT_LIMIT = 10

/** The one required field. */
export const BODY_MIN = 3
export const BODY_MAX = 4000

/** Files a reporter may attach on top of the automatic screenshot. */
export const UPLOAD_MAX = 2

// --- The enums ---------------------------------------------------------------
//
// Declared here as the single source, because D1 has no enum type: the migration's
// CHECK constraints and these arrays must agree, and test/worker asserts that they do.

export const KINDS = ['bug', 'idea', 'question'] as const
export type ReportKind = (typeof KINDS)[number]

/**
 * The owner's gate: who can see a report at all. Separate from `status` on purpose,
 * as in Routeloop. A report's state is never shown to its reporter; its status is.
 */
export const STATES = ['pending', 'published', 'archived', 'spam'] as const
export type ReportState = (typeof STATES)[number]

/** What the reporter sees: where their report has got to. */
export const STATUSES = ['new', 'confirmed', 'planned', 'in_progress', 'done', 'not_doing', 'no_repro'] as const
export type ReportStatus = (typeof STATUSES)[number]

export const isKind = (v: unknown): v is ReportKind => typeof v === 'string' && (KINDS as readonly string[]).includes(v)
export const isState = (v: unknown): v is ReportState =>
  typeof v === 'string' && (STATES as readonly string[]).includes(v)
export const isStatus = (v: unknown): v is ReportStatus =>
  typeof v === 'string' && (STATUSES as readonly string[]).includes(v)

// --- Kinds -------------------------------------------------------------------

export type KindMeta = {
  /** The choice in the composer. */
  label: string
  /** The composer's placeholder once this kind is chosen. */
  prompt: string
}

export const KIND_META: Record<ReportKind, KindMeta> = {
  bug: { label: 'Something’s wrong', prompt: 'What went wrong here?' },
  idea: { label: 'An idea', prompt: 'What would make this better?' },
  question: { label: 'A question', prompt: 'What do you want to know?' },
}

// --- Status copy -------------------------------------------------------------

/**
 * Every reporter-facing status, in the words a reporter reads.
 *
 * Every status is a sentence about what is TRUE, not a workflow state. A table
 * rather than a switch in a view, so test/core/status-labels.test.ts can assert it
 * covers STATUSES exhaustively: adding a status without copy fails the build rather
 * than rendering `in_progress` to someone.
 */
export type StatusMeta = {
  label: string
  /** Kind-specific override: 'done' is "Fixed" for a bug and "Built" for an idea,
   *  because those are different pieces of news. */
  labelByKind?: Partial<Record<ReportKind, string>>
  sub: string
  /** Whether this status means we are done with it, for grouping in the dashboard. */
  closed: boolean
}

export const STATUS_META: Record<ReportStatus, StatusMeta> = {
  new: { label: 'Received', sub: 'Seen, not looked into yet', closed: false },
  confirmed: {
    label: 'Confirmed',
    sub: 'We can see it too, and it’s ours to fix',
    closed: false,
  },
  planned: {
    label: 'Planned',
    sub: 'Not started yet, but it’s happening',
    closed: false,
  },
  in_progress: {
    label: 'Being worked on',
    sub: 'Someone is on it right now',
    closed: false,
  },
  done: {
    label: 'Fixed',
    labelByKind: { idea: 'Built', question: 'Answered' },
    sub: 'Take a look',
    closed: true,
  },
  not_doing: {
    label: 'Not doing this one',
    sub: 'Always paired with a one-line reason',
    closed: true,
  },
  no_repro: {
    label: 'Couldn’t make it happen',
    sub: 'Tell us more if you see it again',
    closed: true,
  },
}

/** The label for this status as this kind of report. */
export function statusLabel(status: ReportStatus, kind: ReportKind): string {
  const meta = STATUS_META[status]
  return meta.labelByKind?.[kind] ?? meta.label
}

/**
 * Words that must never appear on a reporter-facing surface.
 *
 * Every one of them is either jargon a reporter does not have, or a judgment about
 * the reporter rather than the report. Bugzap's reporters are often a site owner's
 * clients, which makes "invalid" and "user error" worse here, not better.
 *
 * Asserted against STATUS_META and KIND_META by test/core/status-labels.test.ts. It
 * cannot police a view, so this list is also the review checklist for one.
 */
export const BANNED_WORDS: readonly string[] = [
  'ticket',
  'triaged',
  'backlog',
  'won’t fix',
  'wontfix',
  'p0',
  'p1',
  'p2',
  'sev',
  'repro',
  'epic',
  'sprint',
  'deprioritized',
  'invalid',
  'user error',
]

// --- Visibility --------------------------------------------------------------

/** The subset of a report these rules need, so they stay callable from a test. */
export type ReportAccess = {
  reporterId: number
  state: ReportState
}

/** Who is looking. An owner is a dashboard user who belongs to the site's account;
 *  a reporter is a host site's user, identified by their signed token. */
export type Viewer = { kind: 'owner' } | { kind: 'reporter'; reporterId: number }

/**
 * Whether this viewer may see this report at all.
 *
 * **This function is the private-bug rule.** A report is invisible to everyone but
 * its reporter and the site's owners until it is `published`, and nothing publishes
 * a report by default.
 *
 * A report the viewer may not see must 404, never 403: a 403 confirms the report
 * exists, which leaks that someone reported something.
 */
export function visibleTo(report: ReportAccess, viewer: Viewer): boolean {
  if (viewer.kind === 'owner') return true
  if (report.reporterId === viewer.reporterId) return true
  return report.state === 'published'
}

// --- Titles ------------------------------------------------------------------

/** The readable length in the dashboard's list, not a column limit. */
export const TITLE_MAX = 80

/**
 * A title, derived from the body. **Reporters are never asked for one.**
 *
 * Asking for a title is the most abandonment-prone field on a feedback form: it
 * demands a summary before the person has finished working out what they want to
 * say. The owner can edit it.
 *
 * First sentence, or the first `TITLE_MAX` characters cut at a word boundary. Total:
 * it never throws, because a report must not be lost to a body it could not summarize.
 */
export function titleFrom(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (!flat) return ''

  // The first sentence, if one ends inside the budget. A decimal or an abbreviation
  // would split early here; acceptable for a list label and not worth a tokenizer.
  const end = flat.search(/[.!?](\s|$)/)
  if (end !== -1 && end + 1 <= TITLE_MAX) {
    // The '.' is dropped and '?'/'!' are kept: a trailing period on a label reads
    // like a typo, a question mark carries meaning.
    const punct = flat[end]
    return flat.slice(0, end) + (punct === '.' ? '' : punct)
  }

  if (flat.length <= TITLE_MAX) return flat

  // Cut at a word boundary, leaving room for the ellipsis inside the budget. A single
  // word longer than the budget has no boundary to find, so it is cut hard.
  const cut = flat.slice(0, TITLE_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`
}
