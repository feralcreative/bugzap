import { afterEach, describe, expect, it, vi } from 'vitest'
import { REPORT_JSON_MAX, type ReportPayload } from '../../src/core/payload'
import { encodePayload, sendReport } from '../../src/widget/api'

const payload = (): ReportPayload => ({
  v: 1,
  site: 'bz_pk_ABCDEFGHIJKLMNOPQRSTUV',
  identity: 'test-identity',
  kind: 'bug',
  body: 'The save button does nothing.',
  page: { url: 'https://host.example/editor' },
  pin: null,
  screenshot: { mode: 'none' },
  diagnostics: {},
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('report submission', () => {
  it.each([
    ['invalid_identity', 401, 'sign-in has expired'],
    ['burst_limited', 429, 'wait a few seconds'],
    ['hourly_limited', 429, 'ten reports'],
    ['storage_unavailable', 503, 'Try again later.'],
  ])('shows useful advice for %s', async (error, status, message) => {
    vi.spyOn(window, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error, message: 'Try again later.' }), { status }),
    )
    await expect(sendReport(window, 'https://collector.example', payload(), new AbortController())).rejects.toThrow(
      message,
    )
  })

  it('rejects malformed success responses and handles non-JSON server failures', async () => {
    vi.spyOn(window, 'fetch')
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 201 }))
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
    await expect(sendReport(window, 'https://collector.example', payload(), new AbortController())).rejects.toThrow(
      'could not be saved',
    )
    await expect(sendReport(window, 'https://collector.example', payload(), new AbortController())).rejects.toThrow(
      'could not confirm',
    )
  })

  it('times out without automatically retrying', async () => {
    vi.useFakeTimers()
    const fetch = vi.spyOn(window, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const request = expect(
      sendReport(window, 'https://collector.example', payload(), new AbortController()),
    ).rejects.toThrow('could not be confirmed')
    await vi.advanceTimersByTimeAsync(15000)
    await request
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('shrinks overflowing diagnostics in UTF-8 without discarding the report or its first error', () => {
    const original = payload()
    original.body = '🐛'.repeat(1900)
    original.diagnostics = {
      errors: Array.from({ length: 25 }, (_, i) => ({
        kind: 'error',
        message: `Error ${i} ` + '☃'.repeat(1900),
        stack: '☃'.repeat(3900),
      })),
      context: { token: 'private-context', build: 'local' },
    }
    const json = encodePayload(original)
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(REPORT_JSON_MAX)
    const encoded = JSON.parse(json)
    expect(encoded.body).toBe(original.body)
    expect(encoded.diagnostics.errors[0].message).toContain('Error 0')
    expect(encoded.diagnostics.errors.length).toBeLessThan(25)
    expect(JSON.stringify(original.diagnostics)).toContain('Error 24')
    expect(json).not.toContain('private-context')
  })
})
