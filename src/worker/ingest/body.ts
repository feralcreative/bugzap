import { MAX_IMAGE_BYTES } from '../../core/image-policy'
import { REPORT_JSON_MAX } from '../../core/payload'
import { UPLOAD_MAX } from '../../core/policy'

// One screenshot plus UPLOAD_MAX extra images, a JSON part and multipart headers.
export const REPORT_REQUEST_MAX = (1 + UPLOAD_MAX) * MAX_IMAGE_BYTES + REPORT_JSON_MAX + 16 * 1024

export class IngestError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 413 | 415 | 429 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function checkRequestSize(request: Request): void {
  const size = request.headers.get('content-length')
  if (size && Number(size) > REPORT_REQUEST_MAX)
    throw new IngestError(413, 'request_too_large', 'The report is too large.')
}

export async function readReportForm(request: Request): Promise<FormData> {
  checkRequestSize(request)
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data\s*;/i.test(contentType))
    throw new IngestError(415, 'unsupported_media_type', 'Send the report as multipart/form-data.')
  if (!request.body) throw new IngestError(400, 'invalid_multipart', 'The report body is missing.')

  // Content-Length alone is insufficient: a streamed body may omit it. Read no
  // more than the cap before handing a bounded buffer to the multipart parser.
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > REPORT_REQUEST_MAX) {
        await reader.cancel()
        throw new IngestError(413, 'request_too_large', 'The report is too large.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  try {
    return await new Response(bytes, { headers: { 'content-type': contentType } }).formData()
  } catch {
    throw new IngestError(400, 'invalid_multipart', 'The multipart body could not be read.')
  }
}

export function readPayloadPart(form: FormData): Record<string, unknown> {
  const parts = form.getAll('payload')
  if (parts.length !== 1 || typeof parts[0] !== 'string')
    throw new IngestError(400, 'invalid_payload', 'Send exactly one payload JSON field.')
  if (new TextEncoder().encode(parts[0]).length > REPORT_JSON_MAX)
    throw new IngestError(413, 'payload_too_large', 'The report details are too large.')
  let raw: unknown
  try {
    raw = JSON.parse(parts[0])
  } catch {
    throw new IngestError(400, 'invalid_payload', 'The report details must be JSON.')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new IngestError(400, 'invalid_payload', 'The report details must be an object.')
  return raw as Record<string, unknown>
}
