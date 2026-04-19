import { ref, onMounted, onUnmounted } from 'vue'
import type {
  RoomInfo,
  AppConfig,
  LogEntry,
  Stats,
  DiscoveredRoom,
  RunStats,
  AutoRunState
} from '../types'

export function useIpc() {
  const isLoggedIn = ref(false)
  const rooms = ref<RoomInfo[]>([])
  const config = ref<AppConfig | null>(null)
  const logs = ref<LogEntry[]>([])
  const stats = ref<Stats | null>(null)
  const runStats = ref<RunStats | null>(null)
  const autoRunState = ref<AutoRunState | null>(null)
  const discoveredRooms = ref<DiscoveredRoom[]>([])
  const isScanningDiscovery = ref(false)
  const discoveryStatus = ref('')

  let unsubRoomUpdate: (() => void) | null = null
  let unsubLogAdd: (() => void) | null = null
  let unsubRoomRemoved: (() => void) | null = null
  let unsubRunStats: (() => void) | null = null
  let unsubAutoRun: (() => void) | null = null
  let roomCountdownTimer: number | null = null

  onMounted(async () => {
    const authStatus = await window.api.auth.status()
    isLoggedIn.value = authStatus.isLoggedIn

    rooms.value = await window.api.room.list()
    config.value = await window.api.config.get()
    stats.value = await window.api.stats.get()
    runStats.value = await window.api.runStats.get()
    autoRunState.value = await window.api.autoRun.status()

    unsubRoomUpdate = window.api.on('room:update', (room: RoomInfo) => {
      upsertRoom(room)
      refreshStats()
    })

    unsubRoomRemoved = window.api.on('room:removed', (roomId: string) => {
      rooms.value = rooms.value.filter((room) => room.id !== roomId)
      refreshStats()
    })

    unsubLogAdd = window.api.on('log:add', (entry: LogEntry) => {
      logs.value.push(entry)
      if (logs.value.length > 500) {
        logs.value = logs.value.slice(-500)
      }
      refreshStats()
    })

    unsubRunStats = window.api.on('run-stats:update', (entry: RunStats) => {
      runStats.value = entry
      if (config.value) config.value.runStats = entry
    })

    unsubAutoRun = window.api.on('auto-run:update', (entry: AutoRunState) => {
      autoRunState.value = entry
    })

    roomCountdownTimer = window.setInterval(() => {
      rooms.value = rooms.value.map((room) => ({
        ...room,
        remainingSeconds:
          typeof room.drawAt === 'number' && room.drawAt > 0
            ? Math.max(0, Math.ceil((room.drawAt - Date.now()) / 1000))
            : typeof room.remainingSeconds === 'number' && room.remainingSeconds > 0
              ? room.remainingSeconds - 1
              : room.remainingSeconds
      }))
    }, 1000)
  })

  onUnmounted(() => {
    unsubRoomUpdate?.()
    unsubRoomRemoved?.()
    unsubLogAdd?.()
    unsubRunStats?.()
    unsubAutoRun?.()
    if (roomCountdownTimer !== null) {
      window.clearInterval(roomCountdownTimer)
      roomCountdownTimer = null
    }
  })

  async function login() {
    const result = await window.api.auth.login()
    isLoggedIn.value = result.isLoggedIn === true
    if (!result.success) {
      addSystemLog(result.error || '登录失败')
    }
    return result
  }

  async function logout() {
    await window.api.auth.logout()
    isLoggedIn.value = false
  }

  async function addRoom(url: string, name?: string) {
    const result = await window.api.room.add(url, name)
    if (result.success && result.room) {
      upsertRoom(result.room)
      await refreshStats()
    } else {
      addSystemLog(result.error || '添加直播间失败')
    }
    return result
  }

  async function scanDiscovery(sourceUrl?: string) {
    isScanningDiscovery.value = true
    discoveryStatus.value = '正在扫描直播入口...'
    addSystemLog('开始自动发现福袋直播间')
    try {
      const result = await window.api.discovery.scan({ sourceUrl, maxRooms: 20 })
      if (result.success) {
        discoveredRooms.value = result.rooms
        discoveryStatus.value =
          result.rooms.length > 0
            ? `发现 ${result.rooms.length} 个候选直播间`
            : '未发现福袋候选，请稍后再试或更换扫描入口'
        addSystemLog(`自动发现完成，候选直播间 ${result.rooms.length} 个`)
      } else {
        discoveryStatus.value = result.error || '自动发现失败'
        addSystemLog(result.error || '自动发现失败')
      }
      return result
    } finally {
      isScanningDiscovery.value = false
    }
  }

  async function addDiscoveredRoom(room: DiscoveredRoom) {
    return addRoom(room.url, room.name)
  }

  async function addFastestDiscoveredRoom(sourceUrl?: string) {
    isScanningDiscovery.value = true
    discoveryStatus.value = '正在扫描并尝试添加最快开奖直播间...'
    addSystemLog('开始扫描并添加最快开奖直播间')
    try {
      const result = await window.api.discovery.addFastest({ sourceUrl })
      if (result.rooms) {
        discoveredRooms.value = result.rooms
      }
      if (result.success && result.room) {
        upsertRoom(result.room)
        discoveryStatus.value = '已添加最快开奖候选直播间'
        if (result.discoveredRoom) {
          addSystemLog(`已添加快开奖直播间: ${result.discoveredRoom.name}`)
        }
        await refreshStats()
      } else {
        discoveryStatus.value = result.error || '没有可添加的快开奖直播间'
        addSystemLog(result.error || '没有可添加的快开奖直播间')
      }
      return result
    } finally {
      isScanningDiscovery.value = false
    }
  }

  async function startAutoRun(options: {
    sourceUrl?: string
    scanIntervalSeconds?: number
    stopAfterMinutes?: number
    enterBeforeSeconds?: number
    candidatePoolLimit?: number
  }) {
    const now = Date.now()
    autoRunState.value = {
      running: true,
      status: 'discovering',
      sourceUrl: options.sourceUrl || '',
      scanIntervalSeconds: options.scanIntervalSeconds || 50,
      stopAt: options.stopAfterMinutes ? now + options.stopAfterMinutes * 60 * 1000 : null,
      startedAt: now,
      lastScanAt: now,
      nextScanAt: now,
      candidateCount: autoRunState.value?.candidateCount || 0,
      pendingVerifyCount: autoRunState.value?.pendingVerifyCount || 0,
      enterBeforeSeconds: options.enterBeforeSeconds || 100,
      candidatePoolLimit: Math.min(5, Math.max(1, options.candidatePoolLimit || 5)),
      candidates: autoRunState.value?.candidates || [],
      riskPausedUntil: autoRunState.value?.riskPausedUntil || null,
      lastRiskReason: autoRunState.value?.lastRiskReason || ''
    }
    addSystemLog('已点击启动，正在启动自动运行')

    try {
      const result = await window.api.autoRun.start(options)
      autoRunState.value = result.state
      if (!result.success) {
        addSystemLog(result.error || '自动运行启动失败')
      }
      return result
    } catch (e: any) {
      autoRunState.value = {
        ...autoRunState.value,
        running: false,
        status: 'stopped',
        nextScanAt: null
      }
      addSystemLog(`自动运行启动异常: ${e.message || e}`)
      return {
        success: false,
        error: e.message || String(e),
        state: autoRunState.value
      }
    }
  }

  async function stopAutoRun() {
    if (autoRunState.value) {
      autoRunState.value = {
        ...autoRunState.value,
        running: false,
        status: 'stopped',
        nextScanAt: null
      }
    }
    addSystemLog('已点击停止，正在停止自动运行')
    try {
      const result = await window.api.autoRun.stop()
      autoRunState.value = result.state
      return result
    } catch (e: any) {
      addSystemLog(`自动运行停止异常: ${e.message || e}`)
      throw e
    }
  }

  async function resetRunStats() {
    runStats.value = await window.api.runStats.reset()
    if (config.value) config.value.runStats = runStats.value
    await refreshStats()
  }

  async function removeRoom(roomId: string) {
    await window.api.room.remove(roomId)
    rooms.value = rooms.value.filter((room) => room.id !== roomId)
    await refreshStats()
  }

  async function updateConfig(partial: Partial<AppConfig>) {
    await window.api.config.set(partial)
    config.value = { ...config.value!, ...partial }
    await refreshStats()
  }

  async function resetDiamondUsed() {
    await window.api.config.resetDiamondUsed()
    if (config.value) {
      config.value.diamondUsed = 0
    }
    await refreshStats()
  }

  async function refreshStats() {
    stats.value = await window.api.stats.get()
  }

  function upsertRoom(room: RoomInfo) {
    const idx = rooms.value.findIndex((item) => item.id === room.id)
    if (idx >= 0) {
      rooms.value[idx] = room
    } else {
      rooms.value.push(room)
    }
  }

  function addSystemLog(message: string) {
    logs.value.push({
      roomId: 'system',
      message,
      time: Date.now()
    })
    if (logs.value.length > 500) {
      logs.value = logs.value.slice(-500)
    }
  }

  return {
    isLoggedIn,
    rooms,
    config,
    logs,
    stats,
    runStats,
    autoRunState,
    discoveredRooms,
    isScanningDiscovery,
    discoveryStatus,
    login,
    logout,
    addRoom,
    scanDiscovery,
    addDiscoveredRoom,
    addFastestDiscoveredRoom,
    startAutoRun,
    stopAutoRun,
    resetRunStats,
    removeRoom,
    updateConfig,
    resetDiamondUsed,
    refreshStats
  }
}
