import { Page } from 'playwright'
import { Opportunity, Policy, RoomTimeline, COMMENT_READONLY_REOPEN_SECONDS, RESULT_OBSERVATION_SECONDS, ROOM_HANDOFF_SECONDS } from '../shared/policy'
import { PassiveObserver } from './passive-observer'
import { LotteryDom } from './lottery-dom'
import { parseOwnResult, supplementVisibleTask, visibleFanTaskCompleted } from './lottery-parser'
import { evaluate, taskLead } from './strategy'
import type { RuntimeRepository } from './runtime-repository'
import type { AppConfig } from '../shared/config'

export interface FudaiGrabResult {
  participated: boolean
  won: boolean
  prizeType: 'physical' | 'diamond' | 'coupon' | 'unknown' | null
  diamondAmount: number | null
  prizeName: string | null
  prizeQuantity: number | null
  prizeUnit: string | null
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
  mayWaitForNext?: () => string | null
  nextReservationAt?: () => number | null
}

/** One page, one current lottery. The settled IDs and ledger prohibit replaying a round. */
export class FudaiService {
  readonly observer: PassiveObserver
  private dom: LotteryDom
  private signal: AbortSignal
  private current: Opportunity | null = null
  private settled = new Set<string>()
  private sent = new Set<string>()
  private actionWaits = new Map<string, number>()
  private roundStarted = 0
  private taskWindowAt: number | null = null
  private lastDrawAt: number | null = null
  private openedAt: number
  private waitingSince: number
  private lastOpenAt = 0
  private paymentId: string | null = null
  private paymentStarted = 0
  private paymentDispatched = false
  private paymentConfirmedDialog = false
  private commentStarted = 0
  private followStarted = 0
  private sentCommand = ''
  private stopped = false
  private busy = false
  private inFlight: Promise<void> | null = null
  private watchUntil = 0
  private rounds = 0
  private resultReadReason = '尚未读取本人弹窗'
  doneReason = ''
  constructor(
    private page: Page,
    private url: string,
    private callbacks: FudaiCallbacks,
    private env: FudaiEnvironment,
    observer?: PassiveObserver,
    private ready = true
  ) {
    this.openedAt = env.now()
    this.waitingSince = env.now()
    this.signal = this.env.signal
    this.dom = new LotteryDom(page, this.signal, (signal, action) => this.env.perform(signal, async () => {
      this.env.assertActive(signal)
      if (this.stopped || this.doneReason) throw new Error('本页已停止，取消操作')
      if (!this.current && this.rounds > 0) {
        const reason = this.callbacks.mayWaitForNext?.()
        if (reason) throw new Error(reason)
      }
      // The global action gate may wait. Recheck the round at dispatch time too.
      if (this.current && (this.observer.latest?.lotteryId !== this.current.lotteryId ||
          this.observer.panelLotteryId !== this.current.lotteryId ||
          this.env.now() >= (this.current.drawAt || 0)))
        throw new Error('等待操作期间福袋身份变化或已开奖，取消本次操作')
      if (this.current && this.observer.latest) {
        const task = supplementVisibleTask(this.observer.latest, await this.dom.panelText(), true)
        if (task.requiresShare || task.unsupported.length ||
            (task.requiresComment && this.current.requiresComment && task.commentText !== this.current.commentText))
          throw new Error('等待操作期间任务条件发生变化，取消本次操作')
        this.env.assertActive(signal)
        if (this.stopped || this.observer.latest?.lotteryId !== this.current.lotteryId ||
            this.observer.panelLotteryId !== this.current.lotteryId || this.env.now() >= (this.current.drawAt || 0))
          throw new Error('等待操作期间福袋身份变化或已开奖，取消本次操作')
      }
      return action()
    }))
    this.observer =
      observer ||
      new PassiveObserver(page, this.signal, this.env.reportRisk, (o) => this.env.repository.observe(url, o))
  }
  seed(o?: Opportunity): void {
    if (o) this.observer.accept(o)
  }
  startMonitoring(): void {
    if (this.ready || this.stopped || this.signal.aborted) return
    this.openedAt = this.waitingSince = this.env.now()
    this.ready = true
  }
  stopMonitoring(): void {
    this.stopped = true
    this.observer.close()
    if (this.paymentId) {
      this.env.repository.payment(this.paymentId, this.paymentDispatched ? 'unresolved' : 'failed')
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
    if (!this.ready || this.busy || this.stopped || this.doneReason || this.page.isClosed() || this.signal.aborted) return
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
  getTimeline(): RoomTimeline | undefined {
    const now = this.env.now(), o = this.current
    const reservation = this.callbacks.nextReservationAt?.()
    const limit = (end: number) => reservation == null ? end : Math.min(end, reservation - ROOM_HANDOFF_SECONDS * 1000)
    const remaining = (end: number | null) => end === null ? null : Math.max(0, Math.ceil((end-now)/1000))
    if (o) {
      const record = this.env.repository.account().rounds[this.env.repository.roundKey(this.url,o.lotteryId)]
      const drawing = record?.confirmedAt != null || now >= (o.drawAt || Infinity)
      const endsAt = drawing ? (now < o.drawAt! ? o.drawAt : limit(o.drawAt! + RESULT_OBSERVATION_SECONDS*1000)) : this.roundStarted ? null : this.taskWindowAt
      return {stage:drawing?'draw':'prepare',startedAt:drawing?(now>=o.drawAt!?o.drawAt!:record!.confirmedAt!):(record?.createdAt??now),endsAt,remainingSeconds:remaining(endsAt),taskAt:this.taskWindowAt,drawAt:o.drawAt,nextUntil:null}
    }
    if (!this.rounds) return undefined
    const nextUntil = limit(this.waitingSince + this.env.policy().nextRoundWaitSeconds*1000)
    return {stage:'next',startedAt:this.waitingSince,endsAt:nextUntil,remainingSeconds:remaining(nextUntil),taskAt:this.taskWindowAt,drawAt:this.lastDrawAt,nextUntil}
  }
  private showPhase(status: string): void { this.callbacks.onUpdate(this.current,this.rounds,status) }
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
      this.showPhase('等待付款反馈')
      try { await this.settlePayment() }
      catch (error) {
        // A DOM read failure must not merely end this room and let other paid
        // work continue while the dispatched transaction has no outcome.
        if (!this.stopped && !this.signal.aborted && this.paymentId && this.paymentDispatched) {
          this.env.repository.payment(this.paymentId, 'unresolved')
          this.paymentId = null
          this.env.reportRisk('付款确认过程异常，支付结果未明确，请核对账本', 'payment')
        }
        throw error
      }
      return
    }
    if (this.current) {
      const current = this.current,
        latest = this.observer.latest
      if (latest?.lotteryId === current.lotteryId)
        this.current = supplementVisibleTask(
          { ...latest, drawAt: current.drawAt },
          await this.dom.panelText(),
          this.observer.panelLotteryId === current.lotteryId
        )
      await this.captureResult()
      if (now >= (current.drawAt || now)) {
        this.callbacks.onUpdate(current, this.rounds, '开奖核对')
        const result = this.env.repository.account().rounds[this.env.repository.roundKey(this.url,current.lotteryId)]
        if (result?.result === 'won') this.showPhase('核对中奖奖励明细')
        const nextReservation = this.callbacks.nextReservationAt?.()
        const yieldReason = nextReservation != null && nextReservation <= now + ROOM_HANDOFF_SECONDS*1000
          ? this.callbacks.mayWaitForNext?.() : null
        if (result?.result === 'lost' || yieldReason || now >= (current.drawAt || now) + RESULT_OBSERVATION_SECONDS*1000) {
          const old =
            this.env.repository.account().rounds[this.env.repository.roundKey(this.url, current.lotteryId)]
          if (old?.result === 'pending')
            this.env.repository.record(this.url, current.lotteryId, { result: 'unknown' })
          this.settled.add(current.lotteryId)
          this.rounds++
          this.lastDrawAt = current.drawAt
          this.current = null
          this.callbacks.onUpdate(null, this.rounds, '等待下一轮福袋')
          this.waitingSince = now
          this.sent.clear()
          this.actionWaits.clear()
          this.callbacks.onLog(
            `第 ${this.rounds} 轮已收尾；${old?.result === 'won' ? '中奖已确认' : old?.result === 'lost' ? '未中奖' : `未获得明确结果（${this.resultReadReason}）`}`
          )
          if (yieldReason) this.doneReason = yieldReason
          if (this.rounds >= p.maxRounds || this.env.repository.account().session.phase !== 'running')
            this.doneReason = '已达到连续参与上限或进入收尾'
        }
        return
      }
      const record =
        this.env.repository.account().rounds[this.env.repository.roundKey(this.url, current.lotteryId)]
      if (record?.confirmedAt || record?.submittedAt) {
        this.callbacks.onUpdate(current, this.rounds, record.confirmedAt ? '等待开奖' : '等待参与确认')
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
      const records = Object.values(this.env.repository.account().rounds).filter(r => r.roomUrl === this.url)
      const preparation = Math.max(this.env.getConfig().enterBeforeSeconds, taskLead(this.current!, p, records, true))
      if (!this.roundStarted) this.taskWindowAt = (current.drawAt || 0) - preparation*1000
      if (!this.sent.size && now < (current.drawAt || 0) - preparation * 1000) {
        this.callbacks.onUpdate(this.current, this.rounds, '等待任务准备窗口')
        return
      }
      await this.tasks(this.current!)
      return
    }
    if (this.env.repository.account().session.phase !== 'running') {
      this.doneReason = '当前轮次结束，停止接新任务'
      return
    }
    if (this.rounds > 0) {
      const reason = this.callbacks.mayWaitForNext?.()
      if (reason) { this.doneReason = reason; return }
    }
    if (now - this.waitingSince > p.nextRoundWaitSeconds * 1000) {
      const latest = this.observer.latest
      this.doneReason = latest?.lotteryId && !this.settled.has(latest.lotteryId)
        ? this.observer.panelLotteryId !== latest.lotteryId
          ? `已识别福袋，但未获得匹配的弹窗身份响应，停止本页参与（${this.observer.panelLotteryId ? '弹窗与当前福袋身份不一致' : this.observer.panelIdentityReason}）；${this.dom.lastOpenResult}；${this.observer.identityDiagnostics()}`
          : '福袋接管超时，停止本页参与'
        : '等待新福袋超时'
      this.env.repository.decision({
        url: this.url,
        action: 'skip',
        reason: this.doneReason,
        score: null,
        probability: null
      })
      return
    }
    let o = this.observer.latest
    // A result overlay belongs to settlement, never to a new participation.
    if ((await this.dom.panelSnapshot()).resultPanel) {
      if (now - this.lastOpenAt >= (this.rounds > 0 ? 3000 : 15000)) {
        this.lastOpenAt = now
        await this.dom.reopen()
        const closed = await this.dom.panelIsClosed()
        const snapshot = await this.dom.panelSnapshot()
        const phase = closed || (snapshot.text && !snapshot.resultPanel)
          ? '上一轮结果弹窗已关闭，等待新轮入口或身份确认'
          : '上一轮结果弹窗仍可见，等待安全关闭'
        this.callbacks.onLog(`${phase}：${this.dom.lastOpenResult}`)
      }
      return
    }
    if (!o || !o.lotteryId || this.settled.has(o.lotteryId)) {
      if (now - this.lastOpenAt >= (this.rounds > 0 ? 3000 : 15000)) {
        this.lastOpenAt = now
        // Dismiss only our old result panel, then inspect the next visible entry once.
        if (this.rounds > 0) await this.dom.reopen()
        else await this.dom.open()
      }
      return
    }
    if (this.observer.panelLotteryId !== o.lotteryId) {
      if (now - this.lastOpenAt >= (this.rounds > 0 ? 3000 : 15000)) {
        this.lastOpenAt = now
        await this.dom.reopen()
        this.callbacks.onLog(`弹窗身份待确认：${this.dom.lastOpenResult}；${this.observer.identityDiagnostics()}`)
      }
      return
    }
    o = supplementVisibleTask(o, await this.dom.panelText(), true)
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
          : this.env.paymentReason(this.url, o.cost) ||
            (this.rounds > 0 ? this.callbacks.mayContinue(o) : null) ||
            (o.drawAt! + 25000 > this.openedAt + p.maxStayMinutes * 60000 ? '本轮超过单房停留上限' : null)
    this.env.repository.decision({
      url: this.url,
      action: reason?.startsWith('下一轮已加入预约队列') ? 'candidate' : reason ? 'skip' : 'participate',
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
    this.resultReadReason = '尚未读取本人弹窗'
    const attempts = a.rounds[this.env.repository.roundKey(this.url, o.lotteryId)]?.actions
    if (attempts?.comment) {
      this.sent.add('comment')
      this.commentStarted = attempts.comment.at
      this.sentCommand = attempts.comment.command || ''
    }
    if (attempts?.follow) {
      this.sent.add('follow')
      this.followStarted = attempts.follow.at
    }
    this.roundStarted = 0
    this.taskWindowAt = (o.drawAt || now) - Math.max(this.env.getConfig().enterBeforeSeconds,taskLead(o,p,records,true))*1000
    this.watchUntil = now + (o.watchSeconds || 0) * 1000
    this.env.repository.record(this.url, o.lotteryId, { drawAt: o.drawAt })
    this.callbacks.onLog('弹窗身份与任务校验通过，将在任务准备窗口执行；提交后仍需确认参与结果')
    this.callbacks.onUpdate(o, this.rounds, '等待任务准备窗口')
    await this.dom.open()
  }
  private async tasks(o: Opportunity): Promise<void> {
    if (!this.roundStarted) this.roundStarted = this.env.now()
    this.showPhase('核对任务条件')
    if (o.requiresShare || o.unsupported.length) {
      this.doneReason = '任务条件发生变化，停止本轮'
      return
    }
    // The same identity-bound panel may update task completion without another request.
    const text = await this.dom.panelText()
    // A one-click comment may close the task modal. Reopen only to read the
    // outcome, never to execute another task or replay the submitted comment.
    if (this.sent.has('confirmation-reopen')) {
      this.showPhase('只读核对参与结果')
      this.waitForAction('confirmation-read', '重新查看后仍未确认本人参与，停止本轮且不重发任务')
      return
    }
    if (!text) {
      this.showPhase(this.sent.has('comment') ? '等待弹窗稳定，只读确认参与' : '等待任务弹窗')
      if (!this.actionWaits.has('task-panel'))
        this.callbacks.onLog(`本轮弹窗读取诊断：${await this.dom.panelDiagnostics()}；${this.observer.identityDiagnostics()}`)
      const missingSince = this.actionWaits.get('task-panel')
      if (this.sent.has('comment') && missingSince !== undefined && this.env.now() - missingSince >= COMMENT_READONLY_REOPEN_SECONDS*1000 && await this.dom.panelIsClosed()) {
        this.env.assertActive(this.signal)
        if (this.stopped || this.observer.latest?.lotteryId !== o.lotteryId || this.observer.panelLotteryId !== o.lotteryId) return
        this.sent.add('confirmation-reopen')
        this.showPhase('只读核对参与结果')
        if (await this.dom.open()) {
          this.callbacks.onLog('评论后弹窗已关闭，仅重新查看一次本人参与确认，不再执行任何任务')
          this.actionWaits.set('confirmation-read', this.env.now())
        } else this.doneReason = '本轮任务弹窗消失且无法重新查看，未确认参与，停止重复操作'
        return
      }
      this.waitForAction('task-panel', '本轮任务弹窗消失或内容无法识别，未确认参与，停止重复操作')
      return
    }
    this.actionWaits.delete('task-panel')
    if (o.requiresFollow && this.sent.has('follow')) {
      await this.completeFollow()
      return
    }
    if (o.requiresComment && this.sent.has('comment') && this.sentCommand !== o.commentText) {
      this.doneReason = '本轮口令发生变化，停止旧任务'
      return
    }
    if (o.requiresComment && !this.sent.has('comment')) {
      if (!o.commentText || o.commentText.length > 100) {
        this.doneReason = '评论口令未知或过长，停止本轮'
        return
      }
      if (await this.dom.hasCommentAction()) {
        this.showPhase('发送一键评论')
        this.sent.add('comment')
        this.sentCommand = o.commentText
        if (!(await this.dom.comment(o.commentText, () => {
          this.env.repository.claimAction(this.url, o.lotteryId, 'comment', o.commentText)
          this.commentStarted = this.env.now()
          this.callbacks.onLog('点击本轮福袋一键评论，等待任务完成反馈')
        }))) {
          // No click was dispatched; waiting for the current panel is safe to retry.
          this.sent.delete('comment')
          this.waitForAction('comment', '福袋评论按钮已变化，未发送评论')
        } else this.actionWaits.delete('comment')
        return
      }
      if (o.requiresFollow && o.membership !== 'needs-payment') {
        // A visible follow task can be the prerequisite for the comment CTA.
        this.actionWaits.delete('comment')
        await this.completeFollow()
        return
      }
      if (o.membership !== 'needs-payment' || this.sent.has('payment')) {
        this.waitForAction('comment', '未找到福袋弹窗内的一键评论按钮，未向聊天框发送口令')
        return
      }
      // No comment button yet: the panel may expose the paid fan task first.
      // Fall through to the same budget reservation and explicit-price checks.
      this.actionWaits.delete('comment')
    }
    if (
      o.requiresComment &&
      this.sent.has('comment') &&
      this.observer.lastChatSuccess < this.commentStarted
    ) {
      this.showPhase('等待评论反馈')
      if (this.env.now() - this.commentStarted > 10000) {
        this.doneReason = '评论未获得业务成功反馈，停止本轮以防重复发送'
        // Set the terminal reason first: diagnostic failures must never enable another action.
        try {
          const snapshot = await this.dom.panelSnapshot()
          this.callbacks.onLog(`评论反馈超时诊断：${JSON.stringify({
            waitedSeconds: Math.round((this.env.now() - this.commentStarted) / 1000),
            latestMatches: this.observer.latest?.lotteryId === o.lotteryId,
            rightsMatch: this.observer.panelLotteryId === o.lotteryId,
            panelIdMatches: snapshot.lotteryId ? snapshot.lotteryId === o.lotteryId : null,
            panelReadable: !!snapshot.text, resultPanel: snapshot.resultPanel,
            commentTaskPending: o.requiresComment,
            commentButtonVisible: await this.dom.hasCommentAction(),
            ownResult: this.resultReadReason
          })}；${await this.dom.panelDiagnostics()}；${this.observer.identityDiagnostics()}`)
        } catch {
          this.callbacks.onLog('评论反馈超时诊断：页面状态读取失败；本轮已停止，不重发任务')
        }
      }
      return
    }
    if (o.membership === 'needs-payment' && !this.sent.has('payment')) {
      this.showPhase('完成粉丝团任务')
      const cost = o.cost
      if (cost === null) {
        this.waitForAction('payment-price', '粉丝团金额未确认')
        return
      }
      this.actionWaits.delete('payment-price')
      const reason = this.env.paymentReason(this.url, cost)
      if (reason) {
        this.doneReason = reason
        return
      }
      // A modal-specific explicit price is required in addition to structured task data.
      const escaped = String(cost).replace('.', '\\.')
      const pattern = new RegExp(`^(?:加入粉丝团|点亮粉丝团|点亮灯牌)[（(]${escaped}(?:钻石|钻)[）)]$`)
      if (!(await this.dom.hasAction(pattern))) {
        this.waitForAction('payment', '未找到福袋内带金额的粉丝团按钮')
        return
      }
      this.actionWaits.delete('payment')
      if ((o.drawAt || 0) - this.env.now() < taskLead(o, this.env.policy(), [], true) * 1000) {
        this.doneReason = '剩余时间不足以完成粉丝团及后续任务，不再付费'
        return
      }
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
      this.paymentDispatched = false
      this.paymentConfirmedDialog = false
      try {
        const clicked = await this.dom.action(pattern, true, () => {
          if ((o.drawAt || 0) - this.env.now() < taskLead(o, this.env.policy(), [], true) * 1000)
            throw new Error('等待操作后剩余时间不足以完成后续任务，取消付款')
          if (o.requiresComment && !this.sent.has('comment'))
            this.callbacks.onLog('当前弹窗仅有粉丝团任务入口，先完成粉丝团，再继续一键评论')
          this.env.repository.payment(payment.id, 'submitted')
          this.paymentStarted = this.env.now()
          this.observer.beginPaymentObservation()
          this.paymentDispatched = true
        })
        if (!clicked) {
          this.env.repository.payment(payment.id, 'failed')
          this.paymentId = null
          this.doneReason = '未找到福袋内带金额的粉丝团按钮'
        }
      } catch (error) {
        this.env.repository.payment(payment.id, this.paymentDispatched ? 'unresolved' : 'failed')
        this.paymentId = null
        if (this.paymentDispatched) this.env.reportRisk('支付操作结果未明确，请核对账本', 'payment')
        throw error
      }
      return
    }
    if (o.membership === 'needs-payment' && this.sent.has('payment')) {
      this.showPhase('等待粉丝团资格确认')
      this.waitForAction('fan-qualification', '付款已确认，但本轮粉丝团资格尚未确认，停止提交且不重复付款')
      return
    }
    this.actionWaits.delete('fan-qualification')
    if (o.requiresFollow && o.membership !== 'needs-payment') {
      await this.completeFollow()
      return
    }
    if (o.watchSeconds && this.env.now() < this.watchUntil) { this.showPhase('等待看播条件完成'); return }
    if (this.sent.has('submit')) return
    this.showPhase('提交参与')
    this.sent.add('submit')
    if (!(await this.dom.action(/^(?:手动参与|立即参与|参与福袋|参与抽奖|一键参与|立即抽奖|免费参与|抢福袋|报名)$/, true, () => {
      this.env.repository.record(this.url, o.lotteryId, { submittedAt: this.env.now() })
    }))) {
      // Do not convert a missing button or timeout into a successful participation.
      this.env.repository.record(this.url, o.lotteryId, { submittedAt: null })
      this.sent.delete('submit')
      this.waitForAction('submit', '未发现明确参与按钮或成功回执')
    } else this.actionWaits.delete('submit')
  }
  private async completeFollow(): Promise<void> {
    this.showPhase(this.sent.has('follow')?'等待关注反馈':'完成关注任务')
    if (!this.sent.has('follow')) {
      this.sent.add('follow')
      if (!(await this.dom.action(/^(?:关注|去关注|关注主播|关注参与|关注并参与|立即关注)$/, true, () => {
        this.env.repository.claimAction(this.url, this.current!.lotteryId, 'follow')
        this.followStarted = this.env.now()
        this.callbacks.onLog('点击本轮福袋关注按钮，确认关注后继续剩余任务')
      }))) {
        this.sent.delete('follow')
        this.waitForAction('follow', '未找到福袋内明确的关注按钮')
      } else this.actionWaits.delete('follow')
      return
    }
    if (this.env.now() - this.followStarted >= 10000) this.doneReason = '关注状态未确认，不重复关注或继续评论'
  }
  private waitForAction(kind: string, reason: string): void {
    const since = this.actionWaits.get(kind)
    if (since === undefined) this.actionWaits.set(kind, this.env.now())
    else if (this.env.now() - since >= 10000) this.doneReason = reason
  }
  private async settlePayment(): Promise<void> {
    const id = this.paymentId!,
      o = this.current!,
      started = this.paymentStarted
    if (this.resolvePaymentReceipt(id, started)) return
    if (!this.paymentConfirmedDialog && this.env.now() - started >= 1000 && this.env.now() - started < 12000) {
      this.paymentConfirmedDialog = await this.dom.paymentConfirmation(o.cost!, () =>
        this.env.now() - started < 12000 && this.observer.lastFanSuccess < started && this.observer.lastFanFailure < started)
    }
    if (this.resolvePaymentReceipt(id, started)) return
    if (this.env.now() - started >= 12000) {
      // Only after the normal receipt deadline: the user-authorized fallback
      // requires a completed fan task in the same identity-bound current panel.
      const panel = await this.dom.panelSnapshot()
      this.env.assertActive(this.signal)
      if (this.stopped || this.paymentId !== id) return
      // A response may have arrived while reading the DOM. It still takes priority.
      if (this.resolvePaymentReceipt(id, started)) return
      if (this.paymentDispatched && o.membership === 'needs-payment' &&
          this.observer.latest?.lotteryId === o.lotteryId &&
          this.observer.panelLotteryId === o.lotteryId &&
          (!panel.lotteryId || panel.lotteryId === o.lotteryId) &&
          !panel.resultPanel && visibleFanTaskCompleted(panel.text)) {
        this.env.repository.payment(id, 'confirmed')
        this.paymentId = null
        this.callbacks.onLog('支付回执超时，但同一福袋粉丝团任务已明确完成，按任务反馈兜底确认付款；不重复付款')
        return
      }
      this.callbacks.onLog(`支付回执超时诊断：${this.observer.identityDiagnostics()}`)
      this.env.repository.payment(id, 'unresolved')
      this.paymentId = null
      this.env.reportRisk('粉丝团支付结果未知，禁止重试，请核对后处理', 'payment')
    }
  }
  private resolvePaymentReceipt(id: string, started: number): boolean {
    if (this.observer.lastFanSuccess >= started && this.observer.lastFanFailure >= started) {
      this.env.repository.payment(id, 'unresolved')
      this.paymentId = null
      this.env.reportRisk('粉丝团支付回执冲突，请核对账本，禁止重试', 'payment')
      return true
    }
    if (this.observer.lastFanSuccess >= started) {
      this.env.repository.payment(id, 'confirmed')
      this.paymentId = null
      this.callbacks.onLog('粉丝团支付已由业务成功响应确认')
      return true
    }
    if (this.observer.lastFanFailure >= started) {
      this.env.repository.payment(id, 'failed')
      this.paymentId = null
      this.doneReason = '粉丝团支付失败'
      return true
    }
    return false
  }
  private async captureResult(): Promise<void> {
    const o = this.current
    if (!o) return
    const before = this.env.repository.account().rounds[this.env.repository.roundKey(this.url, o.lotteryId)]
    const snapshot = await this.dom.panelSnapshot()
    if (!snapshot.text) { this.resultReadReason='没有可读取的本人福袋弹窗'; return }
    // Background info for the next round must not discard the previous result.
    // Accept only its explicit ID, or the still-bound old panel after a confirmed
    // participation. A new rights response without a matching ID stays unknown.
    if (snapshot.lotteryId && snapshot.lotteryId !== o.lotteryId) { this.resultReadReason='结果弹窗属于另一轮'; return }
    const samePanel = this.observer.panelLotteryId === o.lotteryId
    const sameLatest = this.observer.latest?.lotteryId === o.lotteryId
    if (!(samePanel && sameLatest) && !(snapshot.resultPanel &&
        (snapshot.lotteryId === o.lotteryId || (samePanel && before?.confirmedAt)))) {
      this.resultReadReason='结果弹窗无法关联本轮身份'; return
    }
    const result = parseOwnResult(snapshot.text)
    if (!result.participated) { this.resultReadReason='本人弹窗尚无可识别的参与或开奖结果'; return }
    this.resultReadReason = result.won || result.lost ? '已识别本人结果' : '已确认参与，但尚未读到开奖结果'
    const after = this.env.now() >= (o.drawAt || Infinity) - 2000
    if (!after && (result.won || result.lost)) return
    const patch = {
      confirmedAt: this.env.now(),
      submittedAt: before?.submittedAt ?? (this.commentStarted || this.env.now()),
      // A first confirmation at draw time includes waiting, not task latency.
      taskSeconds: after ? (before?.taskSeconds ?? null) : this.roundStarted ? (this.env.now() - this.roundStarted) / 1000 : null,
      ...(after && result.won
        ? { result: 'won' as const, prizeType: result.prizeType, diamondAmount: result.diamondAmount,
            prizeName: result.prizeName, prizeQuantity: result.prizeQuantity, prizeUnit: result.prizeUnit }
        : after && result.lost
          ? { result: 'lost' as const }
          : {})
    }
    const saved = this.env.repository.record(this.url, o.lotteryId, patch)
    const changed = before?.result !== saved.result || before?.diamondAmount !== saved.diamondAmount ||
      before?.prizeType !== saved.prizeType || before?.prizeName !== saved.prizeName ||
      before?.prizeQuantity !== saved.prizeQuantity || before?.prizeUnit !== saved.prizeUnit
    if (!before?.confirmedAt) this.callbacks.onLog('本人福袋弹窗已确认参与，等待本轮开奖')
    if (after && (result.won || result.lost) && changed)
      this.callbacks.onLog(saved.result === 'won' ? `本轮中奖已记录：${saved.prizeType === 'diamond'
        ? saved.diamondAmount === null ? '钻石数量待确认' : `${saved.diamondAmount} 钻`
        : `${saved.prizeName || '奖品详情待确认'}${saved.prizeQuantity != null ? ` × ${saved.prizeQuantity}${saved.prizeUnit || ''}` : ''}`}` : '本轮未中奖已记录')
    if (
      !before?.confirmedAt ||
      (after && (result.won || result.lost) && changed)
    )
      this.callbacks.onResult(result)
  }
}
