import { contextBridge, ipcRenderer } from 'electron'

const api = {
  alerts: {dismiss:(id:string)=>ipcRenderer.invoke(id.startsWith('login:')?'alerts:dismissTransient':'alerts:dismiss',id)},
  insights: {
    openClaim:(key:string)=>ipcRenderer.invoke('insights:openClaim',key),
    claim:(key:string,claimed:boolean)=>ipcRenderer.invoke('insights:claim',key,claimed),
    get: () => ipcRenderer.invoke('insights:get'),
    room: (url: string, patch: Record<string, boolean>) => ipcRenderer.invoke('insights:room', url, patch),
    payment: (id: string, state: 'confirmed' | 'failed') => ipcRenderer.invoke('insights:payment', id, state),
    resolveRisk: () => ipcRenderer.invoke('insights:resolveRisk'),
    export: () => ipcRenderer.invoke('insights:export')
  },
  // 登录
  auth: {
    login: () => ipcRenderer.invoke('auth:login'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    status: (force = false) => ipcRenderer.invoke('auth:status', force)
  },
  // 房间管理
  room: {
    add: (url: string, name?: string) => ipcRenderer.invoke('room:add', url, name),
    remove: (roomId: string) => ipcRenderer.invoke('room:remove', roomId),
    list: () => ipcRenderer.invoke('room:list')
  },
  // 配置
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (config: any) => ipcRenderer.invoke('config:set', config),
    resetDiamondUsed: () => ipcRenderer.invoke('config:resetDiamondUsed')
  },
  // 统计
  stats: {
    get: () => ipcRenderer.invoke('stats:get')
  },
  runStats: {
    get: () => ipcRenderer.invoke('runStats:get'),
    reset: () => ipcRenderer.invoke('runStats:reset')
  },
  autoRun: {
    finish:()=>ipcRenderer.invoke('autoRun:finish'),
    skip:(url:string,id:string,today:boolean)=>ipcRenderer.invoke('autoRun:skip',url,id,today),
    start: (options?: {
      sourceUrl?: string
      scanIntervalSeconds?: number
      stopAfterMinutes?: number
      enterBeforeSeconds?: number
      candidatePoolLimit?: number
    }) => ipcRenderer.invoke('autoRun:start', options),
    stop: () => ipcRenderer.invoke('autoRun:stop'),
    status: () => ipcRenderer.invoke('autoRun:status')
  },
  // 自动发现
  discovery: {
    scan: (options?: { sourceUrl?: string; maxRooms?: number }) =>
      ipcRenderer.invoke('discovery:scan', options),
    addFastest: (options?: { sourceUrl?: string }) =>
      ipcRenderer.invoke('discovery:addFastest', options)
  },
  // 事件监听
  on: (channel: string, callback: (...args: any[]) => void) => {
    if (!['room:update','room:removed','log:add','run-stats:update','auto-run:update','alerts:update','navigate:records'].includes(channel)) throw new Error('Unsupported event')
    const subscription = (_event: any, ...args: any[]) => callback(...args)
    ipcRenderer.on(channel, subscription)
    return () => ipcRenderer.removeListener(channel, subscription)
  }
}

export type API = typeof api

contextBridge.exposeInMainWorld('api', api)
