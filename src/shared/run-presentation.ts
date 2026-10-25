import type { SessionRecord } from './policy'
import { roomDisplayName } from './record-presentation'

export function waitingForScheduledStop(s: Pick<SessionRecord, 'phase' | 'stopAt' | 'nextResumeAt'>): boolean {
  return s.phase === 'resting' && s.stopAt !== null && s.nextResumeAt !== null && s.stopAt <= s.nextResumeAt
}
export function sessionDisplayReason(s: SessionRecord): string {
  return waitingForScheduledStop(s) ? '本轮已完成，等待定时结束' : s.reason
}
type Slot = { url:string; name?:string; evaluation:{startAt:number;endAt:number;navigationAt?:number} }
/** Explain the already-selected combination; never change selection or its timing. */
export function scheduleExclusionReason(candidate:Slot, selected:Slot[], gapSeconds:number, limit:number, timezone:string):string {
  const time=(at:number)=>new Date(at).toLocaleTimeString('zh-CN',{timeZone:timezone,hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})
  const a=candidate.evaluation
  const reasons=selected.flatMap(other=>{
    const b=other.evaluation, label=`${roomDisplayName(other.name,other.url)}（预约 ${time(b.startAt)}）`
    const overlap=Math.min(a.endAt,b.endAt)-Math.max(a.startAt,b.startAt)
    const gap=Math.abs((a.navigationAt??a.startAt)-(b.navigationAt??b.startAt))/1000
    const details:string[]=[]
    if(overlap>0)details.push(`与${label}的任务占用重叠 ${Math.ceil(overlap/1000)} 秒（含开奖核对与切换预留）`)
    if(gap<gapSeconds)details.push(`与${label}的导航间隔约 ${Math.floor(gap)} 秒，要求 ${gapSeconds} 秒，还差 ${Math.ceil(gapSeconds-gap)} 秒`)
    return details
  })
  if(reasons.length)return `与已预约候选冲突：${reasons.join('；')}；保留综合效用更优的预约组合`
  return selected.length>=limit ? `候选队列已满（${limit}个），保留综合效用更优的预约组合` : '本次组合排序未选中，保留综合效用更优的预约组合'
}
