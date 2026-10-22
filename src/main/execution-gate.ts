import type { Policy } from '../shared/policy'

/** Earliest allowed navigation under the rolling hourly quotas; spacing stays in the gate. */
export function navigationQuotaReadyAt(
  navigations: { at: number; fresh: boolean }[],
  p: Policy,
  now: number,
  fresh: boolean
): number {
  const recent = navigations.filter((n) => n.at > now - 3600000).sort((a, b) => a.at - b.at)
  const ready = (items: typeof recent, limit: number) =>
    limit === 0 ? Infinity : items.length >= limit ? items[items.length - limit].at + 3600000 : now
  return Math.max(
    ready(recent, p.navigationsPerHour),
    fresh
      ? ready(
          recent.filter((n) => n.fresh),
          p.newRoomsPerHour
        )
      : now
  )
}

export function abortError(): Error {
  return new Error('操作已取消')
}
export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  checkSignal(signal)
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      reject(abortError())
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', cancel)
        resolve()
      },
      Math.max(0, ms)
    )
    signal.addEventListener('abort', cancel, { once: true })
  })
}

/** One queue for every side effect. Cancellation is checked again after every await. */
export class ExecutionGate {
  private controller = new AbortController()
  private chain: Promise<unknown> = Promise.resolve()
  constructor() {
    this.controller.abort()
  }
  get signal(): AbortSignal {
    return this.controller.signal
  }
  start(): void {
    this.controller.abort()
    this.controller = new AbortController()
  }
  stop(): void {
    this.controller.abort()
  }
  run<T>(
    signal: AbortSignal,
    task: () => Promise<T>,
    before: () => Promise<void> = async () => {}
  ): Promise<T> {
    const result = this.chain.then(async () => {
      checkSignal(signal)
      if (signal !== this.signal) throw abortError()
      await before()
      checkSignal(signal)
      const value = await task()
      checkSignal(signal)
      return value
    })
    this.chain = result.catch(() => {})
    return result
  }
}
