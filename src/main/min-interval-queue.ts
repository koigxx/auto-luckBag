export class MinIntervalQueue {
  private lastStartAt = 0
  private chain: Promise<any> = Promise.resolve()
  private minMs: number
  private maxMs: number

  constructor(minMs: number, maxMs: number) {
    this.minMs = Math.max(0, Math.floor(minMs))
    this.maxMs = Math.max(this.minMs, Math.floor(maxMs))
  }

  run<T>(label: string, fn: () => Promise<T>, onLog?: (message: string) => void): Promise<T> {
    const task = this.chain.then(async () => {
      const now = Date.now()
      const gap = this.randomBetween(this.minMs, this.maxMs)
      const waitMs = Math.max(0, this.lastStartAt + gap - now)
      if (waitMs > 0) {
        onLog?.(`[throttle] ${label} wait ${Math.ceil(waitMs / 1000)}s`)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
      this.lastStartAt = Date.now()
      return fn()
    })

    // Keep the queue alive even if one task fails.
    this.chain = task.catch(() => undefined)
    return task
  }

  private randomBetween(min: number, max: number): number {
    if (max <= min) return min
    return min + Math.floor(Math.random() * (max - min + 1))
  }
}

