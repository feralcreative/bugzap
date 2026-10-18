// The rules, asserted as tables.
//
// Ported from Routeloop's test/feedback-policy.test.ts. Its areas, wants and
// moderation tests went with the features; visibility and titles are the same rules.
import { describe, expect, it } from 'vitest'
import {
  isKind,
  isState,
  isStatus,
  KIND_META,
  KINDS,
  STATES,
  STATUSES,
  TITLE_MAX,
  titleFrom,
  type ReportAccess,
  type Viewer,
  visibleTo,
} from '../../src/core/policy'

const report = (over: Partial<ReportAccess> = {}): ReportAccess => ({
  reporterId: 1,
  state: 'pending',
  ...over,
})
const owner: Viewer = { kind: 'owner' }
const author: Viewer = { kind: 'reporter', reporterId: 1 }
const stranger: Viewer = { kind: 'reporter', reporterId: 2 }

describe('visibleTo', () => {
  it('shows a published report to another reporter on the site', () => {
    expect(visibleTo(report({ state: 'published' }), stranger)).toBe(true)
  })

  it('shows the reporter their own report in every state', () => {
    for (const state of STATES) expect(visibleTo(report({ state }), author), state).toBe(true)
  })

  it('shows the owner everything in every state', () => {
    for (const state of STATES) expect(visibleTo(report({ state }), owner), state).toBe(true)
  })

  // The private-bug rule. Nothing publishes a report by default, so a bug filed on a
  // client's staging site is seen by the client who filed it and the owner, and no one else.
  it('hides every unpublished state from another reporter', () => {
    for (const state of STATES.filter((s) => s !== 'published')) {
      expect(visibleTo(report({ state }), stranger), state).toBe(false)
    }
  })
})

describe('the enums', () => {
  it('guard functions accept every member and nothing else', () => {
    for (const k of KINDS) expect(isKind(k)).toBe(true)
    for (const s of STATES) expect(isState(s)).toBe(true)
    for (const s of STATUSES) expect(isStatus(s)).toBe(true)
    for (const junk of ['', 'BUG', 'ticket', null, undefined, 3, {}]) {
      expect(isKind(junk)).toBe(false)
      expect(isState(junk)).toBe(false)
      expect(isStatus(junk)).toBe(false)
    }
  })

  it('gives every kind a label and a prompt', () => {
    expect(Object.keys(KIND_META)).toEqual([...KINDS])
    for (const k of KINDS) {
      expect(KIND_META[k].label.trim(), k).not.toBe('')
      expect(KIND_META[k].prompt.trim(), k).not.toBe('')
    }
  })
})

describe('titleFrom', () => {
  it('takes the first sentence and drops its period', () => {
    expect(titleFrom('The map went white. It happened after I hit save.')).toBe('The map went white')
  })

  it('keeps a question mark, which carries meaning', () => {
    expect(titleFrom('Where did my route 3 go? It was there yesterday.')).toBe('Where did my route 3 go?')
  })

  it('keeps an exclamation mark', () => {
    expect(titleFrom('It lost everything! Two hours of planning.')).toBe('It lost everything!')
  })

  // The common shape: people write one run-on line with no punctuation at all.
  it('returns a short unpunctuated body whole', () => {
    expect(titleFrom('map went white when I hit save')).toBe('map went white when I hit save')
  })

  it('cuts a long unpunctuated body at a word boundary', () => {
    const body =
      'I was planning a three route ride through the Cascades and the whole thing disappeared when I tapped save on the second route'
    const out = titleFrom(body)
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(out.endsWith('…')).toBe(true)
    // A word boundary, not a chopped word.
    expect(body.startsWith(out.slice(0, -1))).toBe(true)
    expect(out).not.toMatch(/\s…$/)
  })

  // No boundary to find, so it is cut hard rather than returned whole — a title
  // longer than the budget defeats the point of having one.
  it('hard-cuts a single word longer than the budget', () => {
    const out = titleFrom('a'.repeat(200))
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(out.endsWith('…')).toBe(true)
  })

  it('ignores a sentence break that lands past the budget', () => {
    const body = `${'word '.repeat(30)}. and then more`
    const out = titleFrom(body)
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX)
  })

  it('flattens leading whitespace and newlines', () => {
    expect(titleFrom('\n\n   the map   went\n white  ')).toBe('the map went white')
  })

  it('is total: empty and whitespace-only bodies return a string', () => {
    expect(titleFrom('')).toBe('')
    expect(titleFrom('   \n\t ')).toBe('')
  })

  it('handles the column maximum without exceeding the title budget', () => {
    expect(titleFrom('x'.repeat(4000)).length).toBeLessThanOrEqual(TITLE_MAX)
  })

  it('is deterministic', () => {
    const body = 'The map went white. Twice.'
    expect(titleFrom(body)).toBe(titleFrom(body))
  })
})
