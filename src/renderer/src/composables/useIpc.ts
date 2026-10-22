import { ref, onMounted, onUnmounted } from 'vue'
import type { RoomInfo, AppConfig, LogEntry, Stats, RunStats, AutoRunState } from '../types'
import type { Insights } from '../../../shared/insights'

export function useIpc() {
  const isLoggedIn = ref(false)
  const ready = ref(false)
  const rooms = ref<RoomInfo[]>([])
  const config = ref<AppConfig | null>(null)
  const logs = ref<LogEntry[]>([])
  const stats = ref<Stats | null>(null)
  const runStats = ref<RunStats | null>(null)
  const autoRunState = ref<AutoRunState | null>(null)
  const insights = ref<Insights | null>(null)
  const busy = ref<Record<string, boolean>>({})
  const notice = ref<{ text: string; kind: 'success' | 'error' | 'info' } | null>(null)
  const unsubscribers: (() => void)[] = []
  let poll: ReturnType<typeof setInterval> | undefined
  let statsTimer: ReturnType<typeof setTimeout> | undefined
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let refreshing = false
  let lastErrorAction: string | null = null

  const tr = (zh: string, en: string) => (config.value?.language === 'en-US' ? en : zh)
  function notify(text: string, kind: 'success' | 'error' | 'info' = 'success') {
    if (noticeTimer) clearTimeout(noticeTimer)
    notice.value = { text, kind }
    if (kind === 'success')
      noticeTimer = setTimeout(() => {
        notice.value = null
      }, 6000)
  }
  async function action<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    if (busy.value[key]) return null
    busy.value[key] = true
    try {
      const result = await fn()
      if (result && notice.value?.kind === 'error' && lastErrorAction === key) notice.value = null
      return result
    } catch (e: any) {
      lastErrorAction = key
      notify(e.message || tr('操作失败，请重试。', 'The action failed. Please try again.'), 'error')
      return null
    } finally {
      busy.value[key] = false
    }
  }
  function requireSuccess(result: { success: boolean; error?: string }) {
    if (!result.success)
      throw new Error(
        result.error || tr('操作未完成，请重试。', 'The action did not complete. Please retry.')
      )
  }
  async function refreshStats() {
    const value = await window.api.stats.get()
    if (!disposed) stats.value = value
  }
  async function refreshInsights() {
    if (refreshing || disposed) return
    refreshing = true
    try {
      insights.value = isLoggedIn.value ? await window.api.insights.get() : null
    } finally {
      refreshing = false
    }
  }
  function scheduleRefresh() {
    if (statsTimer) return
    statsTimer = setTimeout(() => {
      statsTimer = undefined
      void refreshStats().catch(() => {})
    }, 200)
  }
  function upsertRoom(room: RoomInfo) {
    const index = rooms.value.findIndex((item) => item.id === room.id)
    if (index < 0) rooms.value.push(room)
    else rooms.value[index] = room
  }
  async function refreshAccount() {
    const [auth, currentConfig, currentRooms, currentStats, state] = await Promise.all([
      window.api.auth.status(),
      window.api.config.get(),
      window.api.room.list(),
      window.api.runStats.get(),
      window.api.autoRun.status()
    ])
    if (disposed) return
    isLoggedIn.value = auth.isLoggedIn
    config.value = currentConfig
    rooms.value = currentRooms
    runStats.value = currentStats
    autoRunState.value = state
    await Promise.all([refreshStats(), refreshInsights()])
  }
  onMounted(async () => {
    unsubscribers.push(
      window.api.on('room:update', (room: RoomInfo) => {
        upsertRoom(room)
        scheduleRefresh()
      }),
      window.api.on('room:removed', (id: string) => {
        rooms.value = rooms.value.filter((r) => r.id !== id)
        scheduleRefresh()
      }),
      window.api.on('log:add', (entry: LogEntry) => {
        logs.value = [...logs.value, entry].slice(-500)
      }),
      window.api.on('run-stats:update', (entry: RunStats) => {
        runStats.value = entry
        scheduleRefresh()
      }),
      window.api.on('auto-run:update', (entry: AutoRunState) => {
        autoRunState.value = entry
      })
    )
    await action('initialize', refreshAccount)
    ready.value = true
    if (!disposed)
      poll = setInterval(() => {
        void refreshInsights().catch(() => {})
      }, 5000)
  })
  onUnmounted(() => {
    disposed = true
    unsubscribers.forEach((fn) => fn())
    if (poll) clearInterval(poll)
    if (statsTimer) clearTimeout(statsTimer)
    if (noticeTimer) clearTimeout(noticeTimer)
  })
  const login = () =>
    action('login', async () => {
      const result = await window.api.auth.login()
      await refreshAccount()
      requireSuccess(result)
      notify(tr('账号已连接，可以开始运行。', 'Account connected. You can start a run.'))
      return true
    })
  const logout = () =>
    action('logout', async () => {
      requireSuccess(await window.api.auth.logout())
      await refreshAccount()
      notify(tr('已退出账号并停止任务。', 'Signed out and stopped all tasks.'))
      return true
    })
  const addRoom = (url: string, name?: string) =>
    action('addRoom', async () => {
      const result = await window.api.room.add(url, name)
      requireSuccess(result)
      if (result.room) upsertRoom(result.room)
      autoRunState.value = await window.api.autoRun.status()
      await Promise.all([refreshStats(), refreshInsights()])
      notify(tr('验证通过，已开始参与该直播间。', 'Room verified and participation started.'))
      return true
    })
  const removeRoom = (id: string) =>
    action(`room:${id}`, async () => {
      requireSuccess(await window.api.room.remove(id))
      rooms.value = rooms.value.filter((room) => room.id !== id)
      await refreshStats()
      return true
    })
  const startAutoRun = (options: { sourceUrl?: string; stopAfterMinutes?: number } = {}) =>
    action('start', async () => {
      const result = await window.api.autoRun.start(options)
      autoRunState.value = result.state
      requireSuccess(result)
      notify(tr('运行已启动。', 'Run started.'))
      return true
    })
  const stopAutoRun = () =>
    action('stop', async () => {
      const result = await window.api.autoRun.stop()
      autoRunState.value = result.state
      requireSuccess(result)
      await refreshAccount()
      notify(tr('已停止，后续自动恢复已取消。', 'Stopped. Scheduled resume is cancelled.'))
      return true
    })
  const updateConfig = (partial: Partial<AppConfig>) =>
    action('save', async () => {
      const result = await window.api.config.set(partial)
      requireSuccess(result)
      config.value = result.config || (await window.api.config.get())
      await Promise.all([refreshStats(), refreshInsights()])
      return true
    })
  const resetRunStats = () =>
    action('reset', async () => {
      runStats.value = await window.api.runStats.reset()
      await Promise.all([refreshStats(), refreshInsights()])
      notify(
        tr('展示统计已重置，支出账本保持不变。', 'Display totals reset. The spending ledger is unchanged.')
      )
      return true
    })
  return {
    ready,
    isLoggedIn,
    rooms,
    config,
    logs,
    stats,
    runStats,
    autoRunState,
    insights,
    busy,
    notice,
    notify,
    action,
    requireSuccess,
    login,
    logout,
    addRoom,
    removeRoom,
    startAutoRun,
    stopAutoRun,
    updateConfig,
    resetRunStats,
    refreshInsights,
    retry: () => action('initialize', refreshAccount)
  }
}
