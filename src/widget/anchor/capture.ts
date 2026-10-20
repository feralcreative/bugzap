import {
  type Anchor,
  type AnchorAttr,
  ANCHOR_ATTRS_MAX,
  DEFAULT_STABLE_ATTRS,
  isGeneratedId,
  normalizeText,
  TEXT_MAX,
} from '../../core/anchor'

function parent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement
  const root = element.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}

function hasAncestor(element: Element, selector: string): boolean {
  for (let at: Element | null = element; at; at = parent(at)) if (at.matches(selector)) return true
  return false
}

export function canPin(element: Element): boolean {
  return element.isConnected && !hasAncestor(element, '[data-bugzap-ignore], [data-bugzap-root]')
}

export function quoteAttribute(value: string): string {
  return Array.from(value, (c) => {
    const code = c.charCodeAt(0)
    return code < 32 || code === 127 || c === '"' || c === '\\' ? `\\${code.toString(16)} ` : c
  }).join('')
}

function step(element: Element): string {
  const tag = element.localName
  const siblings = element.parentElement
    ? Array.from(element.parentElement.children).filter((s) => s.localName === tag)
    : [element]
  return `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`
}

const SENSITIVE = 'input, textarea, select, [contenteditable], [data-bugzap-mask]'
export function visibleText(element: Element): string {
  if (hasAncestor(element, SENSITIVE)) return ''
  const walker = element.ownerDocument.createTreeWalker(element, 4 /* SHOW_TEXT */)
  let text = ''
  let node: Node | null = walker.nextNode()
  let inspected = 0
  while (node && inspected++ < 512 && text.length < TEXT_MAX * 2) {
    const container = node.parentElement
    if (container && !hasAncestor(container, `${SENSITIVE}, [data-bugzap-ignore], script, style`))
      text += `${node.textContent ?? ''} `
    node = walker.nextNode()
  }
  return normalizeText(text)
}

export function anchorLabel(element: Element): string {
  return hasAncestor(element, SENSITIVE)
    ? ''
    : normalizeText(['aria-label', 'alt', 'title', 'name'].map((a) => element.getAttribute(a)).find(Boolean) ?? '', 120)
}

/** Capture the document-visible element. Cross-origin iframe contents cannot be
 *  inspected; clicking its border pins its iframe box, with frame='iframe'. */
export function captureAnchor(element: Element, clientX: number, clientY: number, win: Window): Anchor | null {
  if (!canPin(element)) return null
  const attrs: AnchorAttr[] = []
  const path: string[] = []
  let selector = ''
  let depth = 0
  for (let at: Element | null = element; at && depth <= 32; at = at.parentElement, depth++) {
    let prefix = ''
    for (const name of DEFAULT_STABLE_ATTRS) {
      const value = at.getAttribute(name)
      if (!value || value.length > 200 || (name === 'id' && isGeneratedId(value))) continue
      if (attrs.length < ANCHOR_ATTRS_MAX) attrs.push({ depth, name, value })
      const match = `[${name}="${quoteAttribute(value)}"]`
      if (!prefix && at.ownerDocument.querySelectorAll(match).length === 1) prefix = match
    }
    if (!selector && prefix) selector = [prefix, ...path].join(' > ')
    path.unshift(step(at))
  }
  if (!selector) selector = path.join(' > ')
  if (selector.length > 512) selector = '' // Attributes and the point remain usable.
  const rect = element.getBoundingClientRect()
  const clamp = (n: number) => Math.max(0, Math.min(1, n))
  const label = anchorLabel(element)
  const text = visibleText(element)
  return {
    v: 1,
    attrs,
    selector,
    tag: element.localName.toLowerCase(),
    ...(text && { text }),
    ...(label && { label }),
    rect: { x: rect.left + win.scrollX, y: rect.top + win.scrollY, w: rect.width, h: rect.height },
    offset: {
      fx: rect.width ? clamp((clientX - rect.left) / rect.width) : 0.5,
      fy: rect.height ? clamp((clientY - rect.top) / rect.height) : 0.5,
    },
    page: { x: clientX + win.scrollX, y: clientY + win.scrollY },
    viewport: {
      w: win.innerWidth,
      h: win.innerHeight,
      dpr: win.devicePixelRatio || 1,
      sx: win.scrollX,
      sy: win.scrollY,
    },
    ...(element.localName === 'iframe' && { frame: 'iframe' }),
  }
}
