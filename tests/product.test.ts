import test from 'node:test'
import assert from 'node:assert/strict'
import {RuntimeRepository,emptyRuntime} from '../src/main/runtime-repository'
import {SessionEngine} from '../src/main/session-engine'
import {DEFAULT_POLICY,riskId} from '../src/shared/policy'
import {defaults,participationPreset} from '../src/shared/config'
import {runReports,budgetCycles,pendingAlerts,sortAlerts} from '../src/shared/review'
import {inRun,recordTotals,roomDisplayName,discoveryRoomName} from '../src/shared/record-presentation'
import {returnProgress,timeProgress} from '../src/shared/display-progress'
const url='https://live.douyin.com/12345678'
test('display progress uses pushed time, keeps unknown unknown, and clamps deadline boundaries',()=>{
  assert.equal(returnProgress({verifiedAt:1000,startAt:101000,entryRemainingSeconds:60}),40)
  assert.equal(returnProgress({verifiedAt:1000,startAt:101000,entryRemainingSeconds:0}),100)
  assert.equal(timeProgress(1000,101000,150),0)
  assert.equal(timeProgress(1000,101000,-1),100)
  assert.equal(timeProgress(null,101000,10),null)
  assert.equal(timeProgress(1000,1000,0),null)
  assert.equal(timeProgress(1000,101000,NaN),null)
  assert.equal(returnProgress({startAt:101000,entryRemainingSeconds:60}),null)
})
function fixture(){let data=emptyRuntime(),now=Date.UTC(2026,9,25,2);const repo=new RuntimeRepository({read:()=>data,write:d=>{data=structuredClone(d)}},()=>now);repo.bind('a',{spent:0,stats:{},rooms:[]});repo.room(url);return {repo,advance:(ms:number)=>now+=ms}}
test('issue todos persist, dismiss independently, and resolve individually without resuming',()=>{
  const {repo:r,advance}=fixture();r.beginRun('home')
  r.risk('请完成下列验证后继续','visible-challenge',url)
  r.risk('请完成下列验证后继续','visible-challenge',url)
  assert.equal(r.account().risks.length,1)
  const first=r.account().risks[0],id=riskId(first)
  for(const n of pendingAlerts(r.account()))r.alert(n)
  r.dismissAlert(id)
  assert.equal(first.resolvedAt,null)
  assert.equal(pendingAlerts(r.account()).length,0)
  r.finishRun(first.reason)
  advance(1);r.risk('手机验证码','visible-challenge',url)
  const second=riskId(r.account().risks[1])
  r.recover();r.bind('a',{spent:0,stats:{},rooms:[]})
  r.resolveRisk(id)
  assert.equal(r.account().risks.filter(x=>x.resolvedAt===null).length,1)
  assert.equal(r.account().session.phase,'blocked')
  r.resolveRisk(second)
  assert.equal(r.account().session.phase,'stopped')
  assert.equal(r.account().session.nextResumeAt,null)
  assert.equal(pendingAlerts(r.account()).length,0)
  assert.throws(()=>r.resolveRisk(id),/不存在/)
})

test('issue completion cannot release pending payments or resolve another account',()=>{
  const {repo:r}=fixture()
  const payment=r.reserve(url,'test',1,50,false,DEFAULT_POLICY)
  r.risk('验证','visible-challenge',url)
  const id=riskId(r.account().risks[0])
  for(const state of ['reserved','submitted','unresolved'] as const){
    r.payment(payment.id,state)
    assert.throws(()=>r.resolveRisk(id),/未决支付/)
    assert.equal(r.budget(50,false,DEFAULT_POLICY).reserved,1)
  }
  r.bind('other',{spent:0,stats:{},rooms:[]})
  assert.throws(()=>r.resolveRisk(id),/不存在/)
})
test('record room titles preserve known names and use room IDs without inventing names',()=>{
  assert.equal(roomDisplayName(' 某主播 ',url),'某主播')
  assert.equal(roomDisplayName('直播中',url),'直播间 12345678')
  assert.equal(roomDisplayName('点击进入直播间',url),'直播间 12345678')
  assert.equal(roomDisplayName('你的关注 示例直播标题 @测试主播 1.2万',url),'测试主播')
  assert.equal(roomDisplayName('你的关注 示例直播标题 @主播 2026 1234',url),'主播 2026')
  assert.equal(roomDisplayName('主播 @名字 123',url),'主播 @名字 123')
  assert.equal(roomDisplayName(undefined,url,true),'Room 12345678')
  assert.equal(roomDisplayName(url,url),'直播间 12345678')
  assert.equal(roomDisplayName(undefined,''),'系统')
  assert.equal(roomDisplayName(undefined,'not-a-url'),'未记录名称的直播间')
})
test('record scopes use persisted run ownership and keep unresolved spending separate',()=>{
  assert.equal(inRun({runId:'old'},'new'),false)
  assert.equal(inRun({runId:'old'},'old'),true)
  assert.equal(inRun({},'unassigned'),true)
  assert.equal(inRun({},'old'),false)
  assert.equal(inRun({runId:'old'},''),true)
  assert.equal(inRun({runId:'old'},'unassigned'),false)
  const {repo:r}=fixture()
  r.record(url,'won',{confirmedAt:r.now(),result:'won'})
  r.record(url,'unknown',{result:'unknown'})
  r.record(url,'cancelled',{result:'cancelled'})
  const p=r.reserve(url,'won',1,50,false,DEFAULT_POLICY);r.payment(p.id,'confirmed')
  const q=r.reserve(url,'unknown',1,50,false,DEFAULT_POLICY);r.payment(q.id,'submitted');r.payment(q.id,'unresolved')
  const total=recordTotals(Object.values(r.account().rounds),Object.values(r.account().payments))
  assert.deepEqual(total,{confirmed:1,won:1,lost:0,unknown:1,pending:0,spent:1,reserved:1})
})
test('run reports persist one run across rest, attribute money and late results, preserve first ending',()=>{
  const h=fixture(),r=h.repo,e=new SessionEngine(r,()=>0.5)
  e.start(DEFAULT_POLICY);r.beginRun('home');r.record(url,'one',{confirmedAt:r.now(),result:'unknown'})
  const p=r.reserve(url,'one',1,50,false,DEFAULT_POLICY);r.payment(p.id,'submitted')
  h.advance(60000);e.tick(true);e.stop('定时停止');r.finishRun(r.account().session.reason)
  e.stop('应用退出');r.finishRun('覆盖')
  assert.equal(r.account().session.reason,'定时停止');assert.equal(runReports(r.account())[0].reason,'定时停止')
  e.start(DEFAULT_POLICY);r.beginRun('home');r.payment(p.id,'confirmed');r.record(url,'one',{result:'won',prizeType:'physical',prizeName:'奖品'})
  const [current,old]=runReports(r.account());assert.equal(current.spent,0);assert.equal(old.spent,1);assert.equal(old.won,1);assert.equal(old.unknown,0);assert.equal(old.activeMs,60000)
  r.recover();r.bind('a',{spent:0,stats:{},rooms:[]})
  assert.equal(runReports(r.account())[0].reason,'应用意外退出，运行已中断');assert.equal(runReports(r.account())[1].reason,'定时停止')
})
test('finish current stops at round end, never resumes, and respects hard and scheduled deadlines',()=>{
  for(const forced of [false,true]){
    const h=fixture(),e=new SessionEngine(h.repo,()=>0.5);e.start({...DEFAULT_POLICY,sessionMin:1,sessionMax:1});e.requestFinish()
    assert.equal(e.tick(true).phase,'draining')
    if(forced)h.advance(60000)
    const done=e.tick(forced);assert.equal(done.phase,'stopped');assert.equal(done.nextResumeAt,null)
    h.advance(1000);assert.equal(e.tick(false).phase,'stopped')
  }
  const h=fixture(),e=new SessionEngine(h.repo);e.start(DEFAULT_POLICY,h.repo.now()+2000);e.requestFinish();h.advance(2000)
  assert.equal(e.tick(true).reason,'定时停止')
})
test('payment holds remain silent, claim and completion alerts are idempotent and account scoped',()=>{
  const h=fixture(),r=h.repo
  r.beginRun('home');r.finishRun('付款回执未知，请核对');assert.equal(pendingAlerts(r.account()).length,0)
  r.record(url,'won',{confirmedAt:r.now(),result:'won',prizeType:'physical',prizeName:'杯子'})
  const alerts=pendingAlerts(r.account());assert.equal(alerts.length,1);assert.equal(alerts[0].kind,'claim')
  r.alert(alerts[0]);r.alert(alerts[0]);r.dismissAlert(alerts[0].id)
  assert.equal(pendingAlerts(r.account()).length,0);assert.equal(r.account().alerts?.length,1)
  r.setClaim(r.roundKey(url,'won'),true);assert.equal(r.account().rounds[r.roundKey(url,'won')].claimed,true)
  r.setClaim(r.roundKey(url,'won'),false);assert.equal(r.account().rounds[r.roundKey(url,'won')].claimed,false)
  r.record(url,'lost',{confirmedAt:r.now(),result:'lost'});assert.throws(()=>r.setClaim(r.roundKey(url,'lost'),true))
  r.record(url,'diamond',{confirmedAt:r.now(),result:'won',prizeType:'diamond'});assert.throws(()=>r.setClaim(r.roundKey(url,'diamond'),true))
  r.beginRun('home');r.finishRun('定时停止');assert.equal(pendingAlerts(r.account()).filter(a=>a.kind==='ended').length,1)
  r.bind('b',{spent:0,stats:{},rooms:[]});assert.equal(pendingAlerts(r.account()).length,0)
})
test('candidate skip persists across restart, is round specific and daily skip expires in policy timezone',()=>{
  const h=fixture(),r=h.repo;r.skipCandidate(url,'one',r.now()+600000,false,'Asia/Shanghai')
  assert.equal(r.isSkipped(url,'one'),true);assert.equal(r.isSkipped(url,'two'),false)
  r.recover();r.bind('a',{spent:0,stats:{},rooms:[]});assert.equal(r.isSkipped(url,'one'),true)
  r.skipCandidate(url,'two',r.now()+600000,true,'Asia/Shanghai');assert.equal(r.isSkipped(url),true)
  h.advance(86400000);assert.equal(r.isSkipped(url,'one'),false);assert.equal(r.isSkipped(url),false)
})
test('budget limitation reasons identify the limiting counter, histories keep cycle attribution',()=>{
  const h=fixture(),r=h.repo
  assert.match(r.canPay(url,2,50,false,DEFAULT_POLICY)!,/单次支付/)
  assert.match(r.canPay(url,1,0,false,DEFAULT_POLICY)!,/本轮预算/)
  assert.match(r.canPay(url,1,50,false,{...DEFAULT_POLICY,dailySpend:0})!,/每日预算/)
  const p=r.reserve(url,'one',1,50,false,DEFAULT_POLICY);r.payment(p.id,'confirmed');r.resetBudget()
  assert.deepEqual(budgetCycles(r.account()).map(c=>c.spent),[0,1])
  assert.equal(r.canPay(url,0,0,false,{...DEFAULT_POLICY,dailySpend:0}),null)
})
test('presets preserve user budgets, pacing and paid-host permission restrictions',()=>{
  const config=structuredClone(defaults);config.policy.membership='whitelist';config.policy.dailySpend=7
  for(const preset of ['physical','diamond','balanced','existing'] as const){
    const next=participationPreset(config,preset)
    assert.equal(next.policy.dailySpend,7);assert.equal(next.policy.navigationMinSeconds,config.policy.navigationMinSeconds)
    assert.equal(next.policy.membership,preset==='existing'?'existing':'whitelist')
  }
  assert.equal(config.policy.membership,'whitelist')
})

test('crash recovery closes future pending rounds without fabricating a result or releasing payment',()=>{
  const h=fixture(),r=h.repo;r.beginRun('home')
  r.record(url,'sent',{drawAt:r.now()+300000,submittedAt:r.now()})
  r.record(url,'not-sent',{drawAt:r.now()+300000})
  const p=r.reserve(url,'sent',1,50,false,DEFAULT_POLICY);r.payment(p.id,'submitted')
  r.recover();r.bind('a',{spent:0,stats:{},rooms:[]})
  assert.equal(r.account().rounds[r.roundKey(url,'sent')].result,'unknown')
  assert.equal(r.account().rounds[r.roundKey(url,'not-sent')].result,'cancelled')
  assert.equal(r.account().payments[p.id].state,'unresolved')
  assert.equal(r.budget(50,false,DEFAULT_POLICY).reserved,1)
  assert.equal(pendingAlerts(r.account()).length,0)
})

test('login and claim notifications take priority over historical run completions',()=>{
  const input=(['ended','claim','login'] as const).map((kind,i)=>({id:kind,kind,title:'',message:'',at:i,dismissedAt:null}))
  assert.deepEqual(sortAlerts(input).map(n=>n.kind),['login','claim','ended'])
  assert.equal(input[0].kind,'ended','sorting must not mutate persisted ordering')
})


test('discovery card names extract host before truncation without changing ordinary display names',()=>{
  assert.equal(discoveryRoomName('下课没事播一下 @蛋蛋国王 3'),'蛋蛋国王')
  assert.equal(discoveryRoomName('卧薪尝胆 @昊天（三角洲行动） 7万'),'昊天（三角洲行动）')
  assert.equal(discoveryRoomName('标题'.repeat(60)+' @主播2026 1.2万'),'主播2026')
  assert.equal(discoveryRoomName('普通昵称123'),'普通昵称123')
  assert.equal(discoveryRoomName('昵称 @朋友'),'昵称 @朋友')
  assert.equal(roomDisplayName('主播 @名字 123',url),'主播 @名字 123')
})

test('extension preserves original segment ceiling, run identity and accounting; rejects stale double submit',()=>{
  const h=fixture(),r=h.repo,e=new SessionEngine(r,()=>0.5)
  const start=r.now(),p={...DEFAULT_POLICY,sessionMin:30,sessionMax:30}
  e.start(p,start+10*60000);r.beginRun('home')
  const before=structuredClone(r.account()),old=r.account().session.stopAt!
  const s=e.extend(30,old)
  assert.equal(s.stopAt,start+40*60000);assert.equal(s.hardStopAt,start+30*60000)
  assert.equal(s.startedAt,start);assert.equal(s.seed,before.session.seed)
  assert.deepEqual(r.account().runs,before.runs);assert.deepEqual(s.activeByDay,before.session.activeByDay)
  assert.throws(()=>e.extend(30,old),/已变化/)
  assert.equal(r.account().session.stopAt,start+40*60000)
  assert.equal(e.extend(60,s.stopAt!).hardStopAt,start+30*60000)
})

test('extension preserves rest and draining, rejects finish, expired, risk and invalid inputs',()=>{
  const h=fixture(),r=h.repo,e=new SessionEngine(r),end=r.now()+3600000
  e.start(DEFAULT_POLICY,end)
  for(const v of [0,-1,NaN,Infinity,1.5,121])assert.throws(()=>e.extend(v,end),/1–120/)
  r.change(a=>{a.session.phase='resting';a.session.nextResumeAt=r.now()+600000})
  const resume=r.account().session.nextResumeAt
  e.extend(15,end);assert.equal(r.account().session.phase,'resting');assert.equal(r.account().session.nextResumeAt,resume)
  r.change(a=>{a.session.phase='draining'})
  const hard=r.account().session.hardStopAt
  e.extend(15,r.account().session.stopAt!);assert.equal(r.account().session.phase,'draining');assert.equal(r.account().session.hardStopAt,hard)
  e.requestFinish();assert.throws(()=>e.extend(15,r.account().session.stopAt!),/不能延长/)
  e.stop();assert.throws(()=>e.extend(15,end),/不能延长/)
  e.start(DEFAULT_POLICY,r.now()+1000);h.advance(1000);assert.throws(()=>e.extend(15,r.account().session.stopAt!),/已到/)
  e.start(DEFAULT_POLICY);assert.throws(()=>e.extend(15,0),/没有可延长/)
  e.start(DEFAULT_POLICY,r.now()+3600000);r.risk('验证','visible-challenge');assert.throws(()=>e.extend(15,r.account().session.stopAt!))
})

test('extension cannot exceed allowed hours, daily cap or release unresolved payments',()=>{
  for(const kind of ['daily','hours'] as const){
    const h=fixture(),r=h.repo,e=new SessionEngine(r),now=r.now()
    const p={...DEFAULT_POLICY,sessionMin:30,sessionMax:30,...(kind==='daily'?{dailyMinutes:5}:{allowedStart:'09:00',allowedEnd:'10:05'})}
    e.start(p,now+60000)
    assert.equal(e.extend(30,now+60000).hardStopAt,now+5*60000)
    const pay=r.reserve(url,'ext',1,50,false,DEFAULT_POLICY);r.payment(pay.id,'unresolved')
    assert.throws(()=>e.extend(30,r.account().session.stopAt!),/异常/)
    assert.equal(r.budget(50,false,DEFAULT_POLICY).reserved,1)
  }
})


test('extension keeps legacy ceilings and rejects more than 24 hours without mutation',()=>{
  const h=fixture(),r=h.repo,e=new SessionEngine(r),end=r.now()+600000
  e.start(DEFAULT_POLICY,end)
  r.change(a=>{delete a.session.segmentLimitAt})
  assert.equal(e.extend(30,end).hardStopAt,end)
  e.start(DEFAULT_POLICY,r.now()+1440*60000)
  const before=structuredClone(r.account().session)
  assert.throws(()=>e.extend(1,before.stopAt!),/24小时/)
  assert.deepEqual(r.account().session,before)
  r.change(a=>{a.session.phase='resume-check'})
  assert.throws(()=>e.extend(1,before.stopAt!),/不能延长/)
})
