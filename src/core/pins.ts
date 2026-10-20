import { type Anchor, parseAnchor } from './anchor'
import { isPublicId } from './ids'
import { BODY_MAX, isKind, isStatus, type ReportKind, type ReportStatus, TITLE_MAX } from './policy'

export const PINS_MAX = 100
export type SavedPin = {
  id: string
  kind: ReportKind
  status: ReportStatus
  title: string
  body: string
  anchor: Anchor
}

export function parseSavedPin(raw: unknown): SavedPin | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const anchor = parseAnchor(p.anchor)
  if (
    !isPublicId(p.id) ||
    !isKind(p.kind) ||
    !isStatus(p.status) ||
    !anchor ||
    typeof p.title !== 'string' ||
    typeof p.body !== 'string' ||
    p.body.length > BODY_MAX
  )
    return null
  return { id: p.id, kind: p.kind, status: p.status, title: p.title.slice(0, TITLE_MAX), body: p.body, anchor }
}
