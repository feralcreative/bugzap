import { isPublicId } from '../core/ids'
import { redactDiagnostics } from '../core/diagnostics'
import { REPORT_JSON_MAX, type ReportPayload } from '../core/payload'

export class ReportError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

// Diagnostics are best-effort. Trim the newest entries before they can make an
// otherwise valid report exceed the server's UTF-8 JSON cap.
export function encodePayload(payload: ReportPayload): string {
  const diagnostics = redactDiagnostics(payload.diagnostics)
  const out = { ...payload, diagnostics }
  const encoder = new TextEncoder()
  let json = JSON.stringify(out)
  while (encoder.encode(json).length > REPORT_JSON_MAX) {
    if (diagnostics.net?.length) diagnostics.net.pop()
    else if (diagnostics.errors?.length) diagnostics.errors.pop()
    else if (Object.keys(diagnostics).length) {
      for (const key of Object.keys(diagnostics)) delete diagnostics[key as keyof typeof diagnostics]
    } else throw new ReportError('The report details are too large. Please shorten the report.', 'payload_too_large')
    json = JSON.stringify(out)
  }
  return json
}

export async function sendReport(
  win: Window,
  api: string,
  payload: ReportPayload,
  controller: AbortController,
): Promise<string> {
  if (typeof win.fetch !== 'function') throw new ReportError('This browser cannot send reports.', 'fetch_unavailable')
  const form = new FormData()
  form.set('payload', encodePayload(payload))
  const timer = win.setTimeout(() => controller.abort(), 15000)
  try {
    const res = await win.fetch(`${api}/v1/reports?site=${encodeURIComponent(payload.site)}`, {
      method: 'POST',
      body: form,
      credentials: 'omit',
      signal: controller.signal,
    })
    let data: unknown
    try {
      data = await res.json()
    } catch {
      throw new ReportError('The server could not confirm the report. Please try again.', 'invalid_response')
    }
    const object = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    if (res.status === 201 && object.ok === true && isPublicId(object.id)) return object.id
    const code = typeof object.error === 'string' ? object.error : 'submission_failed'
    const message =
      code === 'invalid_identity'
        ? 'Your sign-in has expired. Refresh this page and try again.'
        : code === 'burst_limited'
          ? 'Please wait a few seconds and try again.'
          : code === 'hourly_limited'
            ? 'You have reached ten reports for this hour. Please try again later.'
            : typeof object.message === 'string'
              ? object.message.slice(0, 200)
              : 'The report could not be saved. Please try again.'
    throw new ReportError(message, code)
  } catch (error) {
    if (error instanceof ReportError) throw error
    throw new ReportError(
      controller.signal.aborted
        ? 'The report could not be confirmed before the request ended.'
        : 'Could not connect. Check your connection and try again.',
      controller.signal.aborted ? 'request_ended' : 'network_error',
    )
  } finally {
    win.clearTimeout(timer)
  }
}
