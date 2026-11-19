import type { ReportKind } from '../core/policy'
import { sendMail } from './mail'

// Same 78-character ceiling Routeloop's owner alert uses: a longer subject is cut
// by the mail client at a point nobody chose.
const SUBJECT_MAX = 78
const KIND_WORD: Record<ReportKind, string> = { bug: 'Bug', idea: 'Idea', question: 'Question' }

export function ownerSubject(kind: ReportKind, title: string): string {
  const prefix = `${KIND_WORD[kind]}: `
  const room = SUBJECT_MAX - prefix.length
  return prefix + (title.length <= room ? title : `${title.slice(0, room - 1)}…`)
}

export type NewReport = {
  accountId: number
  siteId: number
  publicId: string
  kind: ReportKind
  title: string
  body: string
  reporter: string
  pageUrl: string
  /** The dashboard's origin, for the one link in the message. */
  origin: string
}

/**
 * Tells the account's owners that a report arrived. Call it after the report has
 * committed, through `waitUntil`. It never throws: a mail failure must not turn
 * a saved report into an error for the person who sent it.
 */
export async function notifyOwners(env: Pick<Env, 'DB' | 'MAIL_MODE'>, report: NewReport): Promise<void> {
  try {
    const [owners, site] = await Promise.all([
      // Ten is a ceiling on what one report may send, not an expected team size.
      env.DB.prepare(
        `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.account_id = ? AND m.role = 'owner' ORDER BY u.id LIMIT 10`,
      )
        .bind(report.accountId)
        .all<{ email: string }>(),
      env.DB.prepare(
        `SELECT s.name, (SELECT count(*) FROM reports r WHERE r.account_id = s.account_id AND r.site_id = s.id
        AND r.state = 'pending') AS waiting FROM sites s WHERE s.account_id = ? AND s.id = ?`,
      )
        .bind(report.accountId, report.siteId)
        .first<{ name: string; waiting: number }>(),
    ])
    if (!site) return
    const link = `${report.origin}/reports/${report.publicId}`
    const waiting = site.waiting === 1 ? '1 report is waiting' : `${site.waiting} reports are waiting`
    for (const owner of owners.results)
      await sendMail(env, {
        to: owner.email,
        subject: ownerSubject(report.kind, report.title),
        // The reporter's words are quoted, never paraphrased: they are the message.
        text: [
          `${report.reporter} sent a ${report.kind} on ${site.name}.`,
          `Page: ${report.pageUrl}`,
          '',
          report.body,
          '',
          `Open it: ${link}`,
          `${waiting} in the ${site.name} inbox.`,
        ].join('\n'),
        // Console mode writes to the Worker's log, where a reporter's words, name,
        // and page do not belong. The log gets the link and nothing else.
        logText: `A new ${report.kind} arrived on ${site.name}. Open it: ${link}`,
      })
  } catch {
    console.error(JSON.stringify({ event: 'owner_notify_failed', report: report.publicId }))
  }
}
