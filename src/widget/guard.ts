/** Widget entry points must never add an exception to a host page. */
export function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

export function guard<A extends unknown[]>(
  run: (...args: A) => unknown,
  failed: () => void = () => {},
): (...args: A) => void {
  return (...args) => {
    try {
      const value = run(...args)
      if (value && typeof (value as PromiseLike<unknown>).then === 'function')
        void Promise.resolve(value).catch(() => safe(failed, undefined))
    } catch {
      safe(failed, undefined)
    }
  }
}
