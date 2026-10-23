import { DEFAULT_POLICY, Policy } from './policy'

export interface FudaiTypes {
  all: boolean
  physical: boolean
  diamond: boolean
}

export interface RoomConfig {
  id: string
  url: string
  name: string
}

export interface RunStats {
  submittedUnknown?: number
  unknownResults?: number
  participated: number
  physicalWins: number
  diamondWins: number
  diamondWonAmount: number
  couponWins: number
  lastStartedAt: number | null
  lastStoppedAt: number | null
}

export interface AppConfig {
  policy: Policy
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
  rooms: RoomConfig[]
  preferredRooms: RoomConfig[]
  runStats: RunStats
}

export const defaults: AppConfig = {
  policy: { ...DEFAULT_POLICY },
  language: 'zh-CN',
  fudaiTypes: {
    all: true,
    physical: false,
    diamond: false
  },
  diamondBudget: 50,
  diamondUsed: 0,
  allowDiamondProfit: true,
  autoFollow: true,
  debugLogs: true,
  scanIntervalSeconds: 120,
  enterBeforeSeconds: 45,
  candidatePoolLimit: 5,
  rooms: [],
  preferredRooms: [],
  runStats: {
    participated: 0,
    physicalWins: 0,
    diamondWins: 0,
    diamondWonAmount: 0,
    couponWins: 0,
    lastStartedAt: null,
    lastStoppedAt: null
  }
}
