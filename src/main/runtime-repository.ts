import { AccountData, DEFAULT_POLICY, DecisionRecord, emptySession, Membership, Opportunity, Payment, Policy, RoomProfile, RoundRecord, RuntimeData, UserAlert, normalizeRoomUrl } from '../shared/policy'

export interface RuntimeStorage { read(): RuntimeData; write(data: RuntimeData): void }
export const emptyRuntime = (): RuntimeData => ({ version: 2, activeAccount: null, legacyAssigned: false, accounts: {} })
function budgetHasActivity(a: AccountData): boolean {
  const cycle = a.budgetCycle ?? 0
  return (cycle === 0 && a.openingSpent > 0) ||
    Object.values(a.rounds).some(r => (r.budgetCycle ?? 0) === cycle) ||
    Object.values(a.payments).some(p => (p.budgetCycle ?? 0) === cycle)
}
export function dayKey(now: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
export function allowedNow(now: number, p: Policy): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: p.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)
  return p.allowedStart === p.allowedEnd || (p.allowedStart < p.allowedEnd ? parts >= p.allowedStart && parts < p.allowedEnd : parts >= p.allowedStart || parts < p.allowedEnd)
}
export class RuntimeRepository {
  constructor(private storage: RuntimeStorage, public now: () => number = Date.now) {}
  read(): RuntimeData { return structuredClone(this.storage.read()) }
  account(): AccountData {
    const data = this.read()
    if (!data.activeAccount || !data.accounts[data.activeAccount]) throw new Error('请先确认登录账号')
    return data.accounts[data.activeAccount]
  }
  change<T>(fn: (a: AccountData) => T): T {
    const data = this.read()
    if (!data.activeAccount || !data.accounts[data.activeAccount]) throw new Error('请先确认登录账号')
    const result = fn(data.accounts[data.activeAccount])
    this.storage.write(data) // synchronous commit: reservations cannot interleave in the main process
    return result
  }
  bind(account: string, legacy: { spent: number; stats: Record<string, unknown>; rooms: { url: string; name: string }[] }): void {
    const data = this.read()
    if (!data.accounts[account]) {
      const first = !data.legacyAssigned
      data.accounts[account] = { openingSpent: first ? Math.max(0, legacy.spent) : 0,
        legacyStats: first ? legacy.stats : {}, rooms: {}, rounds: {}, payments: {}, risks: [],
        decisions: [], navigations: [], actions: [], session: emptySession(), statsSince: 0 }
      if (first) for (const r of legacy.rooms) {
        try { const url = normalizeRoomUrl(r.url); data.accounts[account].rooms[url] = this.newRoom(url, r.name, 'legacy') } catch { /* invalid legacy link */ }
      }
      data.legacyAssigned = true
    }
    data.activeAccount = account
    this.storage.write(data)
  }
  unbind(): void { const d = this.read(); d.activeAccount = null; this.storage.write(d) }
  recover(): void {
    const d = this.read()
    for (const a of Object.values(d.accounts)) {
      a.actions ||= []
      const run=a.runs?.find(r=>r.endedAt===null)
      if(run) { run.silentEnd=Object.values(a.payments).some(p=>['reserved','submitted','unresolved'].includes(p.state)); run.endedAt=a.session.lastTickAt??run.startedAt; run.reason='应用意外退出，运行已中断'; run.activeMs=Math.max(0,Object.values(a.session.activeByDay).reduce((s,n)=>s+n,0)-run.activeBaseline) }
      const previousReason=a.session.reason
      a.session.phase = a.risks.some(r => r.resolvedAt === null) ? 'blocked' : 'stopped'
      a.session.reason = run ? '应用意外退出，运行已中断' : previousReason || '应用重启，请检查上次运行记录后启动'
      a.session.lastTickAt = null
      for (const p of Object.values(a.payments)) if (p.state === 'reserved' || p.state === 'submitted') p.state = 'unresolved'
      for (const r of Object.values(a.rounds)) if (r.result === 'pending') {
        if(run && r.runId===run.id)r.result=r.submittedAt!==null||r.confirmedAt!==null?'unknown':'cancelled'
        else if(r.drawAt!==null&&r.drawAt<=this.now())r.result='unknown'
      }
    }
    d.activeAccount = null // require login to establish the current account again
    this.storage.write(d)
  }
  private newRoom(url: string, name: string, source: string): RoomProfile {
    return { url, name, source, favorite: false, blocked: false, allowPaid: false, lastSeenAt: 0,
      nextEligibleCheckAt: 0, membership: 'unknown', membershipAt: 0, everPaid: false, visits: [], observations: [], failures: 0 }
  }
  room(url: string, name = '', source = 'discovery'): RoomProfile {
    url = normalizeRoomUrl(url)
    return this.change(a => { a.rooms[url] ||= this.newRoom(url, name || url, source); return a.rooms[url] })
  }
  updateRoom(url: string, patch: Partial<Pick<RoomProfile, 'favorite' | 'blocked' | 'allowPaid' | 'name'>>): void {
    this.room(url)
    this.change(a => { Object.assign(a.rooms[url], patch) })
  }
  recordVerificationTiming(url: string, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 3 || seconds > 120) return
    this.change(a => {
      const room = a.rooms[url]
      if (room) room.verificationTimings = [...(room.verificationTimings || []), {at:this.now(),seconds}].slice(-5)
    })
  }
  visit(url: string, found: boolean, opportunity?: Opportunity): void {
    this.room(url)
    const now = this.now()
    this.change(a => {
      const r = a.rooms[url]; r.lastSeenAt = now; r.failures = found ? 0 : r.failures + 1
      if (!found) r.verificationTimings = []
      r.visits = [...r.visits, { at: now, found }].slice(-200)
      r.nextEligibleCheckAt = now + (found ? 5 * 60_000 : Math.min(240, 30 * 2 ** Math.min(3, r.failures - 1)) * 60_000)
      if (opportunity) this.applyObservation(r, opportunity)
    })
  }
  observe(url: string, o: Opportunity): void { this.room(url); this.change(a => this.applyObservation(a.rooms[url], o)) }
  private applyObservation(r: RoomProfile, o: Opportunity): void {
    if(typeof o.memberKnown==='boolean')r.memberKnown=o.memberKnown
    if (o.tasksKnown) { r.membership = o.membership; r.membershipAt = o.observedAt }
    if (o.lotteryId && o.drawAt) {
      const last = r.observations.at(-1)
      if (!last || last.lotteryId !== o.lotteryId || o.observedAt - last.at >= 5000)
        r.observations = [...r.observations, { at: o.observedAt, lotteryId: o.lotteryId, drawAt: o.drawAt, participants: o.participantCount }].slice(-300)
    }
  }
  roundKey(url: string, lotteryId: string): string { return `${url}#${lotteryId}` }
  claimAction(url: string, lotteryId: string, kind: 'comment' | 'follow', command?: string): void {
    const actions = this.account().rounds[this.roundKey(url, lotteryId)]?.actions || {}
    if (actions[kind]) throw new Error('本轮该任务已尝试，禁止重复执行')
    // Persist synchronously before dispatch; an ambiguous crash must not cause replay.
    this.record(url, lotteryId, { actions: { ...actions, [kind]: { at: this.now(), ...(command ? { command } : {}) } } })
  }
  record(url: string, lotteryId: string, patch: Partial<RoundRecord>): RoundRecord {
    if (!lotteryId) throw new Error('缺少福袋身份，不能确认参与或奖励')
    const key = this.roundKey(url, lotteryId), now = this.now()
    return this.change(a => {
      const r = a.rounds[key] ||= { runId:a.runs?.find(r=>r.endedAt===null)?.id, budgetCycle: a.budgetCycle ?? 0, key, lotteryId, roomUrl: url, createdAt: now, drawAt: null, submittedAt: null,
        confirmedAt: null, result: 'pending', prizeType: null, diamondAmount: null, prizeName: null, prizeQuantity: null, prizeUnit: null, updatedAt: now,
        taskSeconds: null, claimDueAt: null, claimed: false }
      const confirmedAt = r.confirmedAt
      const previousResult = r.result
      const amount = r.diamondAmount
      const previousType = r.prizeType
      const taskSeconds = r.taskSeconds
      const previousName = r.prizeName, previousQuantity = r.prizeQuantity, previousUnit = r.prizeUnit
      Object.assign(r, patch, { key, lotteryId, roomUrl: url, createdAt: r.createdAt, updatedAt: now })
      if (confirmedAt !== null) { r.confirmedAt = confirmedAt; r.taskSeconds = taskSeconds }
      if (previousResult === 'won' && patch.result !== 'won') r.result = 'won'
      if (previousResult === 'won' && previousType !== 'unknown' && previousType !== null && (r.prizeType === 'unknown' || r.prizeType === null)) r.prizeType=previousType
      const nextAmount = typeof patch.diamondAmount === 'number' && Number.isFinite(patch.diamondAmount) && patch.diamondAmount >= 0
        ? Math.floor(patch.diamondAmount) : null
      r.diamondAmount = amount == null ? nextAmount : nextAmount == null ? amount : Math.max(amount, nextAmount)
      r.prizeName = previousName || patch.prizeName || null
      r.prizeQuantity = previousQuantity ?? patch.prizeQuantity ?? null
      r.prizeUnit = previousUnit || patch.prizeUnit || null
      return r
    })
  }
  budget(base: number, allowProfit: boolean, p: Policy) {
    const a = this.account(), now = this.now(), today = dayKey(now, p.timezone)
    const entries = Object.values(a.payments).filter(x => x.state !== 'failed')
    const cycle = a.budgetCycle ?? 0
    const lifetimeSpent = a.openingSpent + entries.filter(x => x.state === 'confirmed').reduce((s,x) => s+x.cost,0)
    const spent = (cycle === 0 ? a.openingSpent : 0) + entries.filter(x => x.state === 'confirmed' && (x.budgetCycle ?? 0) === cycle).reduce((s,x) => s+x.cost,0)
    const reserved = entries.filter(x => x.state !== 'confirmed').reduce((s,x) => s+x.cost,0)
    const awards = Object.values(a.rounds).filter(r => (r.budgetCycle ?? 0) === cycle && r.result === 'won' && r.prizeType === 'diamond' && r.confirmedAt).reduce((s,r) => s+(r.diamondAmount ?? 0),0)
    const credit = allowProfit ? Math.min(p.reinvestCap, Math.floor(awards * p.reinvestRatio)) : 0
    const daily = entries.filter(x => x.state!=='confirmed'||((x.budgetCycle ?? 0) === cycle && dayKey(x.confirmedAt??x.at,p.timezone) === today)).reduce((s,x)=>s+x.cost,0)
    return { spent, lifetimeSpent, cycle, hasActivity: budgetHasActivity(a), reserved, awards, credit, effective: base + credit, remaining: Math.max(0, base+credit-spent-reserved), dailyRemaining: Math.max(0,p.dailySpend-daily) }
  }
  resetBudget(): boolean {
    return this.change(a => {
      if (a.session.phase !== 'stopped') throw new Error('请先停止运行并处理风险，再重置预算')
      if (Object.values(a.payments).some(p => ['reserved','submitted','unresolved'].includes(p.state)))
        throw new Error('存在预留或未决支付，请先核对后再重置预算')
      if (a.risks.some(r => r.resolvedAt === null)) throw new Error('请先处理风险提示')
      if (!budgetHasActivity(a)) return false
      a.budgetCycle = (a.budgetCycle ?? 0) + 1
      a.decisions = [...a.decisions, {at:this.now(),url:'',action:'budget-reset',reason:`用户开始第${a.budgetCycle + 1}轮预算并重置每日支出计数，保留历史账本及主播/新开团限制`,score:null,probability:null}].slice(-500)
      return true
    })
  }
  canPay(url: string, cost: number | null, base: number, allowProfit: boolean, p: Policy): string | null {
    if (cost === 0) return null
    if (cost === null || !Number.isFinite(cost) || cost <= 0) return '付费金额未知'
    const a=this.account(), room=a.rooms[url], b=this.budget(base,allowProfit,p), now=this.now()
    if (p.membership === 'existing') return '仅使用已有资格'
    if (!room || room.blocked) return '房间未知或已屏蔽'
    if (p.membership === 'whitelist' && !room.allowPaid) return '主播未获付费许可'
    if (cost > p.paymentLimit) return `单次支付上限不足：需要 ${cost} 钻，上限 ${p.paymentLimit} 钻`
    if (cost > b.remaining) return `本轮预算不足：需要 ${cost} 钻，可用 ${b.remaining} 钻（预留 ${b.reserved} 钻）`
    if (cost > b.dailyRemaining) return `每日预算不足：需要 ${cost} 钻，今日可用 ${b.dailyRemaining} 钻`
    const entries=Object.values(a.payments).filter(x=>x.state!=='failed')
    if (entries.filter(x=>x.roomUrl===url).reduce((s,x)=>s+x.cost,0)+cost>p.anchorSpend) return '主播支出达到上限'
    if (room.memberKnown!==true && entries.filter(x=>x.newClub && (x.state!=='confirmed'||dayKey(x.confirmedAt??x.at,p.timezone)===dayKey(now,p.timezone))).length>=p.dailyNewClubs) return '每日新开团数量达到上限'
    return null
  }
  reserve(url: string, lotteryId: string, cost: number, base: number, allowProfit: boolean, p: Policy): Payment {
    if (!lotteryId || lotteryId.startsWith('temporary:')) throw new Error('付费需要明确福袋身份')
    const roundKey=this.roundKey(url,lotteryId), id=`${roundKey}:badge`
    if (this.account().payments[id]) throw new Error('本轮已有支付记录，禁止重复支付')
    const reason=this.canPay(url,cost,base,allowProfit,p); if(reason) throw new Error(reason)
    return this.change(a => a.payments[id]={runId:a.runs?.find(r=>r.endedAt===null)?.id,budgetCycle:a.budgetCycle ?? 0,id,roundKey,roomUrl:url,cost,newClub:a.rooms[url].memberKnown!==true,at:this.now(),state:'reserved'})
  }
  payment(id: string, state: Payment['state']): void {
    this.change(a => {
      const payment=a.payments[id]; if(!payment) throw new Error('Unknown payment')
      if(payment.state==='confirmed' || payment.state==='failed') return
      payment.state=state
      if(state==='confirmed') { payment.confirmedAt=this.now();const r=a.rooms[payment.roomUrl]; if(r) { r.everPaid=true;r.memberKnown=true; r.membership='satisfied'; r.membershipAt=this.now() } }
    })
  }
  risk(reason: string, source: string): void {
    this.change(a => {
      if(!a.risks.some(r=>r.resolvedAt===null && r.reason===reason)) a.risks.push({at:this.now(),reason,source,resolvedAt:null})
      a.session.phase='blocked'; a.session.reason=reason; a.session.nextResumeAt=null
    })
  }
  resolveRisk(): void {
    this.change(a => {
      if(Object.values(a.payments).some(p=>p.state==='unresolved')) throw new Error('请先核对未决支付')
      for(const r of a.risks) if(r.resolvedAt===null) r.resolvedAt=this.now()
      a.session.phase='stopped'; a.session.reason='风险已确认处理，等待手动启动'
    })
  }
  decision(d: Omit<DecisionRecord,'at'>): void { this.change(a=>{
    a.decisions=[...a.decisions,{...d,at:this.now()}].slice(-500)
    const run=a.runs?.find(r=>r.endedAt===null)
    if(run && d.action==='skip')run.skipReasons[d.reason]=(run.skipReasons[d.reason]||0)+1
  }) }
  beginRun(source: string): void {
    this.change(a=>{
      if(a.runs?.some(r=>r.endedAt===null))throw new Error('上次运行尚未完成收尾')
      const now=this.now()
      ;(a.runs ||= []).push({id:`${now}-${a.runs?.length||0}`,startedAt:now,endedAt:null,reason:'',source,
        budgetCycle:a.budgetCycle??0,activeBaseline:Object.values(a.session.activeByDay).reduce((s,n)=>s+n,0),activeMs:0,skipReasons:{}})
    })
  }
  finishRun(reason: string): void {
    this.change(a=>{
      const r=a.runs?.find(r=>r.endedAt===null);if(!r)return
      r.silentEnd=Object.values(a.payments).some(p=>p.state==='unresolved')||a.risks.some(r=>r.source==='payment'&&r.resolvedAt===null)
      r.endedAt=this.now();r.reason=reason
      r.activeMs=Math.max(0,Object.values(a.session.activeByDay).reduce((s,n)=>s+n,0)-r.activeBaseline)
    })
  }
  skipCandidate(url:string,lotteryId:string,drawAt:number,today:boolean,timezone:string):void {
    this.change(a=>{
      if(today)(a.skippedDays ||= {})[url]=dayKey(this.now(),timezone)
      else (a.skippedRounds ||= {})[this.roundKey(url,lotteryId)]=drawAt
    })
    this.decision({url,action:'skip',reason:today?'用户选择今天不再参与此房间':'用户移除本轮候选',score:null,probability:null})
  }
  isSkipped(url:string,lotteryId?:string,timezone=DEFAULT_POLICY.timezone):boolean {
    const a=this.account()
    return a.skippedDays?.[url]===dayKey(this.now(),timezone) || !!(lotteryId && (a.skippedRounds?.[this.roundKey(url,lotteryId)]??0)>this.now())
  }
  setClaim(key:string,claimed:boolean):void {
    this.change(a=>{
      const r=a.rounds[key]
      if(!r || r.result!=='won' || r.confirmedAt===null || r.prizeType==='diamond')throw new Error('只能处理已确认的非钻石中奖记录')
      r.claimed=claimed;r.updatedAt=this.now()
      if(claimed)for(const n of a.alerts||[])if(n.id===`claim:${key}`)n.dismissedAt=this.now()
    })
  }
  alert(alert:Omit<UserAlert,'at'|'dismissedAt'>):void {
    this.change(a=>{if(!(a.alerts||[]).some(n=>n.id===alert.id))(a.alerts ||= []).push({...alert,at:this.now(),dismissedAt:null})})
  }
  dismissAlert(id:string):void {this.change(a=>{const n=a.alerts?.find(n=>n.id===id);if(n)n.dismissedAt=this.now()})}

  stats() {
    const a=this.account(), records=Object.values(a.rounds).filter(r=>r.createdAt>=a.statsSince)
    const confirmed=records.filter(r=>r.confirmedAt)
    return { participated:confirmed.length, physicalWins:confirmed.filter(r=>r.result==='won'&&r.prizeType==='physical').length,
      diamondWins:confirmed.filter(r=>r.result==='won'&&r.prizeType==='diamond').length,
      diamondWonAmount:confirmed.filter(r=>r.result==='won'&&r.prizeType==='diamond').reduce((s,r)=>s+(r.diamondAmount ?? 0),0),
      couponWins:confirmed.filter(r=>r.result==='won'&&r.prizeType==='coupon').length,
      submittedUnknown:records.filter(r=>r.submittedAt&&!r.confirmedAt).length,
      unknownResults:confirmed.filter(r=>r.result==='unknown').length,
      lastStartedAt:a.session.startedAt,lastStoppedAt:a.session.phase==='stopped'?a.session.lastTickAt:null }
  }
}
