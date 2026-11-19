// Outgoing mail, which today is only the new-report notice to a site's owners.
// `console` writes the message to the Worker's log: the terminal in dev and
// `wrangler tail` on a deployed Worker. `cloudflare` will send through Email
// Service once a sending domain's SPF and DKIM records exist (a DNS change).

export type Mail = {
  to: string
  subject: string
  text: string
  /** What console mode prints in place of `text`, for a message whose body
   *  carries someone else's words and should not sit in a log. */
  logText?: string
}

/** Never throws: a mail failure must not turn into a different HTTP answer, which
 *  would tell a stranger whether an address is on the allowlist. */
export async function sendMail(env: Pick<Env, 'MAIL_MODE'>, mail: Mail): Promise<void> {
  try {
    if ((env.MAIL_MODE as string) === 'console') {
      const subject = mail.logText === undefined ? mail.subject : '(not logged)'
      console.log(`[mail] To: ${mail.to}\n[mail] Subject: ${subject}\n\n${mail.logText ?? mail.text}\n`)
      return
    }
    // The recipient and body stay out of the log: this branch runs in production.
    console.error(JSON.stringify({ event: 'mail_unconfigured', mode: String(env.MAIL_MODE) }))
  } catch {
    console.error(JSON.stringify({ event: 'mail_failed' }))
  }
}
