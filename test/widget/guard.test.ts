import { expect, it, vi } from 'vitest'
import { guard } from '../../src/widget/guard'

it('contains synchronous and asynchronous failures, including a broken recovery callback', async () => {
  const recovery = vi.fn(() => {
    throw new Error('recovery failed')
  })
  expect(() =>
    guard(() => {
      throw new Error('widget failed')
    }, recovery)(),
  ).not.toThrow()
  expect(() =>
    guard(async () => {
      throw new Error('async widget failed')
    }, recovery)(),
  ).not.toThrow()
  await Promise.resolve()
  await Promise.resolve()
  expect(recovery).toHaveBeenCalledTimes(2)
})
