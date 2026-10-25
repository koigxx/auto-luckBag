import { Policy, SessionRecord, emptySession } from '../shared/policy'
import { RuntimeRepository, allowedNow, dayKey } from './runtime-repository'

export function seededRandom(seed: number): () => number {
  let state=seed>>>0
  return () => { state=(Math.imul(1664525,state)+1013904223)>>>0; return state/4294967296 }
}
export class SessionEngine {
  private lastClockSample:{wall:number;monotonic:number}|null=null
  constructor(private repo: RuntimeRepository, private random: () => number = Math.random,private monotonic?:()=>number) {}
  start(policy: Policy, stopAt: number | null = null): SessionRecord {
    const a=this.repo.account(), now=this.repo.now()
    if(a.risks.some(r=>r.resolvedAt===null)) throw new Error('风险尚未处理，请先查看风险记录')
    if(Object.values(a.payments).some(p=>p.state==='unresolved')) throw new Error('存在未决支付，请先核对')
    if(!allowedNow(now,policy)) throw new Error('当前不在允许运行时段')
    if(stopAt!==null&&stopAt<=now)throw new Error('定时停止时间已过')
    const used=a.session.activeByDay[dayKey(now,policy.timezone)]||0
    if(used>=policy.dailyMinutes*60000) throw new Error('今日活跃时间已达上限')
    const seed=Math.floor(this.random()*0xffffffff), rng=seededRandom(seed)
    const duration=(policy.sessionMin+rng()*(policy.sessionMax-policy.sessionMin))*60000
    let allowedEnd=Infinity
    if(policy.allowedStart!==policy.allowedEnd)for(let at=now-now%60000+60000;at<=now+duration;at+=60000){if(!allowedNow(at,policy)){allowedEnd=at;break}}
    const segmentLimitAt=Math.min(now+duration,now+policy.dailyMinutes*60000-used,allowedEnd)
    const hardStopAt=Math.min(segmentLimitAt,stopAt??Infinity)
    if(this.monotonic)this.lastClockSample={wall:now,monotonic:this.monotonic()}
    return this.repo.change(a=>a.session={...emptySession(),activeByDay:a.session.activeByDay,policy:{...policy},phase:'running',
      segmentLimitAt,startedAt:now,drainAt:Math.max(now,hardStopAt-90000),hardStopAt,stopAt,nextResumeAt:null,lastTickAt:now,seed,reason:''})
  }
  tick(hasRoom: boolean): SessionRecord {
    const now=this.repo.now()
    let clockChanged=false
    if(this.monotonic){const mono=this.monotonic();if(this.lastClockSample)clockChanged=Math.abs((now-this.lastClockSample.wall)-(mono-this.lastClockSample.monotonic))>5000;this.lastClockSample={wall:now,monotonic:mono}}
    return this.repo.change(a=>{
      const s=a.session,p=s.policy,last=s.lastTickAt
      if(clockChanged&&!['blocked','stopped'].includes(s.phase)){s.phase='stopped';s.reason='系统时钟发生变化，请检查后手动恢复';s.nextResumeAt=null}
      if(['running','draining'].includes(s.phase) && last!==null) {
        const gap=now-last
        if(gap<0 || gap>90000) { s.phase='stopped';s.reason='检测到休眠或时钟变化，请手动恢复';s.nextResumeAt=null }
        else {
          // Split a tick at a local calendar boundary; a tick is at most 90 seconds.
          let from=last
          const accountedUntil=Math.min(now,s.hardStopAt??now,s.stopAt??now)
          while(from<accountedUntil) { const end=Math.min(accountedUntil,from+1000),day=dayKey(from,p.timezone); s.activeByDay[day]=(s.activeByDay[day]||0)+(end-from);from=end }
        }
      }
      s.lastTickAt=now
      if(s.phase==='blocked'||s.phase==='stopped') return s
      if(s.stopAt!==null && now>=s.stopAt) {s.phase='stopped';s.reason='定时停止';s.nextResumeAt=null;return s}
      if(a.risks.some(r=>r.resolvedAt===null)) {s.phase='blocked';s.nextResumeAt=null;return s}
      if(s.phase==='resting') {
        if(s.nextResumeAt!==null && now>=s.nextResumeAt) {s.phase=p.autoResume?'resume-check':'stopped';s.reason=p.autoResume?'等待恢复检查':'计划休息结束，等待手动启动'}
        return s
      }
      if(s.phase==='resume-check') return s
      const daily=s.activeByDay[dayKey(now,p.timezone)]||0
      if(!allowedNow(now,p) || daily>=p.dailyMinutes*60000) {s.phase='stopped';s.reason='允许时段或每日活跃额度已结束';s.nextResumeAt=null;return s}
      if(s.finishRequested) {
        s.phase='draining';s.reason='收尾后停止：不再接新轮'
        if(!hasRoom || now>=(s.hardStopAt??Infinity)){s.phase='stopped';s.reason=hasRoom?'收尾到达硬截止，已停止':'本轮收尾完成，已停止';s.nextResumeAt=null}
        return s
      }
      if(now>=(s.drainAt??Infinity)) {s.phase='draining';s.reason='停止接新任务，等待本轮收尾'}
      if(now>=(s.hardStopAt??Infinity) || (s.phase==='draining'&&!hasRoom)) {
        const rng=seededRandom(s.seed^0x51f15e)
        s.phase='resting';s.nextResumeAt=now+(p.breakMin+rng()*(p.breakMax-p.breakMin))*60000;s.reason='计划休息'
      }
      return s
    })
  }
  extend(minutes: number, expectedStopAt: number): SessionRecord {
    const now=this.repo.now(), a=this.repo.account(), s=a.session
    if(!Number.isInteger(minutes)||minutes<1||minutes>120)throw new Error('每次延长时间须为1–120分钟')
    if(!['running','draining','resting'].includes(s.phase)||s.finishRequested)throw new Error('当前运行已停止、正在检查或已请求结束，不能延长')
    if(a.risks.some(r=>r.resolvedAt===null)||Object.values(a.payments).some(p=>p.state==='unresolved'))throw new Error('存在待处理异常，不能延长')
    if(s.stopAt===null||s.stopAt<=now)throw new Error('没有可延长的定时运行，或结束时间已到')
    if(s.stopAt!==expectedStopAt)throw new Error('结束时间已变化，请重新确认')
    const stopAt=s.stopAt+minutes*60000
    if(stopAt-now>1440*60000)throw new Error('定时结束最多可设置到24小时后')
    // Never reroll a segment, replenish daily time or interrupt an existing rest.
    return this.repo.change(a=>{
      const s=a.session
      s.stopAt=stopAt
      if(s.phase==='running') {
        s.hardStopAt=Math.min(s.segmentLimitAt??s.hardStopAt??now,stopAt)
        s.drainAt=Math.max(s.startedAt??now,s.hardStopAt-90000)
      }
      return s
    })
  }
  requestFinish():void {this.repo.change(a=>{const s=a.session;if(['running','draining'].includes(s.phase)){s.finishRequested=true;s.phase='draining';s.nextResumeAt=null;s.reason='收尾后停止：不再接新轮'}})}
  stop(reason='手动停止'): void {this.repo.change(a=>{if(['stopped','blocked'].includes(a.session.phase))return;a.session.phase=a.risks.some(r=>r.resolvedAt===null)?'blocked':'stopped';a.session.reason=reason;a.session.nextResumeAt=null;a.session.lastTickAt=this.repo.now()})}
  canFinish(drawAt: number, bufferMs=25000): boolean {const s=this.repo.account().session;return s.phase==='running'&&drawAt+bufferMs<=(s.hardStopAt??0)}
}
