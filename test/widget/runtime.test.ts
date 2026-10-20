import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseReportPayload } from '../../src/core/payload'
import { installWidget } from '../../src/widget/runtime'
import type { BugzapApi } from '../../src/widget/types'

const API = 'https://collector.example'
const SITE = 'bz_pk_ABCDEFGHIJKLMNOPQRSTUV'
const TOKEN = 'demo-identity-for-widget-tests'
let api: BugzapApi

function shadow(): ShadowRoot {
  return document.querySelector('[data-bugzap-root]')!.shadowRoot!
}
function button(text: string): HTMLButtonElement {
  const found = Array.from(shadow().querySelectorAll('button')).find(
    (node) => node.textContent === text && !node.closest('[hidden]'),
  )
  if (!found) throw new Error(`Button not found: ${text}`)
  return found
}
function textArea(): HTMLTextAreaElement {
  return shadow().querySelector('textarea')!
}
function target() {
  const button = document.createElement('button')
  button.setAttribute('data-bugzap-id', 'save')
  button.textContent = 'Save changes'
  document.body.append(button)
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 40, 100, 30))
  return button
}
function click(node: Element, clientX = 45, clientY = 55) {
  return node.dispatchEvent(
    new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, clientX, clientY }),
  )
}
const ready = () => api('init', { site: SITE, identity: TOKEN })
function stubFetch() {
  const fn = vi.fn<typeof window.fetch>()
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === 'GET'
      ? Promise.resolve(new Response(JSON.stringify({ ok: true, pins: [], truncated: false })))
      : fn(input, init),
  )
  return fn
}

beforeEach(() => {
  stubFetch()
  api = installWidget(window, API)
})
afterEach(() => {
  window.Bugzap?.('destroy')
  document.body.replaceChildren()
  for (const root of document.querySelectorAll('[data-bugzap-root]')) root.remove()
  window.Bugzap = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('widget lifecycle', () => {
  it('drains the real arguments-style stub queue and installs only once', () => {
    api('destroy')
    const stub: BugzapApi = function () {
      if (!stub.q) stub.q = []
      // biome-ignore lint/style/noArguments: Exercise the real public embed stub's arguments objects.
      stub.q.push(arguments)
    }
    window.Bugzap = stub
    const readyEvent = vi.fn()
    stub('on', 'ready', readyEvent)
    stub('init', { site: SITE, identity: TOKEN })
    stub('open', { page: true })
    api = installWidget(window, API)
    expect(readyEvent).toHaveBeenCalledOnce()
    expect(shadow().querySelector('form')?.hidden).toBe(false)
    expect(installWidget(window, API)).toBe(api)
    expect(document.querySelectorAll('[data-bugzap-root]')).toHaveLength(1)
  })

  it('does not create a launcher for a secret key or unsupported backend origin', () => {
    api('init', { site: 'bz_sk_do-not-embed', identity: TOKEN })
    expect(document.querySelector('[data-bugzap-root]')).toBeNull()
    api('init', { site: SITE, identity: TOKEN, api: 'http://collector.example' })
    expect(document.querySelector('[data-bugzap-root]')).toBeNull()
  })

  it('renders without HTML parsing sinks and copies the embed nonce onto its isolated styles', () => {
    api('destroy')
    vi.spyOn(Element.prototype, 'innerHTML', 'set').mockImplementation(() => {
      throw new Error('HTML parsing is forbidden')
    })
    api = installWidget(window, API, 'test-nonce')
    ready()
    expect(shadow().querySelector('style')?.nonce).toBe('test-nonce')
    button('Feedback').click()
    button('Report this page').click()
    expect(textArea()).toBeDefined()
  })

  it('requires identification and clears drafts, context and recorder state on logout', () => {
    api('init', { site: SITE })
    expect(shadow().querySelector<HTMLButtonElement>('.launcher')?.hidden).toBe(true)
    api('identify', TOKEN)
    button('Feedback').click()
    button('Report this page').click()
    textArea().value = 'Private draft'
    api('context', { build: 'old' })
    api('logout')
    expect(textArea().value).toBe('')
    expect(shadow().querySelector<HTMLButtonElement>('.launcher')?.hidden).toBe(true)
    api('open')
    expect(shadow().querySelector('form')?.hidden).toBe(true)
    api('identify', 'next-identity')
    expect(button('Feedback')).toBeDefined()
  })

  it('treats repeated init as a reset and isolates exceptions thrown by host event listeners', () => {
    const errorListener = vi.fn(() => {
      throw new Error('host callback')
    })
    const nextListener = vi.fn()
    api('on', 'ready', errorListener)
    api('on', 'ready', nextListener)
    expect(ready).not.toThrow()
    ready()
    expect(document.querySelectorAll('[data-bugzap-root]')).toHaveLength(1)
    expect(nextListener).toHaveBeenCalledTimes(2)
    expect(button('Feedback')).toBeDefined()
  })

  it('restores host focus and leaves no click interception after Escape or destroy', () => {
    ready()
    const hostButton = target()
    hostButton.focus()
    const action = vi.fn()
    hostButton.addEventListener('click', action)
    api('open')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(hostButton)
    click(hostButton)
    expect(action).toHaveBeenCalledOnce()
    api('open')
    api('destroy')
    expect(document.querySelector('[data-bugzap-root]')).toBeNull()
    click(hostButton)
    expect(action).toHaveBeenCalledTimes(2)
    // An old API reference cannot resurrect a destroyed instance's listeners.
    api('init', { site: SITE, identity: TOKEN })
    expect(document.querySelector('[data-bugzap-root]')).toBeNull()
  })
})

describe('pinning and report composition', () => {
  it('pins the clicked element, suppresses its host action once, and sends its anchor cross-origin', async () => {
    const fetch = stubFetch().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, id: 'ABCDEFGHIJKLMNOPQRSTUV' }), { status: 201 }),
    )
    ready()
    api('context', { build: 'demo', token: 'private-context' })
    const submitted = vi.fn()
    api('on', 'submitted', submitted)
    const hostButton = target()
    const action = vi.fn()
    hostButton.addEventListener('click', action)
    button('Feedback').click()
    click(hostButton)
    expect(action).not.toHaveBeenCalled()
    expect(shadow().textContent).toContain('Pinned to button')
    textArea().value = 'The save button does nothing.'
    button('Send report').click()
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith({ id: 'ABCDEFGHIJKLMNOPQRSTUV' }))
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`${API}/v1/reports?site=${SITE}`)
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit' })
    expect(init?.headers).toBeUndefined()
    const payload = JSON.parse(String((init!.body as FormData).get('payload')))
    expect(parseReportPayload(payload).ok).toBe(true)
    expect(payload).toMatchObject({
      site: SITE,
      identity: TOKEN,
      pin: { attrs: [{ depth: 0, name: 'data-bugzap-id', value: 'save' }], offset: { fx: 0.25, fy: 0.5 } },
      screenshot: { mode: 'none' },
      diagnostics: { context: { build: 'demo' } },
    })
    expect(JSON.stringify(payload)).not.toContain('private-context')
    button('Done').click()
    click(hostButton)
    expect(action).toHaveBeenCalledOnce()
  })

  it('passes ignored controls through during selection and allows page-level reports', () => {
    ready()
    const ignored = document.createElement('div')
    ignored.setAttribute('data-bugzap-ignore', '')
    const hostButton = target()
    ignored.append(hostButton)
    document.body.append(ignored)
    const action = vi.fn()
    hostButton.addEventListener('click', action)
    api('open')
    click(hostButton)
    expect(action).toHaveBeenCalledOnce()
    expect(button('Report this page')).toBeDefined()
    button('Report this page').click()
    expect(shadow().textContent).toContain('About this page')
    expect(shadow().querySelector('form')?.hidden).toBe(false)
  })

  it('keeps the draft when changing the pinned target and traps Tab inside the dialog', () => {
    ready()
    api('open', { page: true })
    textArea().value = 'Keep this draft.'
    button('Change target').click()
    click(target())
    expect(textArea().value).toBe('Keep this draft.')
    const send = button('Send report')
    send.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(shadow().activeElement?.textContent).toBe('Change target')
  })

  it('prevents double sends and ignores a late success after identity changes', async () => {
    let resolve!: (res: Response) => void
    const fetch = stubFetch().mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    ready()
    api('open', { page: true })
    textArea().value = 'A valid report.'
    const send = button('Send report')
    send.click()
    send.click()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((fetch.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(false)
    api('identify', 'new-identity')
    expect((fetch.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(true)
    resolve(new Response(JSON.stringify({ ok: true, id: 'ABCDEFGHIJKLMNOPQRSTUV' }), { status: 201 }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(shadow().querySelector('section')?.hidden).toBe(true)
    expect(textArea().value).toBe('')
  })

  it('keeps a failed submission editable and retries only when asked', async () => {
    const fetch = stubFetch()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, id: 'ABCDEFGHIJKLMNOPQRSTUV' }), { status: 201 }))
    ready()
    api('open', { page: true })
    textArea().value = 'Do not lose this report.'
    button('Send report').click()
    await vi.waitFor(() => expect(shadow().querySelector('.error')?.textContent).toContain('Could not connect'))
    expect(textArea().value).toBe('Do not lose this report.')
    expect(fetch).toHaveBeenCalledTimes(1)
    button('Send report').click()
    await vi.waitFor(() => expect(shadow().querySelector('h2')?.textContent).toBe('Report sent'))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('validates required text without issuing a request', () => {
    const fetch = stubFetch()
    ready()
    api('open', { page: true })
    textArea().value = ' '
    button('Send report').click()
    expect(fetch).not.toHaveBeenCalled()
    expect(shadow().querySelector('.error')?.textContent).toContain('Write between')
  })
})

describe('host failure isolation', () => {
  it('removes pin listeners after an injected widget error and preserves the original click', () => {
    ready()
    const hostButton = target()
    const action = vi.fn()
    hostButton.addEventListener('click', action)
    vi.spyOn(hostButton, 'getBoundingClientRect').mockImplementation(() => {
      throw new Error('injected widget failure')
    })
    api('open')
    expect(() => click(hostButton)).not.toThrow()
    expect(action).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-bugzap-root]')).toBeNull()
    click(hostButton)
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('contains async view failures without leaking an unhandled rejection', async () => {
    ready()
    api('open', { page: true })
    vi.spyOn(textArea(), 'value', 'get').mockImplementation(() => {
      throw new Error('injected draft failure')
    })
    expect(() => button('Send report').click()).not.toThrow()
    await vi.waitFor(() => expect(document.querySelector('[data-bugzap-root]')).toBeNull())
    const hostButton = target()
    const action = vi.fn()
    hostButton.addEventListener('click', action)
    click(hostButton)
    expect(action).toHaveBeenCalledOnce()
  })

  it('remains usable with throwing storage getters and reports a missing fetch API', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('private mode')
    })
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('private mode')
    })
    vi.stubGlobal('fetch', undefined)
    ready()
    api('open', { page: true })
    textArea().value = 'A valid report.'
    button('Send report').click()
    await vi.waitFor(() => expect(shadow().querySelector('.error')?.textContent).toContain('cannot send reports'))
    expect(textArea().disabled).toBe(false)
    api('close')
    expect(button('Feedback')).toBeDefined()
  })
})
