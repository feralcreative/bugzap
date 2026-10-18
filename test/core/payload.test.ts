// The report as it arrives. Strict on structure, lenient on diagnostics.
import { describe, expect, it } from 'vitest'
import { parseReportPayload } from '../../src/core/payload'

const valid = () => ({
  v: 1,
  site: 'bz_pk_ABCDEFGHIJKLMNOPQRSTUV',
  identity: 'h.p.s',
  kind: 'bug',
  body: '  The save button does nothing.  ',
  page: { url: 'https://example.com/editor?draft=1', title: 'Editor' },
  pin: {
    v: 1,
    attrs: [],
    selector: 'button',
    tag: 'button',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    offset: { fx: 0.5, fy: 0.5 },
    page: { x: 5, y: 5 },
    viewport: { w: 1280, h: 800, dpr: 1, sx: 0, sy: 0 },
  },
  screenshot: { mode: 'auto' },
  diagnostics: { anything: 'goes here' },
})

describe('parseReportPayload', () => {
  it('accepts a well-formed report and trims the body', () => {
    const out = parseReportPayload(valid())
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.value.body).toBe('The save button does nothing.')
      expect(out.value.pin?.tag).toBe('button')
    }
  })

  // A keyboard or screen-reader user reports the page as a whole.
  it('accepts a report with no pin', () => {
    const out = parseReportPayload({ ...valid(), pin: null })
    expect(out.ok && out.value.pin).toBeNull()
  })

  it('passes diagnostics through untouched for the redactor to deal with', () => {
    const out = parseReportPayload({
      ...valid(),
      diagnostics: 'not even an object',
    })
    expect(out.ok && out.value.diagnostics).toBe('not even an object')
  })

  it('refuses each broken required field with a reason', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['version', { v: 2 }],
      ['site', { site: 'bz_sk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' }],
      ['identity', { identity: '' }],
      ['kind', { kind: 'ticket' }],
      ['body short', { body: '  a  ' }],
      ['body long', { body: 'x'.repeat(4001) }],
      ['page', { page: { url: 'javascript:alert(1)' } }],
      ['pin', { pin: { v: 1 } }],
      ['screenshot', { screenshot: { mode: 'magic' } }],
    ]
    for (const [label, patch] of cases) {
      const out = parseReportPayload({ ...valid(), ...patch })
      expect(out.ok, label).toBe(false)
      if (!out.ok) expect(out.error, label).toBeTruthy()
    }
  })

  it('refuses non-objects', () => {
    for (const junk of [null, undefined, 'x', [], 1]) expect(parseReportPayload(junk).ok).toBe(false)
  })
})
