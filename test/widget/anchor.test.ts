import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAnchor } from '../../src/core/anchor'
import { canPin, captureAnchor } from '../../src/widget/anchor/capture'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function add(tag: string, parent: Element = document.body) {
  const node = document.createElement(tag)
  parent.append(node)
  return node
}

describe('DOM anchor capture', () => {
  it('captures stable ancestry, a selector, document coordinates and fractional offsets', () => {
    const card = add('section')
    card.setAttribute('data-bugzap-id', 'editor')
    const first = add('button', card)
    first.textContent = 'Other'
    const target = add('button', card)
    target.textContent = '  Save   changes '
    target.setAttribute('aria-label', 'Save the draft')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 100, 40))
    vi.spyOn(window, 'scrollX', 'get').mockReturnValue(100)
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(200)
    const anchor = captureAnchor(target, 35, 30, window)!
    expect(parseAnchor(anchor)).toEqual(anchor)
    expect(anchor).toMatchObject({
      attrs: [{ depth: 1, name: 'data-bugzap-id', value: 'editor' }],
      text: 'Save changes',
      label: 'Save the draft',
      rect: { x: 110, y: 220, w: 100, h: 40 },
      page: { x: 135, y: 230 },
      offset: { fx: 0.25, fy: 0.25 },
    })
    expect(document.querySelector(anchor.selector)).toBe(target)
  })

  it('filters generated ids and ambiguous attributes while retaining a usable full path', () => {
    const first = add('button')
    first.setAttribute('data-testid', 'duplicate')
    const target = add('button')
    target.id = 'react-select-12345'
    target.setAttribute('data-testid', 'duplicate')
    const anchor = captureAnchor(target, 0, 0, window)!
    expect(anchor.attrs.some((a) => a.name === 'id')).toBe(false)
    expect(document.querySelector(anchor.selector)).toBe(target)
  })

  it('escapes quotes and backslashes in stable attributes without selector injection', () => {
    const target = add('button')
    target.setAttribute('data-bugzap-id', 'save"\\] #private')
    const anchor = captureAnchor(target, 0, 0, window)!
    expect(document.querySelector(anchor.selector)).toBe(target)
  })

  it('excludes masked descendants, form values, editable content and scripts from anchor text', () => {
    const card = add('section')
    card.append('Public heading ')
    const input = add('input', card) as HTMLInputElement
    input.value = 'secret-input'
    const textarea = add('textarea', card)
    textarea.textContent = 'secret-textarea'
    const masked = add('div', card)
    masked.setAttribute('data-bugzap-mask', '')
    masked.textContent = 'secret-masked'
    const editable = add('div', card)
    editable.setAttribute('contenteditable', 'true')
    editable.textContent = 'secret-editable'
    const script = add('script', card)
    script.textContent = 'secret-script'
    expect(captureAnchor(card, 0, 0, window)?.text).toBe('Public heading')
    for (const node of [input, textarea, masked, editable]) {
      const anchor = captureAnchor(node, 0, 0, window)!
      expect(anchor.text).toBeUndefined()
      expect(anchor.label).toBeUndefined()
    }
  })

  it('refuses ignored, detached and widget-owned elements, including across shadow roots', () => {
    const ignored = add('div')
    ignored.setAttribute('data-bugzap-ignore', '')
    const target = add('button', ignored)
    expect(canPin(target)).toBe(false)
    expect(captureAnchor(target, 0, 0, window)).toBeNull()
    const shadow = ignored.attachShadow({ mode: 'open' })
    const inner = document.createElement('button')
    shadow.append(inner)
    expect(canPin(inner)).toBe(false)
    const widget = add('div')
    widget.setAttribute('data-bugzap-root', '')
    expect(canPin(add('button', widget))).toBe(false)
    expect(canPin(document.createElement('button'))).toBe(false)
  })

  it('marks iframe anchors without inspecting their document', () => {
    const frame = document.createElement('iframe')
    frame.srcdoc = '<p>Embedded content</p>'
    document.body.append(frame)
    expect(captureAnchor(frame, 10, 10, window)?.frame).toBe('iframe')
  })
})
