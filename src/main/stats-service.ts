import { store, RunStats } from './store'
import { FudaiGrabResult } from './fudai-service'

export class StatsService {
  private onUpdate: ((stats: RunStats) => void) | null = null

  setOnUpdate(onUpdate: (stats: RunStats) => void): void {
    this.onUpdate = onUpdate
  }

  getStats(): RunStats {
    return store.get('runStats')
  }

  markStarted(): void {
    this.patch({
      lastStartedAt: Date.now()
    })
  }

  markStopped(): void {
    this.patch({
      lastStoppedAt: Date.now()
    })
  }

  recordParticipation(result: FudaiGrabResult): void {
    const current = this.getStats()
    const next: RunStats = {
      ...current,
      participated: current.participated + 1
    }

    if (result.prizeType === 'physical') {
      next.physicalWins += 1
    } else if (result.prizeType === 'diamond') {
      next.diamondWins += 1
    } else if (result.prizeType === 'coupon') {
      next.couponWins += 1
    }

    this.setStats(next)
  }

  reset(): RunStats {
    const resetStats: RunStats = {
      participated: 0,
      physicalWins: 0,
      diamondWins: 0,
      couponWins: 0,
      lastStartedAt: null,
      lastStoppedAt: null
    }
    this.setStats(resetStats)
    return resetStats
  }

  private patch(partial: Partial<RunStats>): void {
    this.setStats({
      ...this.getStats(),
      ...partial
    })
  }

  private setStats(stats: RunStats): void {
    store.set('runStats', stats)
    this.onUpdate?.(stats)
  }
}

