import type { Context } from 'hono'
import type { SessionUser } from '../db/auth'

export type App = { Bindings: Env; Variables: { user: SessionUser } }
export type Ctx = Context<App>

export const now = () => Math.floor(Date.now() / 1000)
