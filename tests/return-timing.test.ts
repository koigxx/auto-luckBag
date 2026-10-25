import test from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeRepository, emptyRuntime } from '../src/main/runtime-repository'
import { returnPreparationSeconds, evaluate, conflicts } from '../src/main/strategy'
import { DEFAULT_POLICY } from '../src/shared/policy'
import { parseLottery } from '../src/main/lottery-parser'

test('return preparation learns actual verification time, persists, and falls back after failure or stale samples',()=>{
  let now=100000000, data=emptyRuntime()
  const repo=new RuntimeRepository({read:()=>data,write:d=>data=structuredClone(d)},()=>now)
  repo.bind('a',{spent:0,stats:{},rooms:[]})
  const url='https://live.douyin.com/12345678';repo.room(url)
  const room=()=>repo.account().rooms[url]
  assert.equal(returnPreparationSeconds(room(),now),45)
  repo.recordVerificationTiming(url,6)
  assert.equal(returnPreparationSeconds(room(),now),20)
  repo.recordVerificationTiming(url,27)
  assert.equal(returnPreparationSeconds(room(),now),35,'slow recent visit wins over fast average')
  repo.recordVerificationTiming(url,NaN);repo.recordVerificationTiming(url,0)
  assert.equal(room().verificationTimings!.length,2)
  repo.recover();repo.bind('a',{spent:0,stats:{},rooms:[]})
  assert.equal(returnPreparationSeconds(room(),now),35)
  now+=86400001
  assert.equal(returnPreparationSeconds(room(),now),45)
  repo.recordVerificationTiming(url,6);repo.visit(url,false)
  assert.equal(returnPreparationSeconds(room(),now),45)
  repo.visit(url,true)
  assert.equal(returnPreparationSeconds(room(),now),45,'a new success without timing cannot resurrect pre-failure samples')
})

test('queue occupancy includes full result observation and a handoff margin',()=>{
  const now=100000000
  const o=parseLottery(JSON.stringify({data:{lottery_info:{lottery_id:'fixture',count_down:300,conditions:[]}}}),now)!
  const e=evaluate(o,DEFAULT_POLICY,now,undefined,[],false,20)
  assert.equal(e.endAt,o.drawAt!+30000)
  assert.equal(conflicts(e,{startAt:o.drawAt!+25000,endAt:o.drawAt!+100000}),true)
  assert.equal(conflicts(e,{startAt:e.endAt,endAt:e.endAt+100000}),false)
})
