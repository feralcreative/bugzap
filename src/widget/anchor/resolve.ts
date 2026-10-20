import {
  type Anchor,
  type Candidate,
  approximatePoint,
  DEFAULT_STABLE_ATTRS,
  isGeneratedId,
  pickBest,
  pinPoint,
  scoreCandidate,
} from '../../core/anchor'
import { safe } from '../guard'
import { anchorLabel, canPin, quoteAttribute, visibleText } from './capture'

export type Resolution = {
  element: Element | null
  x: number
  y: number
  approximate: boolean
  strategy: 'attribute' | 'scoped' | 'selector' | 'fuzzy' | 'approximate'
}
export type ResolveCache = Map<string, { element: Element; candidate: Candidate }[]>
const query = (root: Document | Element, selector: string) =>
  safe(() => Array.from(root.querySelectorAll(selector)), [])
const attribute = (name: string, value: string) => `[${name}="${quoteAttribute(value)}"]`

function eligible(element: Element, anchor: Anchor): boolean {
  if (!canPin(element) || element.localName !== anchor.tag || element.closest('[hidden]')) return false
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  if (style?.visibility === 'hidden' || style?.display === 'none') return false
  // An authoritative own ID cannot silently jump to the next positional sibling
  // when its element is removed, even if that sibling has similar text.
  const own = anchor.attrs.find((a) => a.depth === 0)
  return !own || element.getAttribute(own.name) === own.value
}

function description(element: Element, win: Window): Candidate {
  const rect = element.getBoundingClientRect()
  const attrs = DEFAULT_STABLE_ATTRS.flatMap((name) => {
    const value = element.getAttribute(name)
    return value && !(name === 'id' && isGeneratedId(value)) ? [{ name, value }] : []
  })
  return {
    tag: element.localName,
    text: visibleText(element),
    label: anchorLabel(element),
    attrs,
    rect: { x: rect.left + win.scrollX, y: rect.top + win.scrollY, w: rect.width, h: rect.height },
  }
}

function sameMeaning(anchor: Anchor, element: Element): boolean {
  if (anchor.attrs.some((a) => a.depth === 0)) return true
  if (anchor.text && visibleText(element) !== anchor.text) return false
  if (anchor.label && anchorLabel(element) !== anchor.label) return false
  return !!(anchor.text || anchor.label)
}

export function locate(
  anchor: Anchor,
  element: Element | null,
  strategy: Resolution['strategy'],
  win: Window,
): Resolution {
  if (element?.isConnected && eligible(element, anchor)) {
    const rect = element.getBoundingClientRect()
    const point = pinPoint(
      { x: rect.left + win.scrollX, y: rect.top + win.scrollY, w: rect.width, h: rect.height },
      anchor.offset,
    )
    return { ...point, element, approximate: false, strategy }
  }
  return { ...approximatePoint(anchor, win.innerWidth), element: null, approximate: true, strategy: 'approximate' }
}

export function resolveAnchor(anchor: Anchor, win: Window, cache: ResolveCache = new Map()): Resolution {
  const doc = win.document
  const unique = (elements: Element[]) => {
    const valid = elements.filter((el) => eligible(el, anchor))
    return valid.length === 1 ? valid[0]! : null
  }
  for (const attr of anchor.attrs.filter((a) => a.depth === 0)) {
    const found = unique(query(doc, attribute(attr.name, attr.value)))
    if (found) return locate(anchor, found, 'attribute', win)
  }
  for (const attr of anchor.attrs.filter((a) => a.depth > 0)) {
    const prefix = attribute(attr.name, attr.value)
    if (!anchor.selector.startsWith(prefix + ' > ')) continue
    const parents = query(doc, prefix).filter(canPin)
    if (parents.length !== 1) continue
    const found = unique(query(parents[0]!, anchor.selector.slice(prefix.length + 3)))
    if (found && sameMeaning(anchor, found)) return locate(anchor, found, 'scoped', win)
  }
  if (anchor.selector) {
    const found = unique(query(doc, anchor.selector))
    if (found && sameMeaning(anchor, found)) return locate(anchor, found, 'selector', win)
  }
  let entries = cache.get(anchor.tag)
  if (!entries) {
    entries = query(doc, anchor.tag)
      .filter((el) => canPin(el) && !el.closest('[hidden]'))
      .slice(0, 500)
      .map((element) => ({ element, candidate: description(element, win) }))
    cache.set(anchor.tag, entries)
  }
  if (!anchor.attrs.some((a) => a.depth === 0) && !anchor.text && !anchor.label)
    return locate(anchor, null, 'approximate', win)
  const choices = entries.filter(({ element }) => eligible(element, anchor))
  const scale = win.innerWidth / anchor.viewport.w
  const candidates = choices.map((e) => e.candidate)
  const best = pickBest(anchor, candidates, scale)
  if (best) {
    // Similar candidates are not enough evidence to choose one by accident.
    const score = best.score
    const ambiguous = candidates.some(
      (candidate, i) => i !== best.index && scoreCandidate(anchor, candidate, scale) >= score - 0.05,
    )
    if (!ambiguous) return locate(anchor, choices[best.index]!.element, 'fuzzy', win)
  }
  return locate(anchor, null, 'approximate', win)
}
