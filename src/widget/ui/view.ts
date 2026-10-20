import type { ReportKind } from '../../core/policy'
import { BODY_MAX, statusLabel } from '../../core/policy'
import type { PinPlacement } from '../pins'
import { guard, safe } from '../guard'
import { styles } from './style'

export type Phase = 'idle' | 'pin' | 'compose' | 'success' | 'detail'
export type ViewActions = {
  open: () => void
  close: () => void
  page: () => void
  repin: () => void
  submit: () => Promise<void>
  fail: () => void
  saved: (id: string) => void
}

export function createView(doc: Document, actions: ViewActions, nonce?: string) {
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
    const node = doc.createElement(tag)
    if (text) node.textContent = text
    if (className) node.className = className
    return node
  }
  const button = (text: string, action: () => unknown, className?: string) => {
    const node = element('button', text, className)
    node.type = 'button'
    node.addEventListener('click', guard(action, actions.fail))
    return node
  }
  const host = element('div')
  host.setAttribute('data-bugzap-root', '')
  host.setAttribute('data-bugzap-ignore', '')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = element('style', styles)
  if (nonce) style.nonce = nonce
  const surface = element('div', undefined, 'surface')
  const launcher = button('Feedback', actions.open, 'launcher primary')
  const savedLayer = element('div', undefined, 'saved-pins')
  savedLayer.setAttribute('role', 'group')
  savedLayer.setAttribute('aria-label', 'Your saved reports')
  let pinsVisible = true
  let currentPhase: Phase = 'idle'
  let identified = false
  const savedButtons = new Map<string, HTMLButtonElement>()
  const updateSavedVisibility = () => {
    savedLayer.hidden = !pinsVisible || currentPhase !== 'idle' || !identified
    toggle.hidden = !savedButtons.size || currentPhase !== 'idle' || !identified
    toggle.textContent = pinsVisible ? 'Hide pins' : 'Show pins'
  }
  const toggle = button(
    'Hide pins',
    () => {
      pinsVisible = !pinsVisible
      updateSavedVisibility()
    },
    'pins-toggle',
  )
  const bar = element('div', undefined, 'bar')
  bar.setAttribute('role', 'region')
  bar.setAttribute('aria-label', 'Choose a feedback target')
  const instruction = element('p', 'Click an element to pin your report.')
  const pageButton = button('Report this page', actions.page)
  bar.append(instruction, pageButton, button('Cancel', actions.close))
  const backdrop = element('div', undefined, 'backdrop')
  backdrop.addEventListener('click', guard(actions.close, actions.fail))
  const panel = element('section', undefined, 'panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-labelledby', 'bugzap-heading')
  const heading = element('h2', 'Send feedback')
  heading.id = 'bugzap-heading'
  const form = element('form')
  form.noValidate = true
  form.addEventListener(
    'submit',
    guard((event: SubmitEvent) => {
      event.preventDefault()
      return actions.submit()
    }, actions.fail),
  )
  const target = element('p', undefined, 'target')
  const targetLabel = element('span', 'About this page')
  const repin = button('Change target', actions.repin)
  target.append(targetLabel, repin)
  const kindLabel = element('label', 'Type')
  kindLabel.htmlFor = 'bugzap-kind'
  const kind = element('select')
  kind.id = 'bugzap-kind'
  for (const [value, label] of [
    ['bug', 'Bug'],
    ['idea', 'Idea'],
    ['question', 'Question'],
  ]) {
    const option = element('option', label)
    option.value = value!
    kind.append(option)
  }
  const bodyLabel = element('label', 'What would you like to tell us?')
  bodyLabel.htmlFor = 'bugzap-body'
  const body = element('textarea')
  body.id = 'bugzap-body'
  body.required = true
  body.maxLength = BODY_MAX
  body.placeholder = 'Describe the problem, idea, or question.'
  body.setAttribute('aria-describedby', 'bugzap-error')
  const error = element('p', '', 'error')
  error.id = 'bugzap-error'
  error.setAttribute('role', 'status')
  error.setAttribute('aria-live', 'polite')
  const actionsRow = element('div', undefined, 'actions')
  const cancel = button('Cancel', actions.close)
  const send = button('Send report', () => actions.submit(), 'primary')
  actionsRow.append(cancel, send)
  form.append(target, kindLabel, kind, bodyLabel, body, error, actionsRow)
  const success = element('div')
  success.setAttribute('role', 'status')
  const done = button('Done', actions.close, 'primary')
  success.append(element('p', 'Your report has been sent.'), done)
  const detail = element('div')
  const detailStatus = element('p', undefined, 'target')
  const detailBody = element('p', undefined, 'report-body')
  const detailApproximate = element('p', 'Approximate position—the original element is no longer available.', 'target')
  const detailClose = button('Close report', actions.close)
  detail.append(detailStatus, detailBody, detailApproximate, detailClose)
  panel.append(heading, form, success, detail)
  const highlight = element('div', undefined, 'highlight')
  highlight.setAttribute('aria-hidden', 'true')
  const pin = element('div', undefined, 'pin')
  pin.setAttribute('aria-hidden', 'true')
  surface.append(savedLayer, backdrop, highlight, pin, launcher, toggle, bar, panel)
  shadow.append(style, surface)
  // Hide the incomplete view before it enters the document.
  launcher.hidden =
    bar.hidden =
    backdrop.hidden =
    panel.hidden =
    highlight.hidden =
    pin.hidden =
    success.hidden =
    detail.hidden =
    toggle.hidden =
    savedLayer.hidden =
      true
  doc.documentElement.append(host)
  if (typeof surface.showPopover === 'function') {
    safe(() => {
      surface.setAttribute('popover', 'manual')
      surface.showPopover()
    }, undefined)
    // A blocked top-layer API must not leave the fallback permanently hidden.
    if (!safe(() => surface.matches(':popover-open'), false)) surface.removeAttribute('popover')
  }

  return {
    host,
    shadow,
    show(phase: Phase, hasIdentity: boolean, label = 'About this page') {
      currentPhase = phase
      identified = hasIdentity
      updateSavedVisibility()
      launcher.hidden = phase !== 'idle' || !hasIdentity
      bar.hidden = phase !== 'pin'
      panel.hidden = phase !== 'compose' && phase !== 'success' && phase !== 'detail'
      backdrop.hidden = panel.hidden
      form.hidden = phase !== 'compose'
      success.hidden = phase !== 'success'
      detail.hidden = phase !== 'detail'
      heading.textContent = phase === 'success' ? 'Report sent' : 'Send feedback'
      targetLabel.textContent = label
      highlight.hidden = true
      if (phase !== 'compose' && phase !== 'success') pin.hidden = true
      if (phase === 'pin') pageButton.focus()
      if (phase === 'compose') body.focus()
      if (phase === 'success') done.focus()
    },
    savedPins(placements: PinPlacement[], truncated: boolean) {
      const ids = new Set(placements.map((p) => p.pin.id))
      for (const [id, node] of savedButtons)
        if (!ids.has(id)) {
          node.remove()
          savedButtons.delete(id)
        }
      placements.forEach(({ pin, resolution }, index) => {
        let node = savedButtons.get(pin.id)
        if (!node) {
          node = button('', () => actions.saved(pin.id), 'saved-pin')
          node.setAttribute('data-bugzap-report', pin.id)
          savedButtons.set(pin.id, node)
          savedLayer.append(node)
        }
        node.textContent = String(index + 1)
        node.setAttribute(
          'aria-label',
          `Report ${index + 1}: ${pin.title}${resolution.approximate ? ' (approximate position)' : ''}`,
        )
        node.setAttribute('data-approximate', String(resolution.approximate))
        node.setAttribute('data-anchor-strategy', resolution.strategy)
        node.style.left = `${resolution.x - (doc.defaultView?.scrollX ?? 0)}px`
        node.style.top = `${resolution.y - (doc.defaultView?.scrollY ?? 0)}px`
      })
      toggle.title = truncated ? 'Showing your latest 100 pins on this page.' : ''
      updateSavedVisibility()
    },
    detail(placement: PinPlacement) {
      const { pin, resolution } = placement
      heading.textContent = pin.title
      detailStatus.textContent = statusLabel(pin.status, pin.kind)
      detailBody.textContent = pin.body
      detailApproximate.hidden = !resolution.approximate
      detailClose.focus()
    },
    draft: () => ({ kind: kind.value as ReportKind, body: body.value }),
    clear() {
      body.value = ''
      kind.value = 'bug'
      error.textContent = ''
      send.disabled = false
      body.disabled = kind.disabled = repin.disabled = false
    },
    sending(value: boolean) {
      send.disabled = body.disabled = kind.disabled = repin.disabled = value
      send.textContent = value ? 'Sending…' : 'Send report'
      form.setAttribute('aria-busy', String(value))
      error.textContent = value ? 'Sending report…' : ''
    },
    error(message: string) {
      error.textContent = message
      body.focus()
    },
    highlight(target: Element | null) {
      highlight.hidden = !target
      if (!target) return
      const rect = target.getBoundingClientRect()
      Object.assign(highlight.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      })
    },
    pin(x: number, y: number) {
      pin.hidden = false
      pin.style.left = `${x}px`
      pin.style.top = `${y}px`
    },
    focusLauncher() {
      if (!launcher.hidden) launcher.focus()
    },
    trapTab(event: KeyboardEvent) {
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>('button, textarea, select')).filter(
        (node) => !node.closest('[hidden]') && !node.hasAttribute('disabled'),
      )
      const active = shadow.activeElement
      const first = nodes[0]
      const last = nodes.at(-1)
      if (!first || !last) return
      if (
        !nodes.some((n) => n === active) ||
        (event.shiftKey && active === first) ||
        (!event.shiftKey && active === last)
      ) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    },
    dispose() {
      safe(() => surface.hidePopover(), undefined)
      host.remove()
    },
  }
}

export type WidgetView = ReturnType<typeof createView>
