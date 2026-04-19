import Store from 'electron-store'

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
  rooms: RoomConfig[]
  preferredRooms: RoomConfig[]
  runStats: RunStats
}

const defaults: AppConfig = {
  language: 'zh-CN',
  fudaiTypes: {
    all: true,
    physical: false,
    diamond: false
  },
  diamondBudget: 10,
  diamondUsed: 0,
  allowDiamondProfit: false,
  autoFollow: true,
  debugLogs: false,
  scanIntervalSeconds: 35,
  enterBeforeSeconds: 65,
  candidatePoolLimit: 4,
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

export const store = new Store<AppConfig>({
  defaults
})
