import { Page } from 'playwright'
import { Opportunity, Policy } from '../shared/policy'
import { PassiveObserver } from './passive-observer'
import { LotteryDom } from './lottery-dom'
import { parseOwnResult, supplementVisibleTask } from './lottery-parser'
import { evaluate } from './strategy'
import type { RuntimeRepository } from './runtime-repository'
import type { AppConfig } from '../shared/config'

export interface FudaiGrabResult {
  participated: boolean
  won: boolean
  prizeType: 'physical' | 'diamond' | 'coupon' | 'unknown' | null
  diamondAmount: number
  resultText: string
}
export interface FudaiEnvironment {
  signal: AbortSignal
  now: () => number
  repository: RuntimeRepository
  getConfig: () => AppConfig
  policy: () => Policy
  assertActive: (signal: AbortSignal) => void
  paymentReason: (url: string, cost: number | null) => string | null
  reportRisk: (reason: string, source: string) => void
  canFinish: (drawAt: number) => boolean
  perform: <T>(signal: AbortSignal, fn: () => Promise<T>) => Promise<T>
}
export interface FudaiCallbacks {
  onUpdate: (o: Opportunity | null, rounds: number, status: string) => void
  onResult: (result: FudaiGrabResult) => void
  onLog: (message: string) => void
  mayContinue: (o: Opportunity) => string | null
}

/** One page, one current lottery. The settled IDs and ledger prohibit replaying a round. */
export class FudaiService {
  readonly observer: PassiveObserver
  private dom: LotteryDom
  private signal: AbortSignal
  private current: Opportunity | null = null
  private settled = new Set<string>()
  private sent = new Set<string>()
  private roundStarted = 0
  private openedAt: number
  private waitingSince: number
  private lastOpenAt = 0
  private paymentId: string | null = null
  private paymentStarted = 0
  private paymentConfirmedDialog = false
  private commentStarted = 0
  private followStarted = 0
  private sentCommand = ''
  private stopped = false
  private busy = false
  private inFlight: Promise<void> | null = null
  private watchUntil = 0
  private rounds = 0
  doneReason = ''
  constructor(
    private page: Page,
    private url: string,
    private callbacks: FudaiCallbacks,
    private env: FudaiEnvironment,
    observer?: PassiveObserver
  ) {
    this.openedAt = env.now()
    this.waitingSince = env.now()
    this.signal = this.env.signal
    this.dom = new LotteryDom(page, this.signal, this.env.perform)
    this.observer =
      observer ||
      new PassiveObserver(page, this.signal, this.env.reportRisk, (o) => this.env.repository.observe(url, o))
  }
  seed(o?: Opportunity): void {
    if (o) this.observer.accept(o)
  }
  stopMonitoring(): void {
    this.stopped = true
    this.observer.close()
    if (this.paymentId) {
      this.env.repository.payment(this.paymentId, 'unresolved')
      this.paymentId = null
    }
    if (this.current) {
      const r =
        this.env.repository.account().rounds[this.env.repository.roundKey(this.url, this.current.lotteryId)]
      if (r?.result === 'pending')
        this.env.repository.record(this.url, this.current.lotteryId, {
          result: r.submittedAt || r.confirmedAt ? 'unknown' : 'cancelled'
        })
    }
  }
  async tick(): Promise<void> {
    if (this.busy || this.stopped || this.page.isClosed() || this.signal.aborted) return
    this.busy = true
    this.inFlight = this.step()
      .catch((e: any) => {
        if (!this.signal.aborted && !this.stopped) {
          this.callbacks.onLog(`本页操作停止：${e.message}`)
          this.doneReason = e.message
        }
      })
      .finally(() => {
        this.busy = false
        this.inFlight = null
      })
    return this.inFlight
  }
  async waitForIdle(): Promise<void> {
    await this.inFlight
  }
  async installDomObserver(): Promise<void> {
    await this.dom.watch(() => {
      void this.tick()
    })
  }
  private async step(): Promise<void> {
    this.env.assertActive(this.signal)
    await this.observer.checkPageRisk()
    this.env.assertActive(this.signal)
    const p = this.env.policy(),
      now = this.env.now()
    if (now - this.openedAt >= p.maxStayMinutes * 60000) {
      this.doneReason = '已达到单房停留上限'
      return
    }
    if (this.paymentId) {
      await this.settlePayment()
      return
    }
    if (this.current) {
      const current = this.current,
        latest = this.observer.latest
      if (latest?.lotteryId === current.lotteryId)
        this.current = supplementVisibleTask(
          { ...latest, drawAt: current.drawAt },
          await this.dom.panelText()
        )
      await this.captureResult()
      if (now >= (current.drawAt || now)) {
        this.callbacks.onUpdate(current, this.rounds, '开奖核对')
        if (now >= (current.drawAt || now) + 25000) {
          const old =
            this.env.repository.account().rounds[this.env.repository.roundKey(this.url, current.lotteryId)]
          if (old?.result === 'pending')
            this.env.repository.record(this.url, current.lotteryId, { result: 'unknown' })
          this.settled.add(current.lotteryId)
          this.rounds++
          this.current = null
          this.waitingSince = now
          this.sent.clear()
          this.callbacks.onLog(
            `第 ${this.rounds} 轮已收尾；${old?.result === 'won' ? '中奖已确认' : old?.result === 'lost' ? '未中奖' : '未获得明确结果'}`
          )
          if (this.rounds >= p.maxRounds || this.env.repository.account().session.phase !== 'running')
            this.doneReason = '已达到连续参与上限或进入收尾'
        }
        return
      }
      const record =
        this.env.repository.account().rounds[this.env.repository.roundKey(this.url, current.lotteryId)]
      if (record?.confirmedAt || record?.submittedAt) {
        this.callbacks.onUpdate(current, this.rounds, '等待开奖')
        return
      }
      if (latest?.lotteryId !== current.lotteryId) {
        this.doneReason = '福袋身份已变化，取消未完成的旧任务'
        return
      }
      if (this.observer.panelLotteryId !== current.lotteryId) {
        this.doneReason = '当前弹窗不能归属于本轮福袋'
        return
      }
      await this.tasks(this.current!)
      return
    }
    if (this.env.repository.account().session.phase !== 'running') {
      this.doneReason = '当前轮次结束，停止接新任务'
      return
    }
    if (now - this.waitingSince > p.nextRoundWaitSeconds * 1000) {
      this.doneReason = '等待新福袋超时'
      return
    }
    let o = this.observer.latest
    if (!o || !o.lotteryId || this.settled.has(o.lotteryId)) {
      if (now - this.lastOpenAt >= 15000) {
        this.lastOpenAt = now
        // Dismiss only our old result panel, then inspect the next visible entry once.
        if (this.rounds > 0 && (await this.dom.panelText())) {
          await this.env.perform(this.signal, () => this.page.keyboard.press('Escape'))
        }
        await this.dom.open()
      }
      return
    }
    if (this.observer.panelLotteryId !== o.lotteryId) {
      if (now - this.lastOpenAt >= 15000) {
        this.lastOpenAt = now
        if (await this.dom.panelText())
          await this.env.perform(this.signal, () => this.page.keyboard.press('Escape'))
        await this.dom.open()
      }
      return
    }
    o = supplementVisibleTask(o, await this.dom.panelText())
    this.env.repository.observe(this.url, o)
    const a = this.env.repository.account(),
      records = Object.values(a.rounds).filter((r) => r.roomUrl === this.url)
    const assessment = evaluate(o, p, now, a.rooms[this.url], records, true)
    const type = this.env.getConfig().fudaiTypes
    const typeAllowed =
      type.all || (o.prizeType === 'diamond' && type.diamond) || (o.prizeType === 'physical' && type.physical)
    const reason = !assessment.feasible
      ? assessment.reason
      : !typeAllowed
        ? '该奖品类型未启用'
        : !this.env.canFinish(o.drawAt!)
          ? '本轮无法在计划结束前收尾'
          : o.drawAt! + 25000 > this.openedAt + p.maxStayMinutes * 60000
            ? '本轮超过单房停留上限'
            : this.env.paymentReason(this.url, o.cost) ||
              (this.rounds > 0 ? this.callbacks.mayContinue(o) : null)
    this.env.repository.decision({
      url: this.url,
      action: reason ? 'skip' : 'participate',
      reason: reason || assessment.reason,
      score: assessment.score,
      probability: assessment.probability,
      snapshot: {
        version: 2,
        opportunity: o,
        leadSeconds: assessment.leadSeconds,
        utility: assessment.utility,
        mode: assessment.mode,
        sampleCount: records.length
      }
    })
    if (reason) {
      this.doneReason = reason
      return
    }
    this.current = o
    this.roundStarted = now
    this.watchUntil = now + (o.watchSeconds || 0) * 1000
    this.env.repository.record(this.url, o.lotteryId, { drawAt: o.drawAt })
    this.callbacks.onUpdate(o, this.rounds, '完成任务')
    await this.dom.open()
  }
  private async tasks(o: Opportunity): Promise<void> {
    if (o.requiresShare || o.unsupported.length) {
      this.doneReason = '任务条件发生变化，停止本轮'
      return
    }
    // A freshly refreshed rights response is required before each new kind of task.
    const text = await this.dom.panelText()
    if (!text) return
    if (o.requiresComment && this.sent.has('comment') && this.sentCommand !== o.commentText) {
      this.doneReason = '本轮口令发生变化，停止旧任务'
      return
    }
    if (o.requiresComment && !this.sent.has('comment')) {
      if (!o.commentText) {
        this.doneReason = '评论口令未知'
        return
      }
      this.sent.add('comment')
      this.commentStarted = this.env.now()
      this.sentCommand = o.commentText
      if (!(await this.dom.comment(o.commentText))) this.doneReason = '未找到准确的评论任务入口'
      return
    }
    if (
      o.requiresComment &&
      this.sent.has('comment') &&
      this.observer.lastChatSuccess < this.commentStarted
    ) {
      if (this.env.now() - this.commentStarted > 10000)
        this.doneReason = '评论未获得业务成功反馈，停止本轮以防重复发送'
      return
    }
    if (o.membership === 'needs-payment' && !this.sent.has('payment')) {
      const cost = o.cost,
        reason = this.env.paymentReason(this.url, cost)
      if (reason || cost === null) {
        this.doneReason = reason || '金额未知'
        return
      }
      // A modal-specific explicit price is required in addition to structured task data.
      const escaped = String(cost).replace('.', '\\.')
      const pattern = new RegExp(`^(?:加入粉丝团|点亮粉丝团|点亮灯牌)[（(]${escaped}(?:钻石|钻)[）)]$`)
      const payment = this.env.repository.reserve(
        this.url,
        o.lotteryId,
        cost,
        this.env.getConfig().diamondBudget,
        this.env.getConfig().allowDiamondProfit,
        this.env.policy()
      )
      this.sent.add('payment')
      this.paymentId = payment.id
      this.paymentStarted = this.env.now()
      this.paymentConfirmedDialog = false
      this.env.repository.payment(payment.id, 'submitted')
      try {
        const clicked = await this.dom.action(pattern)
        if (!clicked) {
          this.env.repository.payment(payment.id, 'failed')
          this.paymentId = null
          this.doneReason = '未找到福袋内带金额的粉丝团按钮'
        }
      } catch (error) {
        this.env.repository.payment(payment.id, 'unresolved')
        this.paymentId = null
        this.env.reportRisk('支付操作结果未明确，请核对账本', 'payment')
        throw error
      }
      return
    }
    if (o.requiresFollow && o.membership !== 'needs-payment' && !this.sent.has('follow')) {
      this.sent.add('follow')
      this.followStarted = this.env.now()
      if (!(await this.dom.action(/^(?:关注|关注主播|关注参与|关注并参与|立即关注)$/)))
        this.doneReason = '未找到福袋内明确的关注按钮'
      return
    }
    if (o.requiresFollow && this.sent.has('follow')) {
      if (this.env.now() - this.followStarted > 10000) this.doneReason = '关注状态未确认'
      return
    }
    if (o.watchSeconds && this.env.now() < this.watchUntil) return
    if (this.sent.has('submit')) return
    this.sent.add('submit')
    this.env.repository.record(this.url, o.lotteryId, { submittedAt: this.env.now() })
    if (!(await this.dom.action(/^(?:手动参与|立即参与|参与福袋|参与抽奖|一键参与|立即抽奖|免费参与)$/))) {
      // Do not convert a missing button or timeout into a successful participation.
      this.env.repository.record(this.url, o.lotteryId, { submittedAt: null })
      this.doneReason = '未发现明确参与按钮或成功回执'
    }
  }
  private async settlePayment(): Promise<void> {
    const id = this.paymentId!,
      o = this.current!,
      started = this.paymentStarted
    if (this.observer.lastFanSuccess >= started) {
      this.env.repository.payment(id, 'confirmed')
      this.paymentId = null
      this.callbacks.onLog('粉丝团支付已由业务成功响应确认')
      return
    }
    if (this.observer.lastFanFailure >= started) {
      this.env.repository.payment(id, 'failed')
      this.paymentId = null
      this.doneReason = '粉丝团支付失败'
      return
    }
    if (!this.paymentConfirmedDialog && this.env.now() - started >= 1000) {
      this.paymentConfirmedDialog = await this.dom.paymentConfirmation(o.cost!)
    }
    if (this.env.now() - started >= 12000) {
      this.env.repository.payment(id, 'unresolved')
      this.paymentId = null
      this.env.reportRisk('粉丝团支付结果未知，禁止重试，请核对后处理', 'payment')
    }
  }
  private async captureResult(): Promise<void> {
    const o = this.current
    if (!o) return
    // A newer lottery response means the old dialog can no longer be attributed safely.
    if (this.observer.latest?.lotteryId !== o.lotteryId || this.observer.panelLotteryId !== o.lotteryId)
      return
    const text = await this.dom.panelText()
    if (!text) return
    const result = parseOwnResult(text)
    if (!result.participated) return
    const after = this.env.now() >= (o.drawAt || Infinity) - 2000
    if (!after && (result.won || result.lost)) return
    const patch = {
      confirmedAt: this.env.now(),
      taskSeconds: (this.env.now() - this.roundStarted) / 1000,
      ...(after && result.won
        ? { result: 'won' as const, prizeType: result.prizeType, diamondAmount: result.diamondAmount }
        : after && result.lost
          ? { result: 'lost' as const }
          : {})
    }
    const before = this.env.repository.account().rounds[this.env.repository.roundKey(this.url, o.lotteryId)]
    this.env.repository.record(this.url, o.lotteryId, patch)
    if (
      !before?.confirmedAt ||
      (after && result.won && (before.result !== 'won' || result.diamondAmount > before.diamondAmount))
    )
      this.callbacks.onResult(result)
  }
}
