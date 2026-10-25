import { ipcMain,BrowserWindow,dialog,shell } from 'electron'
import fs from 'fs'
import { BrowserManager } from './browser-manager'
import { AuthService } from './auth-service'
import { RoomManager } from './room-manager'
import { DiscoveryService } from './discovery-service'
import { store } from './store'
import { setupAppMenu } from './app-menu'
import { StatsService } from './stats-service'
import { AutoRunner } from './auto-runner'
import { currentBudget,policy,repository,setExecutionLogger } from './runtime'
import { validateConfigPatch } from '../shared/config-validation'
import { normalizeRoomUrl } from '../shared/policy'
import { runReports,budgetCycles } from '../shared/review'
import { dayKey } from './runtime-repository'

export function setupIpcHandlers(win:BrowserWindow,_browser:BrowserManager,auth:AuthService,rooms:RoomManager,discovery:DiscoveryService,stats:StatsService,runner:AutoRunner):void {
  const send=(channel:string,data:unknown)=>{if(!win.isDestroyed())win.webContents.send(channel,data)}
  const log=(roomId:string,message:string)=>send('log:add',{roomId,roomName:rooms.getRoom(roomId)?.name,message,time:Date.now()})
  setExecutionLogger(message=>log('auto',message))
  rooms.setCallbacks(r=>send('room:update',rooms.getRoomPublicInfo(r.id)),log,(_room,result)=>stats.recordParticipation(result),id=>send('room:removed',id))
  discovery.setLogger(m=>log('discover',m));stats.setOnUpdate(s=>send('run-stats:update',s));runner.setCallbacks(m=>log('auto',m),s=>send('auto-run:update',s))
  const safe=(fn:(...args:any[])=>unknown)=>async(_event:unknown,...args:any[])=>{try{return await fn(...args)}catch(e:any){return {success:false,error:e.message,state:runner.getState()}}}
  ipcMain.handle('auth:login',safe(async()=>{await runner.stop('登录切换');return {success:await auth.login(),isLoggedIn:auth.getLoginStatus()}}))
  ipcMain.handle('auth:logout',safe(async()=>{await runner.stop('退出账号');await auth.logout();return {success:true}}))
  ipcMain.handle('auth:status',async(_event,force=false)=>{await auth.restoreSession(force===true);return auth.getStatus()})
  ipcMain.handle('room:add',safe(async(url:string,name?:string)=>{const room=await runner.manualRoom(url,name);return {success:true,room:rooms.getRoomPublicInfo(room.id)}}))
  ipcMain.handle('room:remove',safe(async(id:string)=>{await rooms.removeRoom(id);return {success:true}}))
  ipcMain.handle('room:list',()=>rooms.getAllRoomsPublicInfo())
  ipcMain.handle('discovery:scan',safe(async(options={})=>({success:true,...await runner.manualScan(options)})))
  ipcMain.handle('discovery:addFastest',safe(async()=>{throw new Error('请启动自动运行，由调度器验证并选择房间')}))
  const config=()=>({...store.store,policy:policy(),autoFollow:true,diamondUsed:repository.read().activeAccount?currentBudget().spent:store.get('diamondUsed'),runStats:stats.getStats()})
  ipcMain.handle('config:get',config)
  ipcMain.handle('config:set',safe((input:unknown)=>{
    const patch=validateConfigPatch(input)
    if(runner.getState().running&&Object.keys(patch).some(k=>k!=='language'&&k!=='debugLogs'))throw new Error('请停止当前计划后修改策略，避免运行中改变预算和时间约束')
    for(const [key,value] of Object.entries(patch))store.set(key as any,value)
    if(patch.language)setupAppMenu(win)
    return {success:true,config:config()}
  }))
  ipcMain.handle('config:resetDiamondUsed',safe(()=>{
    if(runner.getState().running || rooms.getAllRooms().length) throw new Error('请先停止计划及所有房间任务')
    const changed=repository.resetBudget()
    stats.publish()
    return {success:true,changed,config:config(),budget:currentBudget()}
  }))
  ipcMain.handle('stats:get',()=>{
    const budget=repository.read().activeAccount?currentBudget():{effective:store.get('diamondBudget'),spent:0,reserved:0,remaining:store.get('diamondBudget')}
    return {totalFudai:stats.getStats().participated,activeRooms:rooms.getAllRooms().length,diamondBudget:budget.effective,diamondUsed:budget.spent,diamondReserved:budget.reserved,diamondRemaining:budget.remaining}
  })
  ipcMain.handle('runStats:get',()=>stats.getStats())
  ipcMain.handle('runStats:reset',()=>stats.reset())
  ipcMain.handle('autoRun:start',safe(async(options={})=>({success:true,state:await runner.start(options)})))
  ipcMain.handle('autoRun:stop',safe(async()=>({success:true,state:await runner.stop()})))
  ipcMain.handle('autoRun:finish',safe(async()=>({success:true,state:await runner.finishCurrent()})))
  ipcMain.handle('autoRun:skip',safe((url:string,id:string,today:boolean)=>{
    if(typeof url!=='string'||typeof id!=='string'||typeof today!=='boolean')throw new Error('无效候选操作')
    runner.removeCandidate(url,id,today);return {success:true,state:runner.getState()}
  }))
  ipcMain.handle('insights:claim',safe((key:string,claimed:boolean)=>{
    if(typeof key!=='string'||typeof claimed!=='boolean')throw new Error('无效领取操作')
    repository.setClaim(key,claimed);return {success:true}
  }))
  ipcMain.handle('insights:openClaim',safe(async(key:string)=>{
    const r=repository.account().rounds[key]
    if(!r||r.result!=='won'||r.confirmedAt===null||r.prizeType==='diamond')throw new Error('没有可处理的中奖记录')
    await shell.openExternal(normalizeRoomUrl(r.roomUrl));return {success:true}
  }))
  ipcMain.handle('alerts:dismiss',safe((id:string)=>{repository.dismissAlert(id);return {success:true}}))
  ipcMain.handle('autoRun:status',()=>runner.getState())
  ipcMain.handle('insights:get',()=>{
    if(!repository.read().activeAccount)return null
    const a=repository.account(),records=Object.values(a.rounds),payments=Object.values(a.payments),confirmed=records.filter(r=>r.confirmedAt)
    const paid=payments.filter(p=>p.state==='confirmed'),reused=confirmed.filter(r=>paid.some(p=>p.roomUrl===r.roomUrl&&p.at<r.createdAt)&&!payments.some(p=>p.roundKey===r.key&&p.state!=='failed'))
    return {reports:runReports(a),cycles:budgetCycles(a),alerts:a.alerts||[],rooms:Object.values(a.rooms),rounds:records.reverse(),payments:payments.reverse(),risks:a.risks,decisions:a.decisions.slice().reverse(),session:a.session,budget:currentBudget(),legacy:a.legacyStats,
      metrics:{visits:Object.values(a.rooms).reduce((s,r)=>s+r.visits.length,0),confirmed:confirmed.length,
        reuse:confirmed.length?reused.length/confirmed.length:0,
        reusePerPayment:paid.length?reused.length/paid.length:0,
        costPerRound:confirmed.length?paid.reduce((sum,p)=>sum+p.cost,0)/confirmed.length:0,
        activeMinutes:(a.session.activeByDay[dayKey(Date.now(),policy().timezone)]||0)/60000,
        unknown:records.filter(r=>r.result==='unknown').length}}
  })
  ipcMain.handle('insights:room',safe((url:string,patch:Record<string,unknown>)=>{
    if(!patch||Object.keys(patch).some(k=>!['favorite','blocked','allowPaid'].includes(k))||Object.values(patch).some(v=>typeof v!=='boolean'))throw new Error('无效房间设置')
    if(runner.getState().running)throw new Error('请停止计划后修改房间设置')
    repository.updateRoom(url,patch);return {success:true}
  }))
  ipcMain.handle('insights:payment',safe((id:string,state:string)=>{
    if(runner.getState().running)throw new Error('请先停止计划并核对真实扣款记录')
    if(!['confirmed','failed'].includes(state)||repository.account().payments[id]?.state!=='unresolved')throw new Error('只能核对未决支付')
    repository.payment(id,state as 'confirmed'|'failed')
    repository.decision({url:'',action:'reconcile',reason:`用户核对支付为 ${state}`,score:null,probability:null})
    return {success:true}
  }))
  ipcMain.handle('insights:resolveRisk',safe(()=>{repository.resolveRisk();send('auto-run:update',runner.getState());return {success:true}}))
  ipcMain.handle('insights:export',safe(async()=>{
    const result=await dialog.showSaveDialog(win,{defaultPath:'luckbag-review.json',filters:[{name:'JSON',extensions:['json']}]})
    if(result.canceled||!result.filePath)return {success:false,error:'已取消导出'}
    const a=repository.account(),urls=Object.keys(a.rooms),alias=(url:string)=>`room-${urls.indexOf(url)+1}`
    // An allowlist export excludes cookies, account hashes, names, raw URLs, comments and page text.
    const data={version:2,exportedAt:Date.now(),policy:policy(),budget:currentBudget(),cycles:budgetCycles(a),
      reports:runReports(a).map(r=>({startedAt:r.startedAt,endedAt:r.endedAt,activeMs:r.activeMs,budgetCycle:r.budgetCycle,confirmed:r.confirmed,won:r.won,lost:r.lost,unknown:r.unknown,pending:r.pending,spent:r.spent,reserved:r.reserved})),
      rooms:Object.values(a.rooms).map(r=>({id:alias(r.url),favorite:r.favorite,blocked:r.blocked,membership:r.membership,visits:r.visits})),
      rounds:Object.values(a.rounds).map(r=>({room:alias(r.roomUrl),createdAt:r.createdAt,drawAt:r.drawAt,submittedAt:r.submittedAt,confirmedAt:r.confirmedAt,result:r.result,prizeType:r.prizeType,diamondAmount:r.diamondAmount,taskSeconds:r.taskSeconds})),
      payments:Object.values(a.payments).map(p=>({room:alias(p.roomUrl),budgetCycle:p.budgetCycle??0,at:p.at,cost:p.cost,state:p.state,newClub:p.newClub})),
      decisions:a.decisions.map(d=>({room:alias(d.url),at:d.at,action:d.action,score:d.score,probability:d.probability,seed:d.seed,
        evidence:d.snapshot?{version:d.snapshot.version,leadSeconds:d.snapshot.leadSeconds,utility:d.snapshot.utility,mode:d.snapshot.mode,sampleCount:d.snapshot.sampleCount,
          source:d.snapshot.opportunity.source,observedAt:d.snapshot.opportunity.observedAt,drawAt:d.snapshot.opportunity.drawAt,cost:d.snapshot.opportunity.cost,
          winnerCount:d.snapshot.opportunity.winnerCount,participantCount:d.snapshot.opportunity.participantCount,prizeType:d.snapshot.opportunity.prizeType}:undefined}))}
    fs.writeFileSync(result.filePath,JSON.stringify(data,null,2),'utf8');return {success:true,path:result.filePath}
  }))
}
