import type { SessionRecord } from '../../../shared/policy'
export type RoomStatus = 'loading' | 'monitoring' | 'grabbing' | 'error' | 'idle'

export interface RoomInfo {
  phase?: string
  id: string
  url: string
  name: string
  status: RoomStatus
  fudaiCount: number
  hasFanBadge: boolean
  countdownText: string
  remainingSeconds: number | null
  drawAt: number | null
}

export type { AppConfig, FudaiTypes, RunStats } from '../../../shared/config'

export interface LogEntry {
  roomId: string
  message: string
  time: number
}

export interface Stats {
  diamondReserved?: number
  totalFudai: number
  activeRooms: number
  diamondBudget: number
  diamondUsed: number
  diamondRemaining: number
}

export interface DiscoveredRoom {
  url: string
  name: string
  reason: string
  countdownText: string
  remainingSeconds: number | null
}

export interface VerifiedFudaiRoom extends DiscoveredRoom {
  verifiedAt: number
  hasFudai: boolean
  score: number
  matchedSignals: string[]
  drawAt: number | null
  countdownSource: 'websocket' | 'network' | 'modal' | 'visible-dom' | 'text' | null
  countdownConfidence: 'exact' | 'estimated' | 'unknown'
}

export type AutoRunStatus =
  | 'stopped'
  | 'discovering'
  | 'verifying'
  | 'waiting'
  | 'entering'
  | 'pausedByRisk'
  | 'running'
  | 'draining'
  | 'resting'
  | 'resume-check'
  | 'blocked'

export interface AutoRunState {
  waitingReason?: string
  resumeRemainingSeconds?: number | null
  session?: SessionRecord
  running: boolean
  status: AutoRunStatus
  sourceUrl: string
  scanIntervalSeconds: number
  stopAt: number | null
  startedAt: number | null
  lastScanAt: number | null
  nextScanAt: number | null
  candidateCount: number
  pendingVerifyCount: number
  enterBeforeSeconds: number
  candidatePoolLimit: number
  candidates: {
    url: string
    name: string
    score: number
    remainingSeconds: number | null
    entryRemainingSeconds?: number
    reason?: string
    probability?: number | null
    mode?: string
  }[]
  riskPausedUntil: number | null
  lastRiskReason: string
}
