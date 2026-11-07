import test from 'node:test'
import assert from 'node:assert/strict'
import { sampleTiming, matchesLog, diagnosticSummary, configDifferences, runStatusLabel } from '../src/shared/experience'
import { ExecutionGate } from '../src/main/execution-gate'
import { RuntimeRepository, emptyRuntime } from '../src/main/runtime-repository'
import { runReports } from '../src/shared/review'

test('observation timing counts previous phase, excludes suspend and backwards clock, does not mutate input',()=>{
 const first=sampleTiming(undefined,'waiting',1000)
 const second=sampleTiming(first,'task',4000)
 assert.deepEqual(first.totals,{})
 assert.equal(second.totals.waiting,3000)
 const suspended=sampleTiming(second,'resting',100000)
 assert.equal(suspended.totals.task,undefined)
 const backwards=sampleTiming(suspended,'task',90000)
 assert.equal(backwards.totals.resting,undefined)
 assert.equal(sampleTiming(backwards,'stopped',91000).totals.task,1000)
})
test('execution wait observation expires on cancellation and cannot leak into the next generation',()=>{
 const gate=new ExecutionGate();gate.start()
 const readWait=()=>gate.waitObservation
 const clear=gate.observeWait(gate.signal,10000,'navigation')
 assert.equal(readWait()?.until,10000)
 gate.stop();assert.equal(readWait(),null)
 gate.start();const current=gate.observeWait(gate.signal,20000,'navigation')
 clear();assert.equal(readWait()?.until,20000)
 current();assert.equal(readWait(),null)
})
test('linked logs require all supplied identities and never infer missing round ownership',()=>{
 const log={time:1000,runId:'run-a',roomUrl:'https://live.douyin.com/1',lotteryId:'round-a',message:'sensitive command'}
 assert.equal(matchesLog(log,{runId:'run-a',lotteryId:'round-a',from:1000,to:1000}),true)
 for(const context of [{runId:'run-b'},{roomUrl:'other'},{lotteryId:'round-b'},{from:1001},{to:999}])assert.equal(matchesLog(log,context),false)
 assert.equal(matchesLog({...log,lotteryId:undefined},{lotteryId:'round-a'}),false)
 assert.equal(matchesLog(log,null),true)
 const summary=diagnosticSummary([log],{runId:log.runId,roomUrl:log.roomUrl})
 for(const secret of ['sensitive command','run-a','douyin.com','round-a'])assert.ok(!summary.includes(secret))
 assert.match(summary,/Events: 1/)
 assert.match(diagnosticSummary([],null),/Events: 0/)
})
test('configuration differences preserve booleans, zero and nested keys, restore is empty',()=>{
 const before={diamondBudget:50,policy:{autoResume:true,dailySpend:5},fudaiTypes:{all:true,diamond:false}}
 const after={diamondBudget:0,policy:{autoResume:false,dailySpend:5},fudaiTypes:{all:false,diamond:true}}
 assert.deepEqual(configDifferences(before,after).map(d=>[d.key,d.after]),[['diamondBudget',0],['policy.autoResume',false],['fudaiTypes.all',false],['fudaiTypes.diamond',true]])
 assert.deepEqual(configDifferences(before,structuredClone(before)),[])
})
test('run observations persist separately from ledger, finalize once and keep legacy timing absent',()=>{
 let data=emptyRuntime(),now=1000
 const repo=new RuntimeRepository({read:()=>data,write:d=>{data=structuredClone(d)}},()=>now)
 repo.bind('a',{spent:7,stats:{},rooms:[]});repo.beginRun('test')
 repo.sampleActivity('waiting');now=2000;repo.sampleActivity('task');now=4000;repo.finishRun('manual')
 now=6000;repo.finishRun('repeat')
 const r=runReports(repo.account())[0]
 assert.equal(r.reason,'manual');assert.equal(r.activityTiming?.totals.waiting,1000);assert.equal(r.activityTiming?.totals.task,2000)
 assert.equal(repo.account().openingSpent,7);assert.deepEqual(repo.account().session.activeByDay,{})
 repo.beginRun('legacy');repo.finishRun('old')
 assert.equal(runReports(repo.account())[0].activityTiming,undefined)
 repo.recover();repo.bind('a',{spent:0,stats:{},rooms:[]})
 assert.equal(runReports(repo.account())[1].activityTiming?.totals.task,2000)
})
test('tray and dashboard share status vocabulary without treating a break as stopped',()=>{
 assert.equal(runStatusLabel('running',true),'后台 · 正在运行')
 assert.equal(runStatusLabel('resting',true),'计划休息中')
 assert.equal(runStatusLabel('blocked',false,true),'Needs your attention')
})
