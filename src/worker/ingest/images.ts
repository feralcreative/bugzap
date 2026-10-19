import { checkUpload, MAX_IMAGE_BYTES, MIME, UPLOAD_REFUSAL_MESSAGES } from '../../core/image-policy'
import { stripMetadata } from '../../core/image-strip'
import { generateId } from '../../core/ids'
import type { ReportPayload } from '../../core/payload'
import { UPLOAD_MAX } from '../../core/policy'
import type { IngestSite, StoredImage } from '../db/scoped'
import { IngestError } from './body'

export type PreparedImage = StoredImage & { data: Uint8Array }

export async function prepareImages(
  form: FormData,
  payload: ReportPayload,
  site: IngestSite,
  reportId: string,
): Promise<PreparedImage[]> {
  for (const key of form.keys()) {
    if (key !== 'payload' && key !== 'screenshot' && key !== 'attachments')
      throw new IngestError(400, 'invalid_parts', 'An unexpected report field was sent.')
  }
  const shots = form.getAll('screenshot')
  const attachments = form.getAll('attachments')
  if (shots.length > 1 || attachments.length > UPLOAD_MAX)
    throw new IngestError(400, 'too_many_images', 'Send one screenshot and at most two attachments.')
  if ((payload.screenshot.mode === 'none') !== (shots.length === 0))
    throw new IngestError(400, 'screenshot_mismatch', 'The screenshot mode and file do not agree.')
  const parts = [
    ...shots.map((file) => ({ file, role: 'screenshot' as const })),
    ...attachments.map((file) => ({ file, role: 'attachment' as const })),
  ]
  const images: PreparedImage[] = []
  for (const { file, role } of parts) {
    if (typeof file === 'string') throw new IngestError(400, 'invalid_image', 'Images must be file fields.')
    // Check size before allocating the image's buffer. The MIME and filename are
    // untrusted: sniff bytes, strip metadata, and generate our own storage key.
    if (file.size > MAX_IMAGE_BYTES) throw new IngestError(413, 'image_too_large', 'Images must be 2 MB or smaller.')
    const raw = new Uint8Array(await file.arrayBuffer())
    const check = checkUpload(raw)
    if (!check.ok) throw new IngestError(415, 'invalid_image', UPLOAD_REFUSAL_MESSAGES[check.reason])
    const data = stripMetadata(raw, check.type)
    if (!data) throw new IngestError(415, 'invalid_image', 'That image is damaged or incomplete.')
    const publicId = generateId()
    images.push({
      publicId,
      role,
      key: `${site.account_id}/${site.id}/${reportId}/${publicId}.${check.type}`,
      mime: MIME[check.type],
      bytes: data.length,
      width: check.size.width,
      height: check.size.height,
      data,
    })
  }
  return images
}
