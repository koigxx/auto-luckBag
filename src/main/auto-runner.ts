import {
  DiscoveryService,
  DiscoveredRoom,
  VerifiedFudaiRoom,
  VerifyRoomResult
} from './discovery-service'
import { RoomManager } from './room-manager'
import { StatsService } from './stats-service'
import { logError, logInfo } from './logger'
import { store } from './store'

export interface AutoRunOptions {
  sourceUrl?: string
  scanIntervalSeconds?: number
  stopAfterMinutes?: number
  enterBeforeSeconds?: number
  candidatePoolLimit?: number
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

const DEFAULT_SOURCE_URL = ''
const DEFAULT_SCAN_INTERVAL_SECONDS = 40
const MIN_ENTER_BEFORE_SECONDS = 60
const DEFAULT_ENTER_BEFORE_SECONDS = 75
const MAX_PENDING_VERIFY = 5
const MAX_CANDIDATES = 5
const DEFAULT_CANDIDATE_POOL_LIMIT = 4
const RISK_PAUSE_MS = 10 * 60 * 1000
const CANDIDATE_TTL_MS = 30 * 60 * 1000
const REJECTED_CANDIDATE_TTL_MS = 30 * 60 * 1000
const VERIFY_DIRECT_ENTER_MIN_RATIO = 0.6
const AFTER_DRAW_RESUME_BUFFER_SECONDS = 5
const RECHECK_CANDIDATE_TTL_MS = 8 * 60 * 1000
const SCAN_OPERATION_TIMEOUT_MS = 75_000
const VERIFY_OPERATION_TIMEOUT_MS = 150_000
const DUE_ENTER_GUARD_SECONDS = 10

interface RecheckCandidate {
  room: DiscoveredRoom
  availableAt: number
}

export class AutoRunner {
  private discoveryService: DiscoveryService
  private roomManager: RoomManager
  private statsService: StatsService
  private timer: NodeJS.Timeout | null = null
  private stopTimer: NodeJS.Timeout | null = null
  private updateTimer: NodeJS.Timeout | null = null
  private cycleRunning = false
  private pendingVerify: DiscoveredRoom[] = []
  private recheckQueue: RecheckCandidate[] = []
  private rejectedUntil: Map<string, number> = new Map()
  private candidatePool: Map<string, VerifiedFudaiRoom> = new Map()
  private lastActiveRoomWaitLogAt = 0
  private lastPendingVerifyLogAt = 0
  private state: AutoRunState = {
    running: false,
    status: 'stopped',
    sourceUrl: DEFAULT_SOURCE_URL,
    scanIntervalSeconds: DEFAULT_SCAN_INTERVAL_SECONDS,
    stopAt: null,
    startedAt: null,
    lastScanAt: null,
    nextScanAt: null,
    candidateCount: 0,
    pendingVerifyCount: 0,
    enterBeforeSeconds: DEFAULT_ENTER_BEFORE_SECONDS,
    candidatePoolLimit: DEFAULT_CANDIDATE_POOL_LIMIT,
    candidates: [],
    riskPausedUntil: null,
    lastRiskReason: ''
  }
  private onLog: ((message: string) => void) | null = null
  private onUpdate: ((state: AutoRunState) => void) | null = null

  constructor(
    discoveryService: DiscoveryService,
    roomManager: RoomManager,
    statsService: StatsService
  ) {
    this.discoveryService = discoveryService
    this.roomManager = roomManager
    this.statsService = statsService
  }

  setCallbacks(onLog: (message: string) => void, onUpdate: (state: AutoRunState) => void): void {
    this.onLog = onLog
    this.onUpdate = onUpdate
  }

  async start(options: AutoRunOptions = {}): Promise<AutoRunState> {
    if (this.state.running) return this.getState()

    this.pendingVerify = []
    this.recheckQueue = []
    this.candidatePool.clear()
    this.rejectedUntil.clear()

    const scanIntervalSeconds = Math.max(
      30,
      options.scanIntervalSeconds || store.get('scanIntervalSeconds') || DEFAULT_SCAN_INTERVAL_SECONDS
    )
    const enterBeforeSeconds = Math.max(
      MIN_ENTER_BEFORE_SECONDS,
      options.enterBeforeSeconds || store.get('enterBeforeSeconds') || DEFAULT_ENTER_BEFORE_SECONDS
    )
    const candidatePoolLimit = Math.min(
      MAX_CANDIDATES,
      Math.max(1, options.candidatePoolLimit || store.get('candidatePoolLimit') || DEFAULT_CANDIDATE_POOL_LIMIT)
    )
    const sourceUrl = options.sourceUrl?.trim() || DEFAULT_SOURCE_URL
    const startedAt = Date.now()
    const stopAt = options.stopAfterMinutes
      ? startedAt + Math.max(1, options.stopAfterMinutes) * 60 * 1000
      : null

    this.state = {
      running: true,
      status: 'waiting',
      sourceUrl,
      scanIntervalSeconds,
      stopAt,
      startedAt,
      lastScanAt: null,
      nextScanAt: startedAt,
      candidateCount: 0,
      pendingVerifyCount: 0,
      enterBeforeSeconds,
      candidatePoolLimit,
      candidates: [],
      riskPausedUntil: null,
      lastRiskReason: ''
    }

    this.statsService.markStarted()
    this.log(`自动运行已启动：约每 ${scanIntervalSeconds} 秒验证 1 个候选，开奖前 ${enterBeforeSeconds} 秒进房，候选池最多 ${candidatePoolLimit} 个`)
    this.emitUpdate()

    if (stopAt) {
      this.stopTimer = setTimeout(() => {
        void this.stop('定时停止')
      }, Math.max(0, stopAt - Date.now()))
    }

    this.startUpdateTimer()
    void this.runCycle()
    return this.getState()
  }

  async stop(reason = '手动停止'): Promise<AutoRunState> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    if (this.updateTimer) {
      clearInterval(this.updateTimer)
      this.updateTimer = null
    }

    const wasRunning = this.state.running
    if (wasRunning) {
      this.log(`自动运行已停止：${reason}`)
      this.statsService.markStopped()
    }

    this.pendingVerify = []
    this.recheckQueue = []
    this.candidatePool.clear()
    this.rejectedUntil.clear()

    this.state = {
      ...this.state,
      running: false,
      status: 'stopped',
      stopAt: null,
      nextScanAt: null,
      candidateCount: 0,
      pendingVerifyCount: 0,
      candidates: []
    }

    try {
      await this.discoveryService.close()
      await this.roomManager.closeAllRooms()
    } catch (e: any) {
      this.log(`停止直播间失败：${e.message}`)
      logError('auto-run', 'stop rooms failed', e)
    }

    this.emitUpdate()
    return this.getState()
  }

  getState(): AutoRunState {
    this.pruneCandidatePool()
    return {
      ...this.state,
      candidateCount: this.candidatePool.size,
      pendingVerifyCount: this.pendingVerify.length,
      candidates: this.getCandidateSnapshot()
    }
  }

  private async runCycle(): Promise<void> {
    if (!this.state.running || this.cycleRunning) return
    this.cycleRunning = true

    try {
      this.prunePools()

      if (this.pauseForActiveRoom()) return
      if (false && this.roomManager.getAllRooms().length > 0) {
        if (Date.now() - this.lastActiveRoomWaitLogAt > 30_000) {
          this.lastActiveRoomWaitLogAt = Date.now()
          this.log('已有直播间正在处理或等待开奖，暂停新的扫描、验证和进房')
        }
        this.setStatus('waiting')
        this.scheduleNext(1)
        return
      }
      this.lastActiveRoomWaitLogAt = 0
      if (false && this.roomManager.getAllRooms().length > 0) {
        this.setStatus('waiting')
        this.log('已有直播间正在处理或等待开奖，暂停新的扫描、验证和进房')
        this.scheduleNext(1)
        return
      }

      const enteredBeforeWork = await this.enterDueRooms()
      if (!this.state.running) return
      if (enteredBeforeWork > 0) {
        this.scheduleNext(10)
        return
      }

      if (this.isRiskPaused()) {
        this.setStatus('pausedByRisk')
        const waitSeconds = Math.max(15, Math.ceil(((this.state.riskPausedUntil || 0) - Date.now()) / 1000))
        this.log(`风控冷却中：约 ${waitSeconds} 秒后恢复，原因=${this.state.lastRiskReason}`)
        this.scheduleNext(Math.min(waitSeconds, 60))
        return
      }

      if (this.hasPendingEnterWindow()) {
        this.setStatus('waiting')
        this.log('候选即将到达提前进房时间，直接进入开奖直播间')
        const entered = await this.enterDueRooms(true)
        if (!this.state.running) return
        this.scheduleNext(entered > 0 ? 10 : 1)
        return
      }

      this.promoteDueRecheckCandidates()

      if (this.pendingVerify.length === 0) {
        this.lastPendingVerifyLogAt = 0
        await this.scanForCandidates()
        if (!this.state.running) return
        if (this.pauseForActiveRoom()) return
      } else {
        if (Date.now() - this.lastPendingVerifyLogAt > 60_000) {
          this.lastPendingVerifyLogAt = Date.now()
          this.log(`待验证队列还有 ${this.pendingVerify.length} 个候选，本轮不重复扫描入口页；验证进房仍按风控间隔串行执行`)
        }
      }

      if (!this.hasPendingEnterWindow()) {
        if (this.pauseForActiveRoom()) return
        const waitAfterVerifySeconds = await this.verifyNextCandidate()
        if (!this.state.running) return
        if (this.pauseForActiveRoom()) return
        if (waitAfterVerifySeconds > 0) {
          this.scheduleNext(waitAfterVerifySeconds)
          return
        }
      }

      const enteredAfterWork = await this.enterDueRooms()
      if (!this.state.running) return
      this.log(
        `本轮完成：待验证=${this.pendingVerify.length}，候选池=${this.candidatePool.size}，进入=${enteredAfterWork}`
      )
      this.scheduleNext(this.getNextCycleDelaySeconds(this.state.scanIntervalSeconds))
    } catch (e: any) {
      this.log(`自动运行异常：${e.message}`)
      logError('auto-run', 'cycle failed', e)
      this.scheduleNext(30)
    } finally {
      this.cycleRunning = false
      this.emitUpdate()
    }
  }

  private async scanForCandidates(): Promise<void> {
    this.setStatus('discovering')
    this.state = { ...this.state, lastScanAt: Date.now() }
    this.emitUpdate()

    logInfo('auto-run', `scan source=${this.state.sourceUrl || 'default'}`)
    const scanResult = await this.withTimeout(
      this.discoveryService.scan({
        sourceUrl: this.state.sourceUrl || undefined,
        maxRooms: MAX_PENDING_VERIFY * 2
      }),
      SCAN_OPERATION_TIMEOUT_MS,
      '扫描直播入口超时'
    )
    if (!scanResult.ok) {
      this.log(`${scanResult.message}，本轮跳过扫描`)
      await this.discoveryService.closeCurrentPage().catch(() => {})
      return
    }
    const discoveredRooms = scanResult.value
    if (!this.state.running) return

    const now = Date.now()
    const preferredUrls = new Set((store.get('preferredRooms') || []).map((room) => room.url))
    const newRooms = discoveredRooms.filter(
      (room) =>
        !this.roomManager.hasRoom(room.url) &&
        !this.candidatePool.has(room.url) &&
        !this.pendingVerify.some((pending) => pending.url === room.url) &&
        !this.recheckQueue.some((pending) => pending.room.url === room.url) &&
        (this.rejectedUntil.get(room.url) || 0) <= now
    ).sort((a, b) => Number(preferredUrls.has(b.url)) - Number(preferredUrls.has(a.url)))

    let addedToVerify = 0
    for (const room of newRooms) {
      if (this.pendingVerify.length >= MAX_PENDING_VERIFY) break
      this.pendingVerify.push(room)
      addedToVerify += 1
    }
    this.sortPendingVerify()
    this.log(`扫描完成：发现 ${discoveredRooms.length} 个候选，加入待验证 ${addedToVerify} 个，待验证总数 ${this.pendingVerify.length}`)
  }

  private async verifyNextCandidate(): Promise<number> {
    const candidate = this.pendingVerify.shift()
    if (!candidate) {
      this.setStatus('waiting')
      return 0
    }
    if (this.roomManager.hasRoom(candidate.url) || this.candidatePool.has(candidate.url)) {
      return 0
    }

    this.setStatus('verifying')
    const verifyResult = await this.withTimeout(
      this.discoveryService.verifyRoom(candidate, {
        keepPageOnVerified: true,
        minDwellMs: Math.floor(this.state.scanIntervalSeconds * 1000 * 0.2)
      }),
      VERIFY_OPERATION_TIMEOUT_MS,
      `验证候选超时：${candidate.name || candidate.url}`
    )
    if (!verifyResult.ok) {
      await this.discoveryService.closeCurrentPage().catch(() => {})
      this.rejectedUntil.set(candidate.url, Date.now() + REJECTED_CANDIDATE_TTL_MS)
      this.log(`${verifyResult.message}，候选冷却 30 分钟`)
      return 0
    }
    const result: VerifyRoomResult = verifyResult.value
    if (!this.state.running) {
      await this.closeVerificationPage(result)
      return 0
    }
    if (result.riskDetected) {
      await this.closeVerificationPage(result)
      this.pendingVerify.unshift(candidate)
      this.pauseForRisk(result.riskReason)
      return 0
    }

    if (result.room) {
      const remainingSeconds = this.currentRemainingSeconds(result.room)
      if (!this.hasReliableCountdown(result.room)) {
        await this.closeVerificationPage(result)
        this.addRecheckCandidate(result.room)
        this.log(
          `识别到疑似福袋但未获得可靠开奖倒计时，加入复验队列：${result.room.name}，source=${result.room.countdownSource ?? 'unknown'}，confidence=${result.room.countdownConfidence}`
        )
        return 0
      }

      const directEnterThreshold = this.state.enterBeforeSeconds
      const directEnterLowerBound = Math.max(2, Math.floor(this.state.enterBeforeSeconds * VERIFY_DIRECT_ENTER_MIN_RATIO))
      if (
        remainingSeconds !== null &&
        remainingSeconds > directEnterLowerBound &&
        remainingSeconds <= directEnterThreshold
      ) {
        if (!this.hasDiamondBudgetForRoom(result.room)) {
          await this.closeVerificationPage(result)
          this.log(`钻石预算已达上限，跳过需要粉丝团的临近开奖直播间：${result.room.name}`)
          return 0
        }
        const conflict = this.findDrawTimeConflict(result.room)
        if (conflict) {
          this.log(
            `临近开奖直播间与现有福袋开奖时间接近，但当前剩余超过提前进房时间 60%，优先接管当前直播间：${result.room.name}，冲突=${conflict.name}，间隔=${conflict.diffSeconds}秒`
          )
        }
        if (!this.roomManager.hasCapacity()) {
          await this.closeVerificationPage(result)
          this.log('直播间监控数量已满，无法接管临近开奖候选')
          return 0
        }

        try {
          if (result.page && !result.page.isClosed()) {
            await this.roomManager.addRoomFromPage(result.page, result.room.url, result.room.name, {
              countdownText: result.room.countdownText,
              remainingSeconds,
              drawAt: result.room.drawAt
            })
          } else {
            await this.roomManager.addRoom(result.room.url, result.room.name, {
              countdownText: result.room.countdownText,
              remainingSeconds,
              drawAt: result.room.drawAt
            })
          }
          const waitSeconds = Math.max(10, remainingSeconds + AFTER_DRAW_RESUME_BUFFER_SECONDS)
          this.log(
            `验证时已临近开奖，直接在当前直播间参与：${result.room.name}，剩余=${remainingSeconds}秒，约 ${waitSeconds} 秒后继续搜索`
          )
          return waitSeconds
        } catch (e: any) {
          await this.closeVerificationPage(result)
          this.log(`接管临近开奖直播间失败：${e.message}`)
          logError('auto-run', 'direct enter verified room failed', e)
          return 0
        }
      }

      await this.closeVerificationPage(result)
      if (remainingSeconds !== null && remainingSeconds <= this.state.enterBeforeSeconds) {
        this.log(`候选已接近或错过提前进房窗口，未加入候选池：${result.room.name}，剩余=${remainingSeconds}秒`)
        return 0
      }
      if (!this.hasDiamondBudgetForRoom(result.room)) {
        this.log(`钻石预算已达上限，未加入需要粉丝团的候选：${result.room.name}`)
        return 0
      }
      const conflict = this.findDrawTimeConflict(result.room)
      if (conflict) {
        this.log(
          `候选与现有福袋开奖时间冲突，未加入候选池：${result.room.name}，冲突=${conflict.name}，间隔=${conflict.diffSeconds}秒`
        )
        return 0
      }
      this.candidatePool.set(result.room.url, result.room)
      this.trimCandidatePool()
      this.log(`已记录候选：${result.room.name}，剩余=${result.room.remainingSeconds ?? '未知'}秒，score=${result.room.score}`)
      return 0
    }

    await this.closeVerificationPage(result)
    this.rejectedUntil.set(candidate.url, Date.now() + REJECTED_CANDIDATE_TTL_MS)
    this.log(`候选已拒绝并冷却 30 分钟：${candidate.name || candidate.url}`)
    return 0
  }

  private async enterDueRooms(includeGuardWindow = false): Promise<number> {
    const dueRooms = this.getCandidateSnapshot().filter((room) => {
      const remainingSeconds = this.currentRemainingSeconds(room)
      const threshold = this.state.enterBeforeSeconds + (includeGuardWindow ? DUE_ENTER_GUARD_SECONDS : 0)
      return remainingSeconds !== null && remainingSeconds > 2 && remainingSeconds <= threshold
    })

    if (dueRooms.length === 0) return 0
    this.setStatus('entering')

    let entered = 0
    for (const room of dueRooms) {
      if (!this.roomManager.hasCapacity()) {
        this.log('直播间监控数量已满，跳过更多进房')
        break
      }
      if (this.roomManager.hasRoom(room.url)) {
        this.candidatePool.delete(room.url)
        continue
      }

      const remainingSeconds = this.currentRemainingSeconds(room)
      try {
        await this.roomManager.addRoom(room.url, room.name, {
          countdownText: room.countdownText,
          remainingSeconds,
          drawAt: room.drawAt
        })
        this.candidatePool.delete(room.url)
        entered++
        this.log(`进入临近开奖直播间：${room.name}，剩余=${remainingSeconds ?? '未知'}秒`)
      } catch (e: any) {
        this.log(`进入临近开奖直播间失败：${e.message}`)
        logError('auto-run', 'enter due room failed', e)
      }
    }

    return entered
  }

  private scheduleNext(delaySeconds: number): void {
    if (!this.state.running) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    const normalizedDelaySeconds = Math.max(1, Math.ceil(delaySeconds))
    const nextScanAt = Date.now() + normalizedDelaySeconds * 1000
    this.state = {
      ...this.state,
      nextScanAt,
      candidateCount: this.candidatePool.size,
      pendingVerifyCount: this.pendingVerify.length,
      candidates: this.getCandidateSnapshot()
    }
    this.emitUpdate()

    this.timer = setTimeout(() => {
      void this.runCycle()
    }, normalizedDelaySeconds * 1000)
  }

  private pauseForActiveRoom(): boolean {
    if (this.roomManager.getAllRooms().length === 0) {
      this.lastActiveRoomWaitLogAt = 0
      return false
    }

    if (Date.now() - this.lastActiveRoomWaitLogAt > 30_000) {
      this.lastActiveRoomWaitLogAt = Date.now()
      this.log('已有直播间正在处理或等待开奖，暂停新的扫描、验证和进房')
    }
    this.setStatus('waiting')
    this.scheduleNext(5)
    return true
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
  ): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
    let timer: NodeJS.Timeout | null = null
    try {
      const value = await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        })
      ])
      return { ok: true, value }
    } catch (e: any) {
      return { ok: false, message: e?.message || message }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private getNextCycleDelaySeconds(defaultDelaySeconds: number): number {
    let nextDelaySeconds = defaultDelaySeconds

    for (const room of this.candidatePool.values()) {
      const remainingSeconds = this.currentRemainingSeconds(room)
      if (remainingSeconds === null) continue
      const secondsUntilEnter = remainingSeconds - this.state.enterBeforeSeconds
      if (secondsUntilEnter <= 0) return 1
      nextDelaySeconds = Math.min(nextDelaySeconds, secondsUntilEnter)
    }

    return Math.max(1, Math.ceil(nextDelaySeconds))
  }

  private startUpdateTimer(): void {
    if (this.updateTimer) clearInterval(this.updateTimer)
    this.updateTimer = setInterval(() => {
      if (!this.state.running) return
      if (this.candidatePool.size > 0) this.emitUpdate()
    }, 1000)
    this.updateTimer.unref?.()
  }

  private pauseForRisk(reason: string): void {
    const riskPausedUntil = Date.now() + RISK_PAUSE_MS
    this.state = {
      ...this.state,
      status: 'pausedByRisk',
      riskPausedUntil,
      lastRiskReason: reason || '疑似风控'
    }
    this.log(`检测到风控信号，暂停扫描和验证 10 分钟：${this.state.lastRiskReason}`)
    this.emitUpdate()
  }

  private async closeVerificationPage(result: VerifyRoomResult): Promise<void> {
    if (result.page && !result.page.isClosed()) {
      await result.page.close().catch(() => {})
    }
  }

  private scheduleRoomRemovalAfterDraw(roomId: string, roomName: string, delaySeconds: number): void {
    const timer = setTimeout(() => {
      void (async () => {
        const room = this.roomManager.getRoom(roomId)
        if (!room) return
        this.log(`开奖等待结束，移除直播间并继续后续队列：${roomName}`)
        await this.roomManager.removeRoom(roomId).catch((e: any) => {
          this.log(`移除开奖后直播间失败：${e.message}`)
        })
      })()
    }, delaySeconds * 1000)
    timer.unref?.()
  }

  private isRiskPaused(): boolean {
    return Boolean(this.state.riskPausedUntil && this.state.riskPausedUntil > Date.now())
  }

  private hasPendingEnterWindow(): boolean {
    for (const room of this.candidatePool.values()) {
      const remainingSeconds = this.currentRemainingSeconds(room)
      if (remainingSeconds === null) continue

      const secondsUntilEnter = remainingSeconds - this.state.enterBeforeSeconds
      if (secondsUntilEnter > 0 && secondsUntilEnter <= DUE_ENTER_GUARD_SECONDS) {
        return true
      }
    }

    return false
  }

  private findDrawTimeConflict(room: VerifiedFudaiRoom): { name: string; diffSeconds: number } | null {
    const roomDrawAt = this.estimateDrawAt(room)
    if (roomDrawAt === null) return null

    for (const existing of this.candidatePool.values()) {
      if (existing.url === room.url) continue
      const existingDrawAt = this.estimateDrawAt(existing)
      if (existingDrawAt === null) continue
      const diffSeconds = Math.floor(Math.abs(roomDrawAt - existingDrawAt) / 1000)
      if (diffSeconds < this.state.enterBeforeSeconds) {
        return { name: existing.name, diffSeconds }
      }
    }

    for (const existing of this.roomManager.getAllRooms()) {
      if (existing.url === room.url) continue
      const existingDrawAt =
        typeof existing.drawAt === 'number' && existing.drawAt > 0
          ? existing.drawAt
          : typeof existing.remainingSeconds === 'number' && existing.remainingSeconds > 0
            ? Date.now() + Math.max(0, existing.remainingSeconds) * 1000
            : null
      if (existingDrawAt === null) continue
      const diffSeconds = Math.floor(Math.abs(roomDrawAt - existingDrawAt) / 1000)
      if (diffSeconds < this.state.enterBeforeSeconds) {
        return { name: existing.name, diffSeconds }
      }
    }

    return null
  }

  private estimateDrawAt(room: VerifiedFudaiRoom): number | null {
    if (typeof room.drawAt === 'number' && room.drawAt > Date.now()) return room.drawAt
    const remainingSeconds = this.currentRemainingSeconds(room)
    if (remainingSeconds === null || remainingSeconds <= 0) return null
    return Date.now() + remainingSeconds * 1000
  }

  private currentRemainingSeconds(room: VerifiedFudaiRoom): number | null {
    if (typeof room.drawAt === 'number' && room.drawAt > 0) {
      return Math.max(0, Math.ceil((room.drawAt - Date.now()) / 1000))
    }
    if (room.remainingSeconds === null) return null
    const elapsedSeconds = Math.floor((Date.now() - room.verifiedAt) / 1000)
    return Math.max(0, room.remainingSeconds - elapsedSeconds)
  }

  private prunePools(): void {
    const now = Date.now()
    this.pruneCandidatePool(now)
    for (const [url, until] of this.rejectedUntil) {
      if (until <= now) this.rejectedUntil.delete(url)
    }
    this.pendingVerify = this.pendingVerify.filter(
      (room) =>
        !this.roomManager.hasRoom(room.url) &&
        !this.candidatePool.has(room.url) &&
        (this.rejectedUntil.get(room.url) || 0) <= now
    )
    this.recheckQueue = this.recheckQueue.filter(
      (item) =>
        item.availableAt > now - RECHECK_CANDIDATE_TTL_MS &&
        !this.roomManager.hasRoom(item.room.url) &&
        !this.candidatePool.has(item.room.url) &&
        (this.rejectedUntil.get(item.room.url) || 0) <= now
    )
  }

  private addRecheckCandidate(room: DiscoveredRoom): void {
    if (this.recheckQueue.some((item) => item.room.url === room.url)) return
    this.recheckQueue.push({
      room,
      availableAt: Date.now() + RECHECK_CANDIDATE_TTL_MS
    })
  }

  private pruneCandidatePool(now = Date.now()): void {
    for (const [url, room] of this.candidatePool) {
      const remainingSeconds = this.currentRemainingSeconds(room)
      const tooOld = now - room.verifiedAt > CANDIDATE_TTL_MS
      if ((remainingSeconds !== null && remainingSeconds <= 0) || tooOld || this.roomManager.hasRoom(url)) {
        this.candidatePool.delete(url)
      }
    }
  }

  private promoteDueRecheckCandidates(): void {
    if (this.pendingVerify.length >= MAX_PENDING_VERIFY) return
    const now = Date.now()
    const ready: RecheckCandidate[] = []
    const waiting: RecheckCandidate[] = []

    for (const item of this.recheckQueue) {
      if (item.availableAt <= now) ready.push(item)
      else waiting.push(item)
    }

    for (const item of ready) {
      if (this.pendingVerify.length >= MAX_PENDING_VERIFY) {
        waiting.push(item)
        continue
      }
      this.pendingVerify.push(item.room)
      this.log(`复验候选重新进入待验证队列：${item.room.name || item.room.url}`)
    }

    this.recheckQueue = waiting
    this.sortPendingVerify()
  }

  private hasReliableCountdown(room: VerifiedFudaiRoom): boolean {
    const hasStructuredNetworkCountdown =
      room.countdownSource === 'network' && room.countdownConfidence === 'exact'
    const hasVisibleShortTouchCountdown = room.countdownSource === 'visible-dom'

    return (
      room.remainingSeconds !== null &&
      room.remainingSeconds > 0 &&
      (hasStructuredNetworkCountdown || hasVisibleShortTouchCountdown)
    )
  }

  private hasDiamondBudgetForRoom(room: VerifiedFudaiRoom): boolean {
    if (!this.requiresFanBadge(room)) return true
    const config = store.store
    const stats = store.get('runStats')
    const effectiveBudget = config.diamondBudget + (config.allowDiamondProfit ? stats.diamondWonAmount || 0 : 0)
    return config.diamondUsed < effectiveBudget
  }

  private requiresFanBadge(room: VerifiedFudaiRoom): boolean {
    return room.matchedSignals.includes('requires-fan-badge') || /粉丝团|灯牌|加入粉丝/.test(room.countdownText || '')
  }

  private trimCandidatePool(): void {
    const rooms = this.getCandidateSnapshot()
    while (rooms.length > this.state.candidatePoolLimit) {
      const room = rooms.pop()
      if (!room) break
      this.candidatePool.delete(room.url)
    }
  }

  private sortPendingVerify(): void {
    this.pendingVerify.sort((a, b) => {
      const left = a.remainingSeconds
      const right = b.remainingSeconds
      if (left === null && right === null) return 0
      if (left === null) return 1
      if (right === null) return -1
      return left - right
    })
  }

  private getCandidateSnapshot(): VerifiedFudaiRoom[] {
    this.pruneCandidatePool()
    return Array.from(this.candidatePool.values()).map((room) => ({
      ...room,
      remainingSeconds: this.currentRemainingSeconds(room)
    })).sort((a, b) => {
      const left = a.remainingSeconds
      const right = b.remainingSeconds
      if (left === null && right === null) return b.verifiedAt - a.verifiedAt
      if (left === null) return 1
      if (right === null) return -1
      return left - right
    })
  }

  private setStatus(status: AutoRunStatus): void {
    this.state = {
      ...this.state,
      status,
      candidateCount: this.candidatePool.size,
      pendingVerifyCount: this.pendingVerify.length,
      candidates: this.getCandidateSnapshot()
    }
    this.emitUpdate()
  }

  private log(message: string): void {
    logInfo('auto-run', message)
    this.onLog?.(message)
  }

  private emitUpdate(): void {
    this.onUpdate?.(this.getState())
  }
}
