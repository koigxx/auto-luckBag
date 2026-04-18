export interface API {
  auth: {
    login: () => Promise<{ success: boolean; isLoggedIn?: boolean; error?: string }>
    logout: () => Promise<{ success: boolean }>
    status: () => Promise<{ isLoggedIn: boolean }>
  }
  room: {
    add: (
      url: string,
      name?: string
    ) => Promise<{ success: boolean; room?: import('./index').RoomInfo; error?: string }>
    remove: (roomId: string) => Promise<{ success: boolean }>
    list: () => Promise<import('./index').RoomInfo[]>
  }
  config: {
    get: () => Promise<import('./index').AppConfig>
    set: (config: Partial<import('./index').AppConfig>) => Promise<{ success: boolean }>
    resetDiamondUsed: () => Promise<{ success: boolean }>
  }
  stats: {
    get: () => Promise<import('./index').Stats>
  }
  runStats: {
    get: () => Promise<import('./index').RunStats>
    reset: () => Promise<import('./index').RunStats>
  }
  autoRun: {
    start: (options?: {
      sourceUrl?: string
      scanIntervalSeconds?: number
      stopAfterMinutes?: number
      enterBeforeSeconds?: number
      candidatePoolLimit?: number
    }) => Promise<{
      success: boolean
      state: import('./index').AutoRunState
      error?: string
    }>
    stop: () => Promise<{
      success: boolean
      state: import('./index').AutoRunState
    }>
    status: () => Promise<import('./index').AutoRunState>
  }
  discovery: {
    scan: (options?: {
      sourceUrl?: string
      maxRooms?: number
    }) => Promise<{
      success: boolean
      rooms: import('./index').DiscoveredRoom[]
      error?: string
    }>
    addFastest: (options?: {
      sourceUrl?: string
    }) => Promise<{
      success: boolean
      discoveredRoom?: import('./index').DiscoveredRoom
      rooms?: import('./index').DiscoveredRoom[]
      room?: import('./index').RoomInfo
      error?: string
    }>
  }
  on: (channel: string, callback: (...args: any[]) => void) => () => void
}
