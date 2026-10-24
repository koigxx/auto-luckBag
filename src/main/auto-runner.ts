import type { DiscoveryService, DiscoveredRoom, VerifiedFudaiRoom } from './discovery-service'
import type { RoomManager } from './room-manager'
import type { StatsService } from './stats-service'
import { evaluate, bestSchedule, rankHistory, Evaluation } from './strategy'
import { seededRandom } from './session-engine'
import { Opportunity, emptySession, HISTORY_STARTUP_FRESHNESS_MS, VERIFICATION_MAX_SECONDS, RETURN_PREPARATION_SECONDS } from '../shared/policy'
import type { Policy } from '../shared/policy'
import type { AppConfig } from '../shared/config'
import type { ExecutionGate } from './execution-gate'
import type { RuntimeRepository } from './runtime-repository'
import type { SessionEngine } from './session-engine'
import { navigationQuotaReadyAt, navigationSpacingReadyAt } from './execution-gate'

export interface AutoRunnerEnvironment {
  execution: ExecutionGate
  repository: RuntimeRepository
  sessionEngine: SessionEngine
  now: () => number
  policy: () => Policy
  haltPages: () => Promise<void>
  assertActive: (signal: AbortSignal, newWork?: boolean) => void
  paymentReason: (url: string, cost: number | null) => string | null
  store: {
    get: <K extends keyof AppConfig>(key: K) => AppConfig[K]
    set: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void
  }
  setTimer: (callback: () => void) => NodeJS.Timeout
  clearTimer: (timer: NodeJS.Timeout) => void
}

export interface AutoRunOptions {
  sourceUrl?: string
  scanIntervalSeconds?: number
  stopAfterMinutes?: number
  enterBeforeSeconds?: number
  candidatePoolLimit?: number
}
type Candidate = VerifiedFudaiRoom & { evaluation: Evaluation }
export class AutoRunner {
  private automatic = false
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private revision = 0
  private beginning = false
  private tickingRooms = false
  private pool: Candidate[] = []
  private pending: DiscoveredRoom[] = []
  private sourceUrl = 'https://live.douyin.com'
  private lastScanAt: number | null = null
  private nextScanAt = 0
  private retryAt = 0
  private historyFreshAfter = 0
  private waitingReason = ''
  private log: (text: string) => void = () => {}
  private update: (state: ReturnType<AutoRunner['getState']>) => void = () => {}
  private resumeCheck: () => Promise<boolean> = async () => false
  constructor(
    private discovery: Pick<DiscoveryService, 'scan' | 'verifyRoom' | 'close'>,
    private rooms: Pick<
      RoomManager,
      'setContinuationCheck' | 'getAllRooms' | 'tick' | 'addRoom' | 'addRoomFromPage' | 'closeAllRooms'
    >,
    private stats: Pick<StatsService, 'markStarted' | 'markStopped' | 'publish'>,
    private env: AutoRunnerEnvironment
  ) {
    rooms.setContinuationCheck((o, room) => this.continuationReason(o, room))
  }
  setResumeCheck(fn: () => Promise<boolean>): void {
    this.resumeCheck = fn
  }
  setCallbacks(
    log: (text: string) => void,
    update: (state: ReturnType<AutoRunner['getState']>) => void
  ): void {
    this.log = log
    this.update = update
  }
  getState() {
    const account = this.env.repository.read().activeAccount ? this.env.repository.account() : null,
      s = account?.session || emptySession()
    return {
      running: ['running', 'draining', 'resting', 'resume-check'].includes(s.phase),
      status: s.phase,
      automatic: this.automatic,
      sourceUrl: this.sourceUrl,
      scanIntervalSeconds: this.env.store.get('scanIntervalSeconds'),
      stopAt: s.stopAt,
      startedAt: s.startedAt,
      waitingReason: this.waitingReason,
      lastScanAt: this.lastScanAt,
      nextScanAt: s.phase === 'running' ? this.nextScanAt : null,
      candidateCount: this.pool.length,
      pendingVerifyCount: this.pending.length,
      enterBeforeSeconds: this.env.store.get('enterBeforeSeconds'),
      candidatePoolLimit: this.env.store.get('candidatePoolLimit'),
      candidates: this.pool.map((r) => ({
        url: r.url,
        name: r.name,
        score: Number(r.evaluation.score.toFixed(3)),
        reason: r.evaluation.reason,
        probability: r.evaluation.probability,
        mode: r.evaluation.mode,
        entryRemainingSeconds: Math.max(0, Math.ceil((r.evaluation.startAt - this.env.now()) / 1000)),
        drawAt: r.drawAt,
        remainingSeconds: r.drawAt ? Math.max(0, Math.ceil((r.drawAt - this.env.now()) / 1000)) : null
      })),
      riskPausedUntil: null,
      lastRiskReason: account?.risks.find((r) => r.resolvedAt === null)?.reason || '',
      session: s,
      resumeRemainingSeconds:
        s.nextResumeAt === null ? null : Math.max(0, Math.ceil((s.nextResumeAt - this.env.now()) / 1000))
    }
  }
  async start(options: AutoRunOptions = {}): Promise<ReturnType<AutoRunner['getState']>> {
    if (this.getState().running || this.beginning || this.busy)
      throw new Error('运行、休息或收尾操作尚未结束，请稍后再试')
    this.validateOptions(options)
    const revision = ++this.revision
    this.beginning = true
    try {
      if (!(await this.resumeCheck())) throw new Error('登录状态已过期，请重新登录')
    } finally {
      this.beginning = false
    }
    if (revision !== this.revision) throw new Error('启动已取消')
    this.sourceUrl = options.sourceUrl || 'https://live.douyin.com'
    // Freeze this cutoff for the run. Planned rest/resume keeps it, while a
    // manual restart re-evaluates stale discovery without deleting user data.
    this.historyFreshAfter = this.env.now() - HISTORY_STARTUP_FRESHNESS_MS
    this.env.sessionEngine.start(
      this.env.policy(),
      options.stopAfterMinutes ? this.env.now() + options.stopAfterMinutes * 60000 : null
    )
    this.env.execution.start()
    this.automatic = true
    this.pool = []
    this.pending = []
    this.nextScanAt = this.env.now()
    this.retryAt = 0
    this.waitingReason = ''
    if (Object.values(this.env.repository.account().rooms).some(
      (r) => r.visits.length > 0 && r.lastSeenAt < this.historyFreshAfter
    )) this.log('已排除超过30分钟未验证的历史房间；重新发现后仍可验证，收藏与账本保留')
    this.stats.markStarted()
    this.startTimer()
    this.publish()
    return this.getState()
  }
  async ensureManual(): Promise<void> {
    const s = this.env.repository.account().session
    if (s.phase === 'running') {
      this.env.assertActive(this.env.execution.signal, true)
      return
    }
    if (s.phase !== 'stopped') throw new Error('当前正在休息、收尾或风险暂停，不能手动绕过')
    if (this.beginning || this.busy) throw new Error('正在检查运行条件或收尾，请稍后')
    const revision = ++this.revision
    this.beginning = true
    try {
      if (!(await this.resumeCheck())) throw new Error('请重新登录')
    } finally {
      this.beginning = false
    }
    if (revision !== this.revision) throw new Error('启动已取消')
    this.env.sessionEngine.start(this.env.policy())
    this.env.execution.start()
    this.automatic = false
    this.startTimer()
  }
  private startTimer(): void {
    if (this.timer) this.env.clearTimer(this.timer)
    this.timer = this.env.setTimer(() => {
      void this.pulse().catch((e) => this.log(e.message))
    })
  }
  async stop(reason = '手动停止'): Promise<ReturnType<AutoRunner['getState']>> {
    this.revision++
    this.automatic = false
    if (this.timer) {
      this.env.clearTimer(this.timer)
      this.timer = null
    }
    if (this.env.repository.read().activeAccount) this.env.sessionEngine.stop(reason)
    this.env.execution.stop()
    this.pool = []
    this.pending = []
    this.waitingReason = ''
    this.retryAt = 0
    await this.env.haltPages()
    await this.discovery.close()
    await this.rooms.closeAllRooms()
    this.stats.markStopped()
    this.publish()
    return this.getState()
  }
  async pulse(): Promise<void> {
    if (!this.env.repository.read().activeAccount) return
    const before = this.env.repository.account().session.phase
    const s = this.env.sessionEngine.tick(this.rooms.getAllRooms().length > 0)
    if (!['running', 'draining'].includes(s.phase)) {
      if (!this.env.execution.signal.aborted) {
        this.pool = []
        this.pending = []
        await this.env.haltPages()
      }
      if (s.phase === 'resume-check' && !this.busy) {
        this.busy = true
        const revision = this.revision
        try {
          if (!(await this.resumeCheck())) throw new Error('恢复前登录检查失败，请重新登录')
          if (revision !== this.revision || this.env.repository.account().session.phase !== 'resume-check')
            return
          // Start validates risk, unresolved charges, allowed hours and remaining daily duration again.
          this.env.sessionEngine.start(this.env.policy(), s.stopAt)
          this.env.execution.start()
          this.nextScanAt = this.env.now()
          this.retryAt = 0
          this.waitingReason = ''
          this.log('休息结束，检查通过，开始新的运行时段')
        } catch (e: any) {
          if (revision === this.revision) {
            this.env.sessionEngine.stop(e.message)
            this.automatic = false
          }
        } finally {
          this.busy = false
        }
      }
      if (['blocked', 'stopped'].includes(s.phase)) {
        this.automatic = false
        if (this.timer) {
          this.env.clearTimer(this.timer)
          this.timer = null
        }
      }
    } else {
      if (!this.tickingRooms) {
        this.tickingRooms = true
        void this.rooms
          .tick()
          .finally(() => {
            this.tickingRooms = false
          })
          .catch((e) => this.log(e.message))
      }
      if (s.phase === 'running' && this.automatic && !this.busy && this.rooms.getAllRooms().length === 0) {
        this.busy = true
        const signal = this.env.execution.signal
        void this.cycle()
          .catch((e) => {
            if (!signal.aborted) {
              this.log(`本轮调度：${e.message}`)
              this.retryAt = this.env.now() + this.env.store.get('scanIntervalSeconds') * 1000
              this.waitingReason = '本轮操作异常，等待重试'
            }
          })
          .finally(() => {
            this.busy = false
          })
      }
    }
    if (before !== this.env.repository.account().session.phase)
      this.log(this.env.repository.account().session.reason)
    this.stats.publish()
    this.publish()
  }
  private assessment(room: VerifiedFudaiRoom, open = false): Evaluation {
    const a = this.env.repository.account(),
      p = this.env.policy(),
      records = Object.values(a.rounds).filter((r) => r.roomUrl === room.url)
    const e = evaluate(room.opportunity, p, this.env.now(), a.rooms[room.url], records, open)
    if (!e.feasible) return e
    const types = this.env.store.get('fudaiTypes'),
      o = room.opportunity
    const typeOk =
      types.all ||
      (o.prizeType === 'physical' && types.physical) ||
      (o.prizeType === 'diamond' && types.diamond)
    const reason = !typeOk
      ? '未启用该奖品类型'
      : this.env.paymentReason(room.url, o.cost) ||
        (!this.env.sessionEngine.canFinish(o.drawAt || 0) ? '无法在本时段结束前完成' : null)
    if (reason) return { ...e, feasible: false, reason }
    // The lead covers loading, revalidation and tasks. Navigation spacing is
    // reserved separately by the scheduler, never added again to task time.
    if (!open) {
      e.leadSeconds = Math.max(e.leadSeconds, this.env.store.get('enterBeforeSeconds') + RETURN_PREPARATION_SECONDS)
      e.startAt = (o.drawAt || 0) - e.leadSeconds * 1000
    }
    return e
  }
  private wait(reason: string): false {
    if (this.waitingReason !== reason) {
      this.waitingReason = reason
      if (reason) this.log(reason)
    }
    return false
  }
  private canNavigate(fresh: boolean): boolean {
    const ready = navigationQuotaReadyAt(
      this.env.repository.account().navigations,
      this.env.policy(),
      this.env.now(),
      fresh
    )
    if (ready <= this.env.now()) return true
    this.wait(
      Number.isFinite(ready)
        ? `导航或新房探索小时额度已用完，${new Date(ready).toLocaleTimeString('zh-CN', { timeZone: this.env.policy().timezone, hour12: false })} 后再检查`
        : '导航或新房探索额度为 0，等待调整设置后重新启动'
    )
    return false
  }
  private async cycle(): Promise<boolean> {
    const signal = this.env.execution.signal
    this.env.assertActive(signal, true)
    this.pool = this.pool.filter((r) => {
      if (r.drawAt !== null && r.drawAt > this.env.now()) return true
      this.env.repository.decision({
        url: r.url,
        action: 'skip',
        reason: '候选已过开奖时间',
        score: null,
        probability: null
      })
      this.log(`跳过 ${r.name}：候选已过开奖时间`)
      return false
    })
    const due = this.pool.find((r) => r.evaluation.startAt <= this.env.now())
    if (due) {
      if (!this.canNavigate(false)) return false
      this.pool = this.pool.filter((r) => r !== due)
      this.wait('')
      this.log(`候选到时复验 ${due.name}，重新确认本轮任务与费用`)
      return this.verifyAndSchedule(due, true)
    }
    if (this.env.now() < this.retryAt) return false
    // Do not start a verification that would occupy the next reservation's entry interval.
    const now = this.env.now(), policy = this.env.policy(), account = this.env.repository.account()
    const nextNavigation = navigationSpacingReadyAt(account.navigations,
      'https://live.douyin.com/12345678', policy.navigationMaxSeconds * 1000, now)
    if (this.pool.some(r => r.evaluation.startAt < nextNavigation +
        Math.max(policy.navigationMaxSeconds, VERIFICATION_MAX_SECONDS + 10) * 1000))
      return this.wait('等待候选预约进房，暂不验证其他房间')
    // Exploration must leave rolling-hour navigation slots for reserved returns.
    if (this.pool.length && account.navigations.filter(n => n.at > now - 3600000).length +
        this.pool.length >= policy.navigationsPerHour)
      return this.wait('保留候选返房导航额度，暂不探索新房')
    if (this.pool.length >= this.env.store.get('candidatePoolLimit'))
      return this.wait('候选池已满，等待预约进房')
    const a = this.env.repository.account(),
      rng = seededRandom(a.session.seed + a.decisions.length),
      p = this.env.policy()
    const history = rankHistory(Object.values(a.rooms), this.env.now(), p, rng).filter(
      (r) => r.visits.length > 0 && r.lastSeenAt >= this.historyFreshAfter && !this.pool.some((c) => c.url === r.url)
    )
    this.pending = this.pending.filter(
      (r) =>
        !a.rooms[r.url]?.blocked &&
        (a.rooms[r.url]?.nextEligibleCheckAt || 0) <= this.env.now() &&
        !this.pool.some((c) => c.url === r.url)
    )
    const recent = a.navigations.filter((n) => n.at > this.env.now() - 3600000),
      freshRatio = recent.length ? recent.filter((n) => n.fresh).length / recent.length : 0
    const explore = history.length === 0 || freshRatio < p.explorationRatio
    let candidate: DiscoveredRoom | undefined
    if (this.pending.length) candidate = this.pending[0]
    else if (!explore && history[0])
      candidate = {
        url: history[0].url,
        name: history[0].name,
        reason: '历史复访',
        countdownText: '',
        remainingSeconds: null
      }
    else candidate = this.pending[0]
    if (!candidate && history[0])
      candidate = {
        url: history[0].url,
        name: history[0].name,
        reason: '历史复访',
        countdownText: '',
        remainingSeconds: null
      }
    if (!candidate) {
      // No repeated source scanning while an unverified queue remains.
      if (this.env.now() < this.nextScanAt) return this.wait('等待下一次入口扫描')
      if (!this.canNavigate(false)) return false
      this.wait('')
      const scan = await this.discovery.scan({ sourceUrl: this.sourceUrl, maxRooms: 20 })
      this.env.assertActive(signal, true)
      this.lastScanAt = this.env.now()
      this.nextScanAt = this.lastScanAt + this.env.store.get('scanIntervalSeconds') * 1000
      this.pending = scan.rooms.filter(
        (r) =>
          !this.env.repository.account().rooms[r.url]?.blocked &&
          (this.env.repository.account().rooms[r.url]?.nextEligibleCheckAt || 0) <= this.env.now()
      )
      return true
    }
    const fresh = !a.rooms[candidate.url]?.visits.length
    // Check alternatives without emitting competing wait messages on every polling tick.
    if (
      fresh &&
      history[0] &&
      navigationQuotaReadyAt(a.navigations, p, this.env.now(), true) > this.env.now() &&
      navigationQuotaReadyAt(a.navigations, p, this.env.now(), false) <= this.env.now()
    ) {
      candidate = {
        url: history[0].url,
        name: history[0].name,
        reason: '历史复访',
        countdownText: '',
        remainingSeconds: null
      }
    }
    if (!this.canNavigate(!a.rooms[candidate.url]?.visits.length)) return false
    this.pending = this.pending.filter((r) => r.url !== candidate!.url)
    this.wait('')
    return this.verifyAndSchedule(candidate)
  }
  private async verifyAndSchedule(candidate: DiscoveredRoom, reserved = false): Promise<boolean> {
    const signal = this.env.execution.signal
    const result = await this.discovery.verifyRoom(candidate, { keepPageOnVerified: true, reserved })
    try {
      this.env.assertActive(signal, true)
      if (!result.room) return true
      const room = result.room,
        open = this.assessment(room, true),
        normal = this.assessment(room, false)
      const returnReadyAt = navigationSpacingReadyAt(this.env.repository.account().navigations,
        room.url, this.env.policy().navigationMaxSeconds * 1000, normal.startAt)
      const cannotReturnInTime = returnReadyAt > room.drawAt! - normal.leadSeconds * 1000
      const near =
        (room.drawAt! - this.env.now()) / 1000 <=
        Math.max(normal.leadSeconds, this.env.store.get('enterBeforeSeconds')) || cannotReturnInTime
      const direct = open.feasible && (near || (reserved && normal.startAt <= this.env.now())) && !!result.page
      // When already inside a near-draw room, report its actual task failure, not a second-navigation estimate.
      const e = !open.feasible || near ? open : normal
      if (e.feasible && near && !result.page) {
        e.feasible = false
        e.reason = '验证页面未保留，无法直接参与'
      }
      const a = this.env.repository.account()
      this.env.repository.decision({
        url: room.url,
        action: e.feasible ? (direct ? 'takeover' : 'candidate') : 'skip',
        reason: e.reason,
        score: e.score,
        probability: e.probability,
        seed: a.session.seed,
        snapshot: {
          version: 2,
          opportunity: room.opportunity,
          leadSeconds: e.leadSeconds,
          utility: e.utility,
          mode: e.mode,
          sampleCount: a.rooms[room.url]?.visits.length || 0
        }
      })
      if (!e.feasible) {
        this.log(`跳过 ${room.name}：${e.reason}`)
        return true
      }
      if (direct && result.page) {
        const immediate = { ...room, evaluation: { ...e, startAt: this.env.now() } }
        const choices = [...this.pool, immediate]
        const chosen = bestSchedule(choices, this.env.store.get('candidatePoolLimit'),
          this.env.policy().navigationMaxSeconds)
        if (!chosen.includes(immediate)) {
          this.log(`跳过 ${room.name}：与已预约候选冲突，保留可完成的参与组合`)
          this.env.repository.decision({url:room.url, action:'skip', reason:'与已预约候选时间或导航间隔冲突', score:e.score, probability:e.probability})
          return true
        }
        this.pool = chosen.filter(r => r !== immediate)
        this.log(
          `接管页面，准备参与 ${room.name}：剩余 ${Math.ceil((room.drawAt! - this.env.now()) / 1000)} 秒，继续校验弹窗身份与任务`
        )
        await this.rooms.addRoomFromPage(result.page, room.url, room.name, {
          opportunity: room.opportunity,
          observer: result.observer
        })
        result.page = undefined
        result.observer = undefined
        return true
      }
      const candidates = [...this.pool, { ...room, evaluation: e }]
      this.pool = bestSchedule(
        candidates,
        this.env.store.get('candidatePoolLimit'), this.env.policy().navigationMaxSeconds
      )
      this.log(
        this.pool.some((r) => r.url === room.url)
          ? `候选等待 ${room.name}：开奖前约 ${e.leadSeconds} 秒开始返房（加载、复验及调度预留 ${RETURN_PREPARATION_SECONDS} 秒），任务准备目标至少 ${e.leadSeconds - RETURN_PREPARATION_SECONDS} 秒`
          : `跳过 ${room.name}：与更优候选时间冲突或排序靠后`
      )
      return true
    } finally {
      result.observer?.close()
      await result.page?.close().catch(() => {})
    }
  }
  private continuationReason(o: Opportunity, room: {url:string;name:string}): string | null {
    if (!this.automatic) return null
    const candidate: VerifiedFudaiRoom = {
      ...room, opportunity:o, drawAt:o.drawAt, verifiedAt:this.env.now(), hasFudai:true,
      reason:'同房新一轮', remainingSeconds:Math.ceil((o.drawAt! - this.env.now()) / 1000),
      countdownText:'', score:0, matchedSignals:['已绑定本轮弹窗'],
      countdownSource:o.source === 'network' ? 'network' : 'visible-dom', countdownConfidence:o.confidence
    }
    const future = this.assessment(candidate)
    if (future.feasible && future.startAt > this.env.now()) {
      const scheduled = {...candidate, evaluation:future}
      this.pool = bestSchedule([...this.pool.filter(r=>r.url!==room.url), scheduled],
        this.env.store.get('candidatePoolLimit'), this.env.policy().navigationMaxSeconds)
      const kept = this.pool.includes(scheduled)
      const reason = kept ? '下一轮已加入预约队列，离房继续验证其他候选' : '下一轮与更优预约组合冲突，结束驻留'
      this.env.repository.decision({url:room.url,action:kept?'candidate':'skip',reason,score:future.score,probability:future.probability})
      this.log(`${room.name}：${reason}`)
      return reason
    }
    const p = this.env.policy(),
      e = evaluate(o, p, this.env.now(), undefined, [], true)
    const reserved = this.pool.some(r => r.evaluation.startAt < e.endAt)
    return reserved ? '已有预约候选，结束同房连轮并按预约顺序参与' : null
  }
  async manualScan(options: { sourceUrl?: string; maxRooms?: number }) {
    await this.ensureManual()
    if (this.busy || this.automatic || this.rooms.getAllRooms().length)
      throw new Error('当前任务占用调度器，请先停止或等待')
    this.busy = true
    try {
      return await this.discovery.scan(options)
    } finally {
      this.busy = false
    }
  }
  async manualRoom(url: string, name?: string) {
    await this.ensureManual()
    if (this.busy || this.automatic || this.rooms.getAllRooms().length)
      throw new Error('低频串行模式下请先结束当前任务')
    this.busy = true
    const signal = this.env.execution.signal
    let result: Awaited<ReturnType<DiscoveryService['verifyRoom']>> | undefined
    try {
      result = await this.discovery.verifyRoom(
        { url, name: name || url, reason: '手动选择', remainingSeconds: null, countdownText: '' },
        { keepPageOnVerified: true }
      )
      this.env.assertActive(signal, true)
      if (!result.room || !result.page) throw new Error(result.riskReason || '未确认有效福袋')
      const e = this.assessment(result.room, true)
      if (!e.feasible) throw new Error(e.reason)
      const room = await this.rooms.addRoomFromPage(result.page, url, name, {
        opportunity: result.room.opportunity,
        observer: result.observer
      })
      result.page = undefined
      result.observer = undefined
      return room
    } finally {
      result?.observer?.close()
      await result?.page?.close().catch(() => {})
      this.busy = false
    }
  }
  private validateOptions(options: AutoRunOptions): void {
    if (options.sourceUrl) {
      const u = new URL(options.sourceUrl)
      if (
        u.protocol !== 'https:' ||
        u.hostname !== 'live.douyin.com' ||
        !['/', '/category', '/follow'].includes(u.pathname)
      )
        throw new Error('扫描入口必须为抖音直播首页、分类或关注页')
    }
    for (const [key, min, max] of [
      ['scanIntervalSeconds', 30, 3600],
      ['enterBeforeSeconds', 30, 600],
      ['candidatePoolLimit', 1, 5],
      ['stopAfterMinutes', 1, 1440]
    ] as const) {
      const value = options[key]
      if (value !== undefined && (!Number.isInteger(value) || value < min || value > max))
        throw new Error(`无效配置 ${key}`)
      if (value !== undefined && key !== 'stopAfterMinutes') this.env.store.set(key, value)
    }
  }
  private publish(): void {
    this.update(this.getState())
  }
}
