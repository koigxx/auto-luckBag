export type RoomStatus = 'loading' | 'monitoring' | 'grabbing' | 'error' | 'idle'

export interface RoomInfo {
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

export interface FudaiTypes {
  all: boolean
  physical: boolean
  diamond: boolean
  other: boolean
}

export interface RunStats {
  participated: number
  physicalWins: number
  diamondWins: number
  diamondWonAmount: number
  couponWins: number
  lastStartedAt: number | null
  lastStoppedAt: number | null
}

export interface AppConfig {
  language: 'zh-CN' | 'en-US'
  fudaiTypes: FudaiTypes
  diamondBudget: number
  diamondUsed: number
  allowDiamondProfit: boolean
  autoFollow: boolean
  debugLogs: boolean
  scanIntervalSeconds: number
  enterBeforeSeconds: number
  candidatePoolLimit: number
  rooms: { id: string; url: string; name: string }[]
  preferredRooms: { id: string; url: string; name: string }[]
  runStats: RunStats
}

export interface LogEntry {
  roomId: string
  message: string
  time: number
}

export interface Stats {
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

export interface AutoRunState {
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
  candidates: VerifiedFudaiRoom[]
  riskPausedUntil: number | null
  lastRiskReason: string
}
