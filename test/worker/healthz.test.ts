import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

it('answers /healthz', async () => {
  const res = await SELF.fetch('http://bugzap.test/healthz')
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('ok')
})
