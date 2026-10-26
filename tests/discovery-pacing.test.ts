import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLottery } from '../src/main/lottery-parser'

test('source discovery waits 20 seconds before first room page, never repeats for queued rooms, and cancels on stop', async () => {
  const Module=require('node:module'), original=Module._load
  let now=1000000, cancelOnWait=false, ready=false, matched=true
  const opportunity=()=>parseLottery(JSON.stringify({data:{lottery_info:{lottery_id:'fixture',count_down:90,conditions:[]}}}),now)!
  let controller=new AbortController()
  const created:number[]=[], waits:number[]=[], timings:number[]=[]
  const navigations:{url:string;at:number}[]=[]
  let gateWait=0, loadMs=0
  const profile={visits:[] as unknown[],name:'room',source:'discovery'}
  let pageTitle='room'
  let entryError:Error|null=null, abortAtEntry=false, pageCloses=0, observerCloses=0, riskChecks=0
  const visits:boolean[]=[], decisions:unknown[]=[], logs:string[]=[]
  const fakePage={on:()=>{},off:()=>{},close:async()=>{pageCloses++},title:async()=> pageTitle,
    locator:()=>({evaluateAll:async()=>[{url:'https://live.douyin.com/12345678',name:'room'}]})}
  const gate=require('../src/main/execution-gate')
  Module._load=function(name:string,...args:any[]){
    if(name==='./runtime')return {
      execution:{get signal(){return controller.signal}},
      repository:{account:()=>({navigations}),recordVerificationTiming:(_url:string,seconds:number)=>timings.push(seconds),room:()=>profile,visit:(_url:string,found:boolean)=>{visits.push(found);profile.visits.push({})},decision:(d:unknown)=>{decisions.push(d)},updateRoom:(_url:string,patch:object)=>Object.assign(profile,patch)},
      assertActive:(signal:AbortSignal)=>gate.checkSignal(signal),onHalt:()=>{},perform:()=>{},reportRisk:()=>{}
    }
    if(name==='./passive-observer')return {PassiveObserver:class {get latest(){return ready?opportunity():null}get panelLotteryId(){return matched?'fixture':null}accept(){}async checkPageRisk(){riskChecks++}close(){observerCloses++}}}
    if(name==='./lottery-dom')return {LotteryDom:class {async entry(){if(abortAtEntry)controller.abort();if(entryError)throw entryError;return {seconds:null,visible:false}}async panelText(){return '福袋 已参与，等待开奖'}},visibleOpportunity:()=>null}
    if(name==='./execution-gate')return {...gate,delay:async(ms:number,signal:AbortSignal)=>{
      gate.checkSignal(signal);waits.push(ms);now+=ms
      if(cancelOnWait)controller.abort()
      gate.checkSignal(signal)
    }}
    return original.call(this,name,...args)
  }
  let Discovery:typeof import('../src/main/discovery-service').DiscoveryService
  try {Discovery=require('../src/main/discovery-service').DiscoveryService}finally{Module._load=original}
  const dateNow=Date.now
  Date.now=()=>now
  try{
    const service=new Discovery({newManagedPage:async()=>{created.push(now);return fakePage},navigate:async(_page:unknown,url:string)=>{now+=gateWait;navigations.push({url,at:now});now+=loadMs}} as any)
    const scan=await service.scan()
    const discoveredAt=now
    await service.verifyRoom(scan.rooms[0])
    assert.equal(created[1]-discoveredAt,20000)
    const beforeSecond=now
    await service.verifyRoom(scan.rooms[0])
    assert.equal(created[2],beforeSecond)
    assert.equal(waits.filter(n=>n===20000).length,1)
    ready=true
    const readyAt=now
    await service.verifyRoom(scan.rooms[0],{reserved:true})
    assert.equal(now-readyAt,3000,'ready identity/tasks end verification without a mandatory 28-second dwell')
    assert.equal(timings.at(-1),3)
    gateWait=120000;loadMs=5000
    await service.verifyRoom(scan.rooms[0],{reserved:true})
    assert.equal(timings.at(-1),8,'return sample excludes waiting for navigation permission')
    gateWait=0;loadMs=0
    const sampleCount=timings.length
    matched=false
    const unknownAt=now
    await service.verifyRoom(scan.rooms[0],{reserved:true})
    assert.equal(now-unknownAt,12000,'unmatched panel cannot trigger the fast verification path')
    assert.equal(timings.length,sampleCount,'unmatched identity cannot train faster returns')
    profile.name='标题 @主播2026 10万+'
    pageTitle='抖音直播电脑版_抖音直播网页版入口_抖音直播'
    await service.verifyRoom(scan.rooms[0],{reserved:true})
    assert.equal(profile.name,'主播2026','discovery history is repaired without taking a generic page title')
    profile.source='manual';profile.name='主播 @朋友 123'
    await service.verifyRoom(scan.rooms[0],{reserved:true})
    assert.equal(profile.name,'主播 @朋友 123','manual names are not interpreted as discovery cards')
    service.setLogger(text=>logs.push(text))
    // Fail after navigation, where the old catch incorrectly added a failed visit.
    for(const reason of ['计划休息','已到硬截止','旧运行已取消','手动停止']) {
      controller=new AbortController()
      abortAtEntry=reason==='手动停止'
      entryError=abortAtEntry?new Error('页面已关闭'):new gate.ExecutionUnavailableError(reason)
      const before={visits:visits.length,decisions:decisions.length,timings:timings.length,pageCloses,observerCloses,riskChecks}
      logs.length=0
      await assert.rejects(service.verifyRoom(scan.rooms[0],{keepPageOnVerified:true}),error=>error===entryError)
      assert.equal(visits.length,before.visits,`${reason}: no failed visit or cooldown`)
      assert.equal(decisions.length,before.decisions,`${reason}: no skip/error decision`)
      assert.equal(timings.length,before.timings,`${reason}: preserve prior return timing`)
      assert.equal(pageCloses,before.pageCloses+1)
      assert.equal(observerCloses,before.observerCloses+1)
      assert.equal(riskChecks,before.riskChecks+1,'cancelled work must not probe the closing page again')
      assert.ok(logs.every(line=>!line.includes('验证异常')))
    }
    controller=new AbortController();abortAtEntry=false
    // Matching text alone must not suppress a real error.
    entryError=new Error('当前运行状态不允许此操作')
    const beforeFailure={visits:visits.length,decisions:decisions.length,pageCloses,observerCloses,riskChecks}
    await assert.rejects(service.verifyRoom(scan.rooms[0]),error=>error===entryError)
    assert.equal(visits.length,beforeFailure.visits+1)
    assert.equal(visits.at(-1),false,'real failure still updates failure/cooldown accounting')
    assert.equal(decisions.length,beforeFailure.decisions+1)
    assert.equal(pageCloses,beforeFailure.pageCloses+1)
    assert.equal(observerCloses,beforeFailure.observerCloses+1)
    assert.equal(riskChecks,beforeFailure.riskChecks+2,'real errors retain the risk recheck')
    assert.ok(logs.some(line=>line.includes('验证异常')))
    entryError=null
    await service.scan()
    cancelOnWait=true
    const beforeCancel=created.length
    await assert.rejects(service.verifyRoom(scan.rooms[0]),/取消/)
    assert.equal(created.length,beforeCancel)
    await service.close()
  }finally{Date.now=dateNow}
})
