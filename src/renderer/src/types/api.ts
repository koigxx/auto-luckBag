export interface API {
  alerts:{dismiss:(id:string)=>Promise<{success:boolean;error?:string}>}
  insights: {
    openClaim:(key:string)=>Promise<{success:boolean;error?:string}>
    claim:(key:string,claimed:boolean)=>Promise<{success:boolean;error?:string}>
    get: () => Promise<import('../../../shared/insights').Insights | null>
    room: (url: string, patch: Record<string, boolean>) => Promise<{success:boolean;error?:string}>
    payment: (id: string, state: 'confirmed' | 'failed') => Promise<{success:boolean;error?:string}>
    openRisk: (id:string) => Promise<{success:boolean;error?:string}>
    resolveRisk: (id:string) => Promise<{success:boolean;error?:string}>
    export: () => Promise<{success:boolean;error?:string;path?:string}>
  }
  auth: {
    login: () => Promise<{ success: boolean; isLoggedIn?: boolean; error?: string }>
    logout: () => Promise<{ success: boolean; error?: string }>
    status: (force?: boolean) => Promise<import('../../../shared/auth').AuthStatus>
  }
  room: {
    add: (
      url: string,
      name?: string
    ) => Promise<{ success: boolean; room?: import('./index').RoomInfo; error?: string }>
    remove: (roomId: string) => Promise<{ success: boolean; error?: string }>
    list: () => Promise<import('./index').RoomInfo[]>
  }
  config: {
    get: () => Promise<import('./index').AppConfig>
    set: (config: Partial<import('./index').AppConfig>) => Promise<{ success: boolean; error?:string; config?:import('./index').AppConfig }>
    resetDiamondUsed: () => Promise<{ success: boolean; changed?:boolean; error?:string; config?:import('./index').AppConfig }>
  }
  stats: {
    get: () => Promise<import('./index').Stats>
  }
  runStats: {
    get: () => Promise<import('./index').RunStats>
    reset: () => Promise<import('./index').RunStats>
  }
  autoRun: {
    extend:(minutes:number,stopAt:number)=>Promise<{success:boolean;error?:string;state:import('./index').AutoRunState}>
    finish:()=>Promise<{success:boolean;error?:string;state:import('./index').AutoRunState}>
    skip:(url:string,id:string,today:boolean)=>Promise<{success:boolean;error?:string;state:import('./index').AutoRunState}>
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
      error?: string
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
