import test from 'node:test'
import assert from 'node:assert/strict'
import { emptySession } from '../src/shared/policy'
import { scheduleExclusionReason, sessionDisplayReason, waitingForScheduledStop } from '../src/shared/run-presentation'
test('scheduled-stop wording leaves session state and normal rest unchanged',()=>{
 const s={...emptySession(),phase:'resting' as const,reason:'计划休息',stopAt:10000,nextResumeAt:20000}
 const before=JSON.stringify(s)
 assert.equal(sessionDisplayReason(s),'本轮已完成，等待定时结束')
 assert.equal(JSON.stringify(s),before)
 assert.equal(waitingForScheduledStop({...s,stopAt:30000}),false)
 assert.equal(sessionDisplayReason({...s,stopAt:null}),'计划休息')
 assert.equal(waitingForScheduledStop({...s,phase:'running'}),false)
})
test('conflict explanations distinguish occupancy, actual navigation gaps and capacity without changing slots',()=>{
 const at=Date.UTC(2026,9,25,7,0),slot=(id:string,start:number,end:number,nav?:number)=>({name:'https://live.douyin.com/'+id,url:'https://live.douyin.com/'+id,evaluation:{startAt:at+start*1000,endAt:at+end*1000,navigationAt:nav===undefined?undefined:at+nav*1000}})
 const a=slot('12345678',0,30),b=slot('87654321',100,140)
 const before=JSON.stringify([a,b])
 const gap=scheduleExclusionReason(a,[b],120,5,'Asia/Shanghai')
 assert.match(gap,/直播间 87654321（预约 15:01:40）/)
 assert.match(gap,/还差 20 秒/);assert.doesNotMatch(gap,/重叠/)
 assert.equal(JSON.stringify([a,b]),before)
 assert.match(scheduleExclusionReason(slot('1',0,130),[b],0,5,'Asia/Shanghai'),/占用重叠 30 秒/)
 assert.doesNotMatch(scheduleExclusionReason(slot('1',0,30,-30),[b],120,5,'Asia/Shanghai'),/导航间隔/)
 assert.match(scheduleExclusionReason(a,[b],0,1,'Asia/Shanghai'),/队列已满/)
 assert.match(scheduleExclusionReason(a,[b],0,5,'Asia/Shanghai'),/排序未选中/)
})
