import test from 'node:test'
import assert from 'node:assert/strict'
import {RuntimeRepository,emptyRuntime} from '../src/main/runtime-repository'
import {SessionEngine} from '../src/main/session-engine'
import {DEFAULT_POLICY} from '../src/shared/policy'
import {defaults,participationPreset} from '../src/shared/config'
import {runReports,budgetCycles,pendingAlerts,sortAlerts} from '../src/shared/review'
const url='https://live.douyin.com/12345678'
function fixture(){let data=emptyRuntime(),now=Date.UTC(2026,9,25,2);const repo=new RuntimeRepository({read:()=>data,write:d=>{data=structuredClone(d)}},()=>now);repo.bind('a',{spent:0,stats:{},rooms:[]});repo.room(url);return {repo,advance:(ms:number)=>now+=ms}}
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
