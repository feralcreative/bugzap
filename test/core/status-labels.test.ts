// The reporter-facing copy, pinned to the enum.
//
// Ported from Routeloop's test/feedback-status-labels.test.ts. It exists for one
// failure: adding a status to STATUSES, shipping it, and rendering the raw value to a
// reporter. "Your report is in_progress" is the kind of thing that gets noticed by
// the person it was written to, not by us.
//
// The second half is the vocabulary ban. Bugzap's reporters are often a site owner's
// clients, so "invalid" and "user error" cost the owner a client, not just a user.
import { describe, expect, it } from 'vitest'
import { BANNED_WORDS, KIND_META, KINDS, STATUS_META, STATUSES, statusLabel } from '../../src/core/policy'

describe('STATUS_META', () => {
  it('covers every status in the enum', () => {
    for (const status of STATUSES) {
      expect(STATUS_META[status], `no copy for status "${status}"`).toBeDefined()
    }
  })

  it('has no copy for a status that is not in the enum', () => {
    const known = new Set<string>(STATUSES)
    for (const key of Object.keys(STATUS_META)) {
      expect(known.has(key), `STATUS_META has "${key}" but the enum does not`).toBe(true)
    }
  })

  it('gives every status a non-empty label and sub-line', () => {
    for (const status of STATUSES) {
      const meta = STATUS_META[status]
      expect(meta.label.trim().length, `empty label for "${status}"`).toBeGreaterThan(0)
      expect(meta.sub.trim().length, `empty sub-line for "${status}"`).toBeGreaterThan(0)
    }
  })

  // A label that is a sentence is a label that wraps to three lines on a phone.
  it('keeps labels short enough to render on one line', () => {
    for (const status of STATUSES) {
      expect(statusLabel(status, 'bug').length, `label too long for "${status}"`).toBeLessThanOrEqual(40)
    }
  })

  it('never renders the raw enum value as its own label', () => {
    for (const status of STATUSES) {
      for (const kind of KINDS) {
        expect(statusLabel(status, kind)).not.toBe(status)
      }
    }
  })
})

describe('statusLabel', () => {
  // The one status whose news genuinely differs by kind: a bug is fixed, an idea is
  // built, a question is answered. Telling someone their question was "fixed" reads
  // as a machine talking.
  it('says fixed for a bug, built for an idea, and answered for a question', () => {
    expect(statusLabel('done', 'bug')).toBe('Fixed')
    expect(statusLabel('done', 'idea')).toBe('Built')
    expect(statusLabel('done', 'question')).toBe('Answered')
  })

  it('falls back to the shared label when a kind has no override', () => {
    for (const kind of KINDS) {
      expect(statusLabel('in_progress', kind)).toBe('Being worked on')
    }
  })

  it('returns a string for every status and kind pair', () => {
    for (const status of STATUSES) {
      for (const kind of KINDS) {
        expect(typeof statusLabel(status, kind)).toBe('string')
      }
    }
  })
})

describe('the vocabulary ban', () => {
  // Assembled from every string a reporter can read out of the policy module. If a
  // new copy table is added there, add it here too.
  function reporterFacingStrings(): { where: string; text: string }[] {
    const out: { where: string; text: string }[] = []
    for (const status of STATUSES) {
      const meta = STATUS_META[status]
      out.push({ where: `STATUS_META.${status}.label`, text: meta.label })
      out.push({ where: `STATUS_META.${status}.sub`, text: meta.sub })
      for (const [kind, label] of Object.entries(meta.labelByKind ?? {})) {
        out.push({
          where: `STATUS_META.${status}.labelByKind.${kind}`,
          text: label,
        })
      }
    }
    for (const kind of KINDS) {
      const meta = KIND_META[kind]
      out.push({ where: `KIND_META.${kind}.label`, text: meta.label })
      out.push({ where: `KIND_META.${kind}.prompt`, text: meta.prompt })
    }
    return out
  }

  // Matched on word boundaries, never as substrings. The ban is on the jargon
  // TOKEN: "repro" is banned, "We reproduced it" is plain English and is exactly
  // what we want a reporter to read. A naive includes() fails that sentence, and
  // would fail "several" on "sev" too.
  function usesBannedWord(text: string): string | null {
    const flat = text.toLowerCase().replace(/[‘’]/g, "'")
    for (const word of BANNED_WORDS) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`\\b${escaped}\\b`).test(flat)) return word
    }
    return null
  }

  it('holds across every reporter-facing string in the policy module', () => {
    for (const { where, text } of reporterFacingStrings()) {
      expect(usesBannedWord(text), `banned word in ${where}: "${text}"`).toBe(null)
    }
  })

  it('matches the token and not a word that merely contains it', () => {
    expect(usesBannedWord('We reproduced it. It is ours to fix.')).toBe(null)
    expect(usesBannedWord('There are several reports of this')).toBe(null)
    expect(usesBannedWord('No repro on our side')).toBe('repro')
    expect(usesBannedWord('Moved to the backlog')).toBe('backlog')
    expect(usesBannedWord('That is user error')).toBe('user error')
  })

  it('bans the two that lose a reporter permanently, and the word for what this is not', () => {
    expect(BANNED_WORDS).toContain('invalid')
    expect(BANNED_WORDS).toContain('user error')
    expect(BANNED_WORDS).toContain('ticket')
  })

  it('is lowercase throughout, since matching is case-folded', () => {
    for (const word of BANNED_WORDS) {
      expect(word).toBe(word.toLowerCase())
    }
  })
})
