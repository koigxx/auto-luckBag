/** Read-only observations. Never use these values to authorize an action. */
export type ActivityKind = 'task' | 'discovery' | 'waiting' | 'resting' | 'checking' | 'stopped' | 'blocked'
export interface ActivityObservation {
  kind: ActivityKind
  reason: string
  next: 'task' | 'discover' | 'verify' | 'resume' | 'rest' | 'stop' | 'manual'
  nextAt: number | null
  observedAt: number
}
export interface ActivityTiming { totals: Partial<Record<ActivityKind, number>>; lastAt: number; kind: ActivityKind }
export function sampleTiming(previous: ActivityTiming | undefined, kind: ActivityKind, now: number): ActivityTiming {
  const totals = { ...previous?.totals }
  const gap = previous ? now - previous.lastAt : 0
  if (previous && gap > 0 && gap <= 90000 && !['stopped','blocked'].includes(previous.kind))
    totals[previous.kind] = (totals[previous.kind] || 0) + gap
  return { totals, lastAt: now, kind }
}
export function activityLabel(kind: ActivityKind, en = false): string {
  return ({ task:['房间任务与开奖','Room tasks & draw'],discovery:['发现与验证','Discovery & verification'],waiting:['调度等待','Scheduler wait'],resting:['计划休息','Planned break'],checking:['登录与恢复检查','Session check'],stopped:['已停止','Stopped'],blocked:['异常待处理','Needs attention'] }[kind])[en?1:0]
}
export function nextActionLabel(next: ActivityObservation['next'], en = false): string {
  return ({task:['继续核对本轮任务与结果','Continue checking tasks and results'],discover:['扫描入口发现房间','Scan for rooms'],verify:['验证房间资格与费用','Verify eligibility and cost'],resume:['检查条件后恢复','Check conditions before resuming'],rest:['进入计划休息','Start the planned break'],stop:['结束本次运行','End this run'],manual:['等待你处理后手动启动','Wait for manual handling and start']}[next])[en?1:0]
}
export function runStatusLabel(status: string, background = false, en = false): string {
  const label = ({running:['正在运行','Running'],draining:['正在收尾','Finishing up'],resting:['计划休息中','On a planned break'],'resume-check':['检查恢复条件','Checking before resume'],blocked:['需要你处理','Needs your attention'],stopped:['已停止','Stopped']} as Record<string,string[]>)[status]?.[en?1:0] || status
  return status==='running' && background ? (en?'Background · ':'后台 · ')+label : label
}
export interface LogContext { runId?: string; roomUrl?: string; lotteryId?: string; from?: number; to?: number }
export interface LinkedLog { time: number; runId?: string; roomUrl?: string; lotteryId?: string; message: string }
export function matchesLog(log: LinkedLog, context: LogContext | null): boolean {
  return !context || ((!context.runId || log.runId===context.runId) && (!context.roomUrl || log.roomUrl===context.roomUrl) &&
    (!context.lotteryId || log.lotteryId===context.lotteryId) && (context.from==null || log.time>=context.from) && (context.to==null || log.time<=context.to))
}
// Intentionally excludes raw messages, URLs, identities and arbitrary status strings.
export function diagnosticSummary(logs: LinkedLog[], context: LogContext | null): string {
  const times=logs.map(l=>l.time).filter(Number.isFinite)
  return ['福袋助手诊断摘要 / Diagnostic summary',`记录数 / Events: ${logs.length}`,
    `筛选维度 / Filters: ${['runId','roomUrl','lotteryId','from','to'].filter(k=>context?.[k as keyof LogContext]!=null).join(', ') || 'none'}`,
    `首条 / First: ${times.length?new Date(Math.min(...times)).toISOString():'—'}`,
    `末条 / Last: ${times.length?new Date(Math.max(...times)).toISOString():'—'}`,
    '仅包含当前打开应用后的可用日志统计；未包含消息内容或标识。'].join('\n')
}
export interface ConfigDifference { key: string; before: unknown; after: unknown }
export function configDifferences(before: Record<string, any>, after: Record<string, any>, prefix=''): ConfigDifference[] {
  return Object.keys(after).flatMap(key=>{
    const a=before[key], b=after[key], path=prefix?`${prefix}.${key}`:key
    if(b && typeof b==='object' && !Array.isArray(b))return configDifferences(a || {},b,path)
    return Object.is(a,b)?[]:[{key:path,before:a,after:b}]
  })
}
