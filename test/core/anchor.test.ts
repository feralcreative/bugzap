// The pure half of re-anchoring: validation, the generated-id filter, and the scorer.
// The DOM half, and the innerHTML-rebuild scenarios, are in test/widget.
import { describe, expect, it } from 'vitest'
import {
  type Anchor,
  approximatePoint,
  type Candidate,
  FUZZY_THRESHOLD,
  isGeneratedId,
  normalizeText,
  parseAnchor,
  pickBest,
  pinPoint,
  scoreCandidate,
  textSimilarity,
} from '../../src/core/anchor'

const anchor = (over: Partial<Anchor> = {}): Anchor => ({
  v: 1,
  attrs: [{ depth: 0, name: 'data-bugzap-id', value: 'save' }],
  selector: 'main > div:nth-of-type(2) > button:nth-of-type(1)',
  tag: 'button',
  text: 'Save route',
  rect: { x: 100, y: 400, w: 120, h: 40 },
  offset: { fx: 0.5, fy: 0.5 },
  page: { x: 160, y: 420 },
  viewport: { w: 1280, h: 800, dpr: 2, sx: 0, sy: 0 },
  ...over,
})

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  tag: 'button',
  text: 'Save route',
  attrs: [{ name: 'data-bugzap-id', value: 'save' }],
  rect: { x: 100, y: 400, w: 120, h: 40 },
  ...over,
})

describe('isGeneratedId', () => {
  it('keeps ids a person wrote', () => {
    for (const id of ['save', 'main-nav', 'step-2', 'pricing_table', 'h1']) expect(isGeneratedId(id), id).toBe(false)
  })

  // Each of these is different on the next render, so trusting it would point the
  // pin at nothing and push a working fallback down the list.
  it('flags ids a framework generated', () => {
    for (const id of [
      ':r1:',
      '«r3»',
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'a1b2c3d4e5f6a7b8',
      'item-1729000000',
      'ember1234',
      'radix-:R1:',
      'headlessui-menu-button-7',
      '',
    ]) {
      expect(isGeneratedId(id), id).toBe(true)
    }
  })
})

describe('parseAnchor', () => {
  it('round-trips a well-formed anchor', () => {
    expect(parseAnchor(anchor())).toEqual(anchor())
  })

  it('refuses a missing or wrong-typed required field', () => {
    const base = anchor() as unknown as Record<string, unknown>
    for (const key of ['v', 'tag', 'selector', 'rect', 'offset', 'page', 'viewport']) {
      const { [key]: _, ...rest } = base
      expect(parseAnchor(rest), key).toBeNull()
    }
    expect(parseAnchor({ ...base, tag: 'DIV' })).toBeNull()
    expect(parseAnchor({ ...base, tag: '<script>' })).toBeNull()
    expect(parseAnchor({ ...base, rect: { x: 0, y: 0, w: -1, h: 1 } })).toBeNull()
    expect(
      parseAnchor({
        ...base,
        viewport: { w: 0, h: 800, dpr: 1, sx: 0, sy: 0 },
      }),
    ).toBeNull()
    expect(parseAnchor({ ...base, page: { x: Number.NaN, y: 0 } })).toBeNull()
  })

  it('cuts and clamps rather than refusing', () => {
    const out = parseAnchor({
      ...anchor(),
      text: `  ${'word '.repeat(50)}`,
      offset: { fx: 2, fy: -1 },
    })
    expect(out?.text?.length).toBeLessThanOrEqual(80)
    expect(out?.offset).toEqual({ fx: 1, fy: 0 })
  })

  it('drops malformed attrs and caps how many it keeps', () => {
    const attrs = [
      { depth: 0, name: 'Data-Bad', value: 'x' },
      { depth: 0, name: 'id', value: '' },
      ...Array.from({ length: 20 }, (_, i) => ({
        depth: i,
        name: 'data-x',
        value: `v${i}`,
      })),
    ]
    const out = parseAnchor({ ...anchor(), attrs })
    expect(out?.attrs).toHaveLength(8)
    expect(out?.attrs[0]).toEqual({ depth: 0, name: 'data-x', value: 'v0' })
  })

  it('refuses non-objects', () => {
    for (const junk of [null, undefined, 'x', 3, []]) expect(parseAnchor(junk)).toBeNull()
  })
})

describe('textSimilarity', () => {
  it('is 1 for the same text, ignoring case and outer space', () => {
    expect(textSimilarity('Save route', ' save ROUTE ')).toBe(1)
  })

  it('stays high for a small edit and low for different text', () => {
    expect(textSimilarity('Save 3 routes', 'Save 4 routes')).toBeGreaterThan(0.75)
    expect(textSimilarity('Save route', 'Delete account')).toBeLessThan(0.3)
  })
})

describe('scoreCandidate and pickBest', () => {
  it('scores the original element near 1', () => {
    expect(scoreCandidate(anchor(), candidate())).toBeGreaterThan(0.95)
  })

  it('scores zero for another tag, whatever else matches', () => {
    expect(scoreCandidate(anchor(), candidate({ tag: 'a' }))).toBe(0)
  })

  // The innerHTML case: the attribute is gone and the element moved, but the text
  // and size identify it.
  it('still finds an element that lost its attribute and moved a little', () => {
    const moved = candidate({
      attrs: [],
      rect: { x: 110, y: 460, w: 120, h: 40 },
    })
    expect(scoreCandidate(anchor(), moved)).toBeGreaterThanOrEqual(FUZZY_THRESHOLD)
  })

  it('picks the right button out of a row of similar ones', () => {
    const row = [
      candidate({
        text: 'Cancel',
        attrs: [],
        rect: { x: 0, y: 400, w: 90, h: 40 },
      }),
      candidate({
        text: 'Save route',
        attrs: [],
        rect: { x: 100, y: 420, w: 120, h: 40 },
      }),
      candidate({
        text: 'Save as copy',
        attrs: [],
        rect: { x: 230, y: 400, w: 130, h: 40 },
      }),
    ]
    expect(pickBest(anchor(), row)?.index).toBe(1)
  })

  it('returns null rather than a bad guess', () => {
    const unrelated = [
      candidate({
        text: 'Log out',
        attrs: [],
        rect: { x: 1000, y: 3000, w: 60, h: 20 },
      }),
    ]
    expect(pickBest(anchor(), unrelated)).toBeNull()
  })

  // A phone visit to a page pinned on a laptop: the layout narrowed, so horizontal
  // position and width are compared after scaling.
  it('scales horizontal position and width to the current viewport', () => {
    const narrow = candidate({
      attrs: [],
      rect: { x: 30, y: 400, w: 36, h: 40 },
    })
    expect(scoreCandidate(anchor(), narrow, 0.3)).toBeGreaterThan(scoreCandidate(anchor(), narrow, 1))
  })
})

describe('placement', () => {
  it('puts the pin at the same fraction of the element it was dropped on', () => {
    expect(pinPoint({ x: 100, y: 200, w: 200, h: 100 }, { fx: 0.25, fy: 0.5 })).toEqual({ x: 150, y: 250 })
  })

  it('scales the approximate point horizontally only', () => {
    expect(approximatePoint(anchor(), 640)).toEqual({ x: 80, y: 420 })
  })

  it('normalizes text the way capture does', () => {
    expect(normalizeText('  Save\n\t route  ')).toBe('Save route')
  })
})
