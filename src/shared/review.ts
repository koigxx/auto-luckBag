import type { AccountData } from './policy'
import { riskId } from './policy'
export function runReports(a:AccountData) {
  return (a.runs||[]).map(run=>{
    const rounds=Object.values(a.rounds).filter(r=>r.runId===run.id)
    const payments=Object.values(a.payments).filter(p=>p.runId===run.id)
    const confirmed=rounds.filter(r=>r.confirmedAt!==null)
    const activeMs=run.endedAt===null?Math.max(0,Object.values(a.session.activeByDay).reduce((s,n)=>s+n,0)-run.activeBaseline):run.activeMs
    return {...run,activeMs,confirmed:confirmed.length,won:confirmed.filter(r=>r.result==='won').length,
      lost:confirmed.filter(r=>r.result==='lost').length,unknown:rounds.filter(r=>r.result==='unknown').length,
      pending:rounds.filter(r=>r.result==='pending').length,
      spent:payments.filter(p=>p.state==='confirmed').reduce((s,p)=>s+p.cost,0),
      reserved:payments.filter(p=>['reserved','submitted','unresolved'].includes(p.state)).reduce((s,p)=>s+p.cost,0)}
  }).reverse()
}
export function budgetCycles(a:AccountData) {
  return Array.from({length:(a.budgetCycle??0)+1},(_,cycle)=>{
    const payments=Object.values(a.payments).filter(p=>(p.budgetCycle??0)===cycle)
    const rounds=Object.values(a.rounds).filter(r=>(r.budgetCycle??0)===cycle)
    return {cycle,spent:(cycle===0?a.openingSpent:0)+payments.filter(p=>p.state==='confirmed').reduce((s,p)=>s+p.cost,0),
      reserved:payments.filter(p=>['reserved','submitted','unresolved'].includes(p.state)).reduce((s,p)=>s+p.cost,0),
      confirmed:rounds.filter(r=>r.confirmedAt!==null).length}
  }).reverse()
}
// Blocked payment runs deliberately remain in records without a popup.
export function pendingAlerts(a:AccountData) {
  const existing=new Set((a.alerts||[]).map(n=>n.id))
  const alerts: import('./policy').UserAlert[]=[]
  for(const risk of a.risks)if(risk.resolvedAt===null && risk.source!=='payment' && !/支付|付款|扣款|未决/.test(risk.reason) && !existing.has(riskId(risk)))
    alerts.push({id:riskId(risk),kind:'risk',title:'异常待办需要处理',message:`自动运行已停止：${risk.reason}。请前往任务浏览器人工处理，完成后仍需手动启动。`,at:risk.at,dismissedAt:null})
  for(const r of Object.values(a.rounds))if(r.result==='won'&&r.confirmedAt!==null&&r.prizeType!=='diamond'&&!r.claimed&&!existing.has(`claim:${r.key}`))
    alerts.push({id:`claim:${r.key}`,kind:'claim',title:r.prizeType==='physical'?'实物中奖，待填写领取信息':'中奖奖励待核对领取',
      message:`${a.rooms[r.roomUrl]?.name||'直播间'}：${r.prizeName||'奖励已确认'}。请前往抖音核对领取要求与期限，处理后标记完成。`,at:r.updatedAt,dismissedAt:null})
  for(const run of a.runs||[])if(!run.silentEnd&&run.endedAt!==null&&!existing.has(`ended:${run.id}`)&&!['登录切换','退出账号','应用退出'].includes(run.reason)&&
    !/支付|付款|扣款|预算|未决/.test(run.reason) && !a.risks.some(r=>r.at>=run.startedAt && r.at<=run.endedAt! && r.reason===run.reason))
    alerts.push({id:`ended:${run.id}`,kind:'ended',title:'运行已结束',message:run.reason||'本次运行已结束，可查看运行报告。',at:run.endedAt,dismissedAt:null})
  return alerts
}

export function sortAlerts(alerts:import('./policy').UserAlert[]) {
  const priority={risk:0,login:1,claim:2,ended:3}
  return alerts.filter(n=>n.dismissedAt===null).slice().sort((a,b)=>priority[a.kind]-priority[b.kind]||a.at-b.at)
}
