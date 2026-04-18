import Store from 'electron-store'

export interface FudaiTypes {
  all: boolean
  physical: boolean
  diamond: boolean
  other: boolean
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
  couponWins: number
  lastStartedAt: number | null
  lastStoppedAt: number | null
}

export interface AppConfig {
  language: 'zh-CN' | 'en-US'
  fudaiTypes: FudaiTypes
  diamondBudget: number
  diamondUsed: number
  autoFollow: boolean
  debugLogs: boolean
  scanIntervalSeconds: number
  enterBeforeSeconds: number
  rooms: RoomConfig[]
  preferredRooms: RoomConfig[]
  runStats: RunStats
}

const defaults: AppConfig = {
  language: 'zh-CN',
  fudaiTypes: {
    all: true,
    physical: false,
    diamond: false,
    other: false
  },
  diamondBudget: 10,
  diamondUsed: 0,
  autoFollow: true,
  debugLogs: false,
  scanIntervalSeconds: 50,
  enterBeforeSeconds: 120,
  rooms: [],
  preferredRooms: [],
  runStats: {
    participated: 0,
    physicalWins: 0,
    diamondWins: 0,
    couponWins: 0,
    lastStartedAt: null,
    lastStoppedAt: null
  }
}

export const store = new Store<AppConfig>({
  defaults
})
