import { ipcMain, BrowserWindow } from 'electron'
import { BrowserManager } from './browser-manager'
import { AuthService } from './auth-service'
import { RoomManager } from './room-manager'
import { DiscoveryService } from './discovery-service'
import { store } from './store'
import { setupAppMenu } from './app-menu'
import { StatsService } from './stats-service'
import { AutoRunner } from './auto-runner'

export function setupIpcHandlers(
  mainWindow: BrowserWindow,
  _browserManager: BrowserManager,
  authService: AuthService,
  roomManager: RoomManager,
  discoveryService: DiscoveryService,
  statsService: StatsService,
  autoRunner: AutoRunner
): void {
  roomManager.setCallbacks(
    (room) => {
      mainWindow.webContents.send('room:update', {
        id: room.id,
        url: room.url,
        name: room.name,
        status: room.status,
        fudaiCount: room.fudaiCount,
        hasFanBadge: room.hasFanBadge,
        countdownText: room.countdownText,
        remainingSeconds: room.remainingSeconds
      })
    },
    (roomId, message) => {
      mainWindow.webContents.send('log:add', { roomId, message, time: Date.now() })
    },
    (_room, result) => {
      statsService.recordParticipation(result)
    },
    (roomId) => {
      mainWindow.webContents.send('room:removed', roomId)
    }
  )

  discoveryService.setLogger((message) => {
    mainWindow.webContents.send('log:add', { roomId: 'discover', message, time: Date.now() })
  })

  statsService.setOnUpdate((stats) => {
    mainWindow.webContents.send('run-stats:update', stats)
  })

  autoRunner.setCallbacks(
    (message) => {
      mainWindow.webContents.send('log:add', { roomId: 'auto', message, time: Date.now() })
    },
    (state) => {
      mainWindow.webContents.send('auto-run:update', state)
    }
  )

  ipcMain.handle('auth:login', async () => {
    try {
      const success = await authService.login()
      return { success, isLoggedIn: authService.getLoginStatus() }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('auth:logout', async () => {
    await authService.logout()
    return { success: true }
  })

  ipcMain.handle('auth:status', () => {
    return { isLoggedIn: authService.getLoginStatus() }
  })

  ipcMain.handle('room:add', async (_event, url: string, name?: string) => {
    try {
      const room = await roomManager.addRoom(url, name)
      return { success: true, room: roomManager.getRoomPublicInfo(room.id) }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('room:remove', async (_event, roomId: string) => {
    await roomManager.removeRoom(roomId)
    return { success: true }
  })

  ipcMain.handle('room:list', () => {
    return roomManager.getAllRoomsPublicInfo()
  })

  ipcMain.handle('discovery:scan', async (_event, options?: { sourceUrl?: string; maxRooms?: number }) => {
    try {
      const rooms = await discoveryService.scan(options)
      return { success: true, rooms }
    } catch (e: any) {
      return { success: false, error: e.message, rooms: [] }
    }
  })

  ipcMain.handle('discovery:addFastest', async (_event, options?: { sourceUrl?: string }) => {
    try {
      const rooms = await discoveryService.scan({ ...options, maxRooms: 10 })
      const fastestRoom = rooms.find((room) => !roomManager.hasRoom(room.url))
      if (!fastestRoom) {
        return { success: false, error: '没有发现可添加的福袋直播间', rooms }
      }

      const room = await roomManager.addRoom(fastestRoom.url, fastestRoom.name, {
        countdownText: fastestRoom.countdownText,
        remainingSeconds: fastestRoom.remainingSeconds
      })
      return {
        success: true,
        discoveredRoom: fastestRoom,
        rooms,
        room: roomManager.getRoomPublicInfo(room.id)
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('config:get', () => {
    return store.store
  })

  ipcMain.handle('config:set', (_event, config: Partial<typeof store.store>) => {
    for (const [key, value] of Object.entries(config)) {
      store.set(key as any, value)
    }
    if (config.language) {
      setupAppMenu(mainWindow)
    }
    return { success: true }
  })

  ipcMain.handle('config:resetDiamondUsed', () => {
    store.set('diamondUsed', 0)
    return { success: true }
  })

  ipcMain.handle('stats:get', () => {
    const rooms = roomManager.getAllRooms()
    const totalFudai = rooms.reduce((sum, room) => sum + room.fudaiCount, 0)
    const runStats = statsService.getStats()
    const diamondBudget = store.get('diamondBudget')
    const diamondUsed = store.get('diamondUsed')
    const effectiveBudget = diamondBudget + (store.get('allowDiamondProfit') ? runStats.diamondWonAmount || 0 : 0)
    return {
      totalFudai,
      activeRooms: rooms.filter((room) => room.status === 'monitoring').length,
      diamondBudget: effectiveBudget,
      diamondUsed,
      diamondRemaining: effectiveBudget - diamondUsed
    }
  })

  ipcMain.handle('runStats:get', () => {
    return statsService.getStats()
  })

  ipcMain.handle('runStats:reset', () => {
    return statsService.reset()
  })

  ipcMain.handle(
    'autoRun:start',
    async (
      _event,
      options?: {
        sourceUrl?: string
        scanIntervalSeconds?: number
        stopAfterMinutes?: number
        enterBeforeSeconds?: number
        candidatePoolLimit?: number
      }
    ) => {
      try {
        const state = await autoRunner.start(options)
        return { success: true, state }
      } catch (e: any) {
        return { success: false, error: e.message, state: autoRunner.getState() }
      }
    }
  )

  ipcMain.handle('autoRun:stop', async () => {
    const state = await autoRunner.stop()
    return { success: true, state }
  })

  ipcMain.handle('autoRun:status', () => {
    return autoRunner.getState()
  })
}
