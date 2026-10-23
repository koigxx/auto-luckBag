import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLottery } from '../src/main/lottery-parser'

test('source discovery waits 20 seconds before first room page, never repeats for queued rooms, and cancels on stop', async () => {
  const Module=require('node:module'), original=Module._load
  let now=1000000, cancelOnWait=false, ready=false, matched=true
  const opportunity=()=>parseLottery(JSON.stringify({data:{lottery_info:{lottery_id:'fixture',count_down:90,conditions:[]}}}),now)!
  let controller=new AbortController()
  const created:number[]=[], waits:number[]=[]
  const profile={visits:[] as unknown[],name:'room'}
  const fakePage={on:()=>{},off:()=>{},close:async()=>{},title:async()=> 'room',
    locator:()=>({evaluateAll:async()=>[{url:'https://live.douyin.com/12345678',name:'room'}]})}
  const gate=require('../src/main/execution-gate')
  Module._load=function(name:string,...args:any[]){
    if(name==='./runtime')return {
      execution:{get signal(){return controller.signal}},
      repository:{room:()=>profile,visit:()=>{profile.visits.push({})},decision:()=>{},updateRoom:()=>{}},
      assertActive:(signal:AbortSignal)=>gate.checkSignal(signal),onHalt:()=>{},perform:()=>{},reportRisk:()=>{}
    }
    if(name==='./passive-observer')return {PassiveObserver:class {get latest(){return ready?opportunity():null}get panelLotteryId(){return matched?'fixture':null}accept(){}async checkPageRisk(){}close(){}}}
    if(name==='./lottery-dom')return {LotteryDom:class {async entry(){return {seconds:null,visible:false}}async panelText(){return '福袋 已参与，等待开奖'}},visibleOpportunity:()=>null}
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
    const service=new Discovery({newManagedPage:async()=>{created.push(now);return fakePage},navigate:async()=>{}} as any)
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
    matched=false
    const unknownAt=now
    await service.verifyRoom(scan.rooms[0],{reserved:true})
    assert.equal(now-unknownAt,12000,'unmatched panel cannot trigger the fast verification path')
    await service.scan()
    cancelOnWait=true
    const beforeCancel=created.length
    await assert.rejects(service.verifyRoom(scan.rooms[0]),/取消/)
    assert.equal(created.length,beforeCancel)
    await service.close()
  }finally{Date.now=dateNow}
})
