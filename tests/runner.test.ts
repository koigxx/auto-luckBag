import test from 'node:test'
import assert from 'node:assert/strict'
import { AutoRunner, AutoRunnerEnvironment } from '../src/main/auto-runner'
import { RuntimeRepository, emptyRuntime } from '../src/main/runtime-repository'
import { SessionEngine } from '../src/main/session-engine'
import { ExecutionGate, checkSignal } from '../src/main/execution-gate'
import { defaults } from '../src/shared/config'
import type { Room, RoomManager } from '../src/main/room-manager'
import type { DiscoveryService, VerifyRoomResult } from '../src/main/discovery-service'
import type { Opportunity } from '../src/shared/policy'
import type { Page } from 'playwright'
import { parseLottery } from '../src/main/lottery-parser'

function harness() {
  let time = Date.UTC(2026, 9, 22, 2),
    data = emptyRuntime(),
    config = structuredClone(defaults),
    scanCount = 0,
    verifyCount = 0,
    closeCount = 0,
    entered = 0
  const repo = new RuntimeRepository(
    {
      read: () => data,
      write: (d) => {
        data = structuredClone(d)
      }
    },
    () => time
  )
  repo.bind('a', { spent: 0, stats: {}, rooms: [] })
  const execution = new ExecutionGate(),
    engine = new SessionEngine(repo, () => 0.5)
  const env: AutoRunnerEnvironment = {
    repository: repo,
    execution,
    sessionEngine: engine,
    now: () => time,
    policy: () => config.policy,
    haltPages: async () => {
      execution.stop()
      closeCount++
    },
    paymentReason: () => null,
    assertActive: (signal) => {
      checkSignal(signal)
      if (signal !== execution.signal) throw new Error('stale')
    },
    store: {
      get: (key) => config[key],
      set: (key, value) => {
        config[key] = value
      }
    },
    setTimer: () => 1 as unknown as NodeJS.Timeout,
    clearTimer: () => {}
  }
  const discovery: Pick<DiscoveryService, 'scan' | 'verifyRoom' | 'close'> = {
    scan: async () => {
      scanCount++
      return {
        rooms: [
          {
            url: 'https://live.douyin.com/12345678',
            name: 'sample',
            reason: 'fixture',
            countdownText: '',
            remainingSeconds: null
          }
        ],
        riskDetected: false,
        riskReason: ''
      }
    },
    verifyRoom: async () => {
      verifyCount++
      return { room: null, riskDetected: false, riskReason: '' }
    },
    close: async () => {
      closeCount++
    }
  }
  let continuation: Parameters<RoomManager['setContinuationCheck']>[0] = () => null
  const rooms = {
    setReservationTimeProvider: (_fn:()=>number|null) => {},
    setContinuationCheck: (fn: typeof continuation) => { continuation = fn },
    getAllRooms: () => [] as Room[],
    tick: async () => {},
    addRoom: async () => {
      entered++
      return {} as Room
    },
    addRoomFromPage: async () => {
      entered++
      return {} as Room
    },
    closeAllRooms: async () => {
      closeCount++
    }
  }
  const runner = new AutoRunner(
    discovery,
    rooms,
    { markStarted: () => {}, markStopped: () => {}, publish: () => {} },
    env
  )
  runner.setResumeCheck(async () => true)
  const logs: string[] = []
  runner.setCallbacks(
    (m) => logs.push(m),
    () => {}
  )
  return {
    runner,
    repo,
    env,
    discovery,
    rooms,
    config,
    logs,
    continue: (o:Opportunity|null, room:{url:string;name:string}) => continuation(o,room),
    advance: (ms: number) => {
      time += ms
    },
    counts: () => ({ scanCount, verifyCount, closeCount, entered }),
    now: () => time
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('long idle restart rediscovers stale rooms without erasing room preferences or ledger', async () => {
  const h = harness(), url = 'https://live.douyin.com/12345678'
  h.repo.room(url, 'saved')
  h.repo.visit(url, true)
  h.repo.updateRoom(url, { favorite: true, allowPaid: true })
  const before = structuredClone(h.repo.account().rooms[url])
  h.advance(31 * 60000)
  await h.runner.start()
  await h.runner.pulse()
  await flush()
  assert.equal(h.counts().scanCount, 1)
  assert.equal(h.counts().verifyCount, 0)
  assert.deepEqual(h.repo.account().rooms[url], before)
  assert.ok(h.logs.some(m => m.includes('超过30分钟')))
  // A stale room returned by the current scan may still be verified.
  h.advance(1000)
  await h.runner.pulse()
  await flush()
  assert.equal(h.counts().verifyCount, 1)
  await h.runner.stop()
})

test('short idle start retains recent history but later restart recalculates freshness', async () => {
  const h = harness(), url = 'https://live.douyin.com/12345678'
  h.repo.room(url, 'recent')
  h.repo.visit(url, true)
  h.advance(5 * 60000)
  await h.runner.start()
  await h.runner.pulse()
  await flush()
  assert.equal(h.counts().verifyCount, 1)
  assert.equal(h.counts().scanCount, 0)
  await h.runner.stop()
  h.advance(31 * 60000)
  await h.runner.start()
  await h.runner.pulse()
  await flush()
  assert.equal(h.counts().scanCount, 1)
  assert.equal(h.counts().verifyCount, 1)
  await h.runner.stop()
})

test('source scanning interval never delays a queued verification or drifts during idle polling', async () => {
  const h = harness()
  h.config.scanIntervalSeconds = 40
  await h.runner.start()
  await h.runner.pulse()
  await flush()
  const next = h.runner.getState().nextScanAt
  assert.equal(h.counts().scanCount, 1)
  h.advance(1000)
  await h.runner.pulse()
  await flush()
  assert.equal(h.counts().verifyCount, 1)
  for (let i = 0; i < 38; i++) {
    h.advance(1000)
    await h.runner.pulse()
    await flush()
    assert.equal(h.runner.getState().nextScanAt, next)
  }
  assert.equal(h.counts().scanCount, 1)
  h.advance(1000)
  await h.runner.pulse()
  await flush()
  assert.equal(h.counts().scanCount, 2)
  await h.runner.stop()
})

function verified(
  h: ReturnType<typeof harness>,
  seconds: number,
  patch: Partial<Opportunity> = {}
): VerifyRoomResult {
  const url = 'https://live.douyin.com/12345678'
  const opportunity = {
    ...parseLottery(
      JSON.stringify({
        data: {
          lottery_info: {
            lottery_id_str: 'observed-free-fixture',
            count_down: seconds,
            conditions: [
              { description: '关注主播', status: 0 },
              { description: '手动参与', status: 0 }
            ]
          }
        }
      }),
      h.now()
    )!,
    ...patch
  }
  h.repo.visit(url, true, opportunity)
  return {
    riskDetected: false,
    riskReason: '',
    page: { close: async () => {} } as Page,
    room: {
      url,
      name: 'sample',
      reason: 'fixture',
      remainingSeconds: seconds,
      countdownText: '',
      verifiedAt: h.now(),
      hasFudai: true,
      score: 0,
      matchedSignals: ['network'],
      drawAt: opportunity.drawAt,
      countdownSource: 'network',
      countdownConfidence: 'exact',
      opportunity
    }
  }
}
async function pulse(h: ReturnType<typeof harness>, ms = 1000) {
  h.advance(ms)
  await h.runner.pulse()
  await flush()
}
async function runFor(h: ReturnType<typeof harness>, ms: number) {
  while (ms > 0) {
    const step = Math.min(ms, 30000)
    await pulse(h, step)
    ms -= step
  }
}

test('nine and five minute reservations survive a one-minute takeover and exploration resumes between them', async()=>{
  const h=harness(), base=h.now(), urls=['90000001','50000001','10000001','80000001'].map(id=>'https://live.douyin.com/'+id)
  const draws=[540,300,60,900].map(s=>base+s*1000)
  const calls:{url:string;reserved:boolean}[]=[], entered:string[]=[]
  let active:Room[]=[]
  h.rooms.getAllRooms=()=>active
  h.rooms.addRoomFromPage=async(_page?:Page,url?:string)=>{entered.push(url!);active=[{url} as Room];return active[0]}
  h.discovery.scan=async()=>({rooms:urls.map(url=>({url,name:url,reason:'fixture',countdownText:'',remainingSeconds:null})),riskDetected:false,riskReason:''})
  h.discovery.verifyRoom=async(room,options)=>{
    calls.push({url:room.url,reserved:!!options?.reserved})
    const index=urls.indexOf(room.url),drawAt=draws[index]
    const result=verified(h,(drawAt-h.now())/1000,{drawAt,lotteryId:'round-'+index,
      winnerCount:index===1?1:null,participantCount:index===1?100:null})
    result.room!.url=room.url;return result
  }
  await h.runner.start();await pulse(h);await pulse(h);await pulse(h)
  assert.equal(h.runner.getState().candidateCount,2,'known and unknown odds coexist')
  await pulse(h)
  assert.deepEqual(entered,[urls[2]])
  assert.deepEqual(h.runner.getState().candidates.map(r=>r.url),[urls[1],urls[0]])
  await pulse(h,10000);assert.equal(calls.length,3,'active participation stays serial')
  await runFor(h,base+85000-h.now());active=[];await pulse(h)
  assert.equal(calls.at(-1)!.url,urls[3],'explore the free interval after settlement')
  await runFor(h,base+210000-h.now())
  assert.deepEqual(entered,[urls[2],urls[1]])
  assert.equal(calls.at(-1)!.reserved,true)
  await runFor(h,base+325000-h.now());active=[]
  await runFor(h,base+450000-h.now())
  assert.deepEqual(entered,[urls[2],urls[1],urls[0]],JSON.stringify({state:h.runner.getState(),calls,logs:h.logs.slice(-10)}))
  assert.ok(h.runner.getState().candidates.some(r=>r.url===urls[3]))
  await h.runner.stop()
})

test('a ten-minute next round returns to the reservation pool without displacing a compatible earlier room',async()=>{
  const h=harness(),url='https://live.douyin.com/99999999'
  h.discovery.verifyRoom=async()=>verified(h,300,{winnerCount:1,participantCount:100})
  await h.runner.start();await pulse(h);await pulse(h)
  const old=h.runner.getState().candidates[0]
  const next=verified(h,600,{lotteryId:'next-round'}).room!.opportunity
  const reason=h.continue(next,{url,name:'returning'})
  assert.match(reason!,/下一轮已加入预约/)
  assert.deepEqual(h.runner.getState().candidates.map(r=>r.url),[old.url,url])
  assert.equal(h.counts().entered,0)
  h.continue({...next,drawAt:next.drawAt!+1000},{url,name:'returning'})
  assert.equal(h.runner.getState().candidateCount,2,'same room replaces its stale round instead of duplicating')
  assert.equal(h.continue(null,{url,name:'returning'}),null)
  h.advance(old.entryRemainingSeconds! * 1000)
  assert.match(h.continue(null,{url,name:'returning'})!,/已有预约到时/)
  h.advance(old.drawAt! - h.now() + 1)
  assert.equal(h.continue(null,{url,name:'returning'}),null,'expired reservations must not force a room to leave')
  await h.runner.stop();assert.equal(h.runner.getState().candidateCount,0)
})

test('reservation takeover keeps the actual navigation anchor and logs only accepted takeovers',async()=>{
  for(const dispatchEvidence of [true,false]) {
    const h=harness(),base=h.now(),urls=['12345678','87654321'].map(id=>'https://live.douyin.com/'+id)
    const draws=[base+600000,base+722005]
    h.discovery.scan=async()=>({rooms:urls.map(url=>({url,name:'fixture',reason:'fixture',countdownText:'',remainingSeconds:null})),riskDetected:false,riskReason:''})
    h.discovery.verifyRoom=async(room,options)=>{
      if(!options?.reserved || dispatchEvidence)h.repo.change(a=>a.navigations.push({url:room.url,at:h.now(),fresh:false}))
      if(options?.reserved)h.advance(6974)
      const index=urls.indexOf(room.url)
      const result=verified(h,(draws[index]-h.now())/1000,{drawAt:draws[index],lotteryId:'fixture-'+index})
      result.room!.url=room.url
      return result
    }
    await h.runner.start();await pulse(h);await pulse(h)
    await runFor(h,120000)
    assert.equal(h.runner.getState().candidateCount,2)
    await runFor(h,base+510000-h.now())
    assert.equal(h.counts().entered,dispatchEvidence?1:0)
    const decisions=h.repo.account().decisions.filter(d=>d.url===urls[0])
    assert.equal(decisions.filter(d=>d.action==='takeover').length,dispatchEvidence?1:0)
    if(!dispatchEvidence)assert.match(decisions.at(-1)!.reason,/冲突/,'old visit cannot stand in for this navigation')
    assert.equal(h.runner.getState().candidates[0]?.url,urls[1])
    await h.runner.stop()
  }
})

test('free manual-participation bag with 40 seconds is taken over from the verification page', async () => {
  const h = harness()
  h.discovery.verifyRoom = async () => verified(h, 40)
  await h.runner.start({ scanIntervalSeconds: 180 })
  await pulse(h)
  await pulse(h)
  assert.equal(h.counts().entered, 1)
  assert.equal(h.runner.getState().candidateCount, 0)
  const d = h.repo.account().decisions.at(-1)!
  assert.equal(d.action, 'takeover')
  assert.equal(d.snapshot!.leadSeconds, 20)
  await h.runner.stop()
})

test('near-draw unsupported task retains its real rejection reason instead of a navigation-time error', async () => {
  const h = harness()
  h.discovery.verifyRoom = async () => verified(h, 64, { unsupported: ['未知资格限制'] })
  await h.runner.start()
  await pulse(h)
  await pulse(h)
  assert.equal(h.counts().entered, 0)
  assert.equal(h.repo.account().decisions.at(-1)!.reason, '未知资格限制')
  await h.runner.stop()
})

test('nine-minute candidate survives five minutes and revalidates on the retained page at its reservation', async () => {
  const h = harness()
  // A long candidate stays queued until the configured task window.
  h.config.policy.navigationMinSeconds = 45
  h.config.policy.navigationMaxSeconds = 65
  h.config.candidatePoolLimit = 1
  let calls = 0,
    drawAt = 0
  h.discovery.verifyRoom = async () => {
    calls++
    if (calls === 1) drawAt = h.now() + 540000
    else h.advance(5000)
    return verified(h, (drawAt - h.now()) / 1000, { drawAt })
  }
  await h.runner.start({ scanIntervalSeconds: 180 })
  await pulse(h)
  await pulse(h)
  assert.equal(h.runner.getState().candidateCount, 1)
  assert.equal(calls, 1)
  await runFor(h, 330000)
  assert.equal(h.runner.getState().candidateCount, 1)
  assert.equal(calls, 1)
  await runFor(h, 121000)
  assert.equal(calls, 2)
  assert.equal(h.counts().entered, 1)
  assert.equal(h.runner.getState().candidateCount, 0)
  assert.equal(h.repo.account().decisions.at(-1)!.action, 'takeover')
  await h.runner.stop()
})

test('reservation retains task time after a full 30-second load and 12-second revalidation', async () => {
  const h = harness()
  h.config.candidatePoolLimit = 1
  let calls = 0, drawAt = 0
  h.discovery.verifyRoom = async () => {
    calls++
    if (calls === 1) drawAt = h.now() + 540000
    else h.advance(42000)
    return verified(h, (drawAt - h.now()) / 1000, { drawAt, requiresComment:true, commentText:'测试', membership:'needs-payment', cost:1 })
  }
  await h.runner.start()
  await pulse(h)
  await pulse(h)
  assert.equal(h.runner.getState().candidateCount, 1)
  const lead = h.repo.account().decisions.at(-1)!.snapshot!.leadSeconds
  assert.equal(lead,90)
  await runFor(h, drawAt - h.now() - lead * 1000 + 1000)
  assert.equal(calls, 2)
  assert.equal(h.counts().entered, 1)
  assert.ok(drawAt - h.now() >= 45000)
  await h.runner.stop()
})

test('sequential discovery fills candidates while return navigation is reserved before the 45-second window',async()=>{
  const h=harness(),firstUrl='https://live.douyin.com/12345678',secondUrl='https://live.douyin.com/87654321'
  let drawAt=0
  const calls:{url:string;at:number;reserved:boolean}[]=[]
  h.discovery.scan=async()=>({rooms:[firstUrl,secondUrl].map(url=>({url,name:url,reason:'fixture',countdownText:'',remainingSeconds:null})),riskDetected:false,riskReason:''})
  h.discovery.verifyRoom=async(room,options)=>{
    calls.push({url:room.url,at:h.now(),reserved:!!options?.reserved})
    h.repo.change(a=>a.navigations.push({url:room.url,at:h.now(),fresh:false}))
    h.advance(3000)
    if(room.url===secondUrl)return {room:null,riskDetected:false,riskReason:''}
    if(!drawAt)drawAt=h.now()+420000
    return verified(h,(drawAt-h.now())/1000,{drawAt})
  }
  await h.runner.start();await pulse(h);await pulse(h)
  assert.equal(h.runner.getState().candidateCount,1)
  h.advance(60000); h.env.sessionEngine.tick(false)
  await pulse(h,60000)
  assert.equal(calls[1].url,secondUrl,'queued rooms remain in discovery order')
  // No new exploration may consume the return slot as the reservation approaches.
  await pulse(h,10000)
  const count=calls.length
  await pulse(h,10000)
  assert.equal(calls.length,count)
  await runFor(h,drawAt-h.now()-90000)
  assert.equal(calls.at(-1)!.url,firstUrl)
  assert.equal(calls.at(-1)!.reserved,true)
  assert.ok(calls.at(-1)!.at-calls[1].at>=120000)
  assert.equal(h.counts().entered,1)
  assert.ok(h.logs.some(m=>m.includes('等待候选预约')))
  await h.runner.stop()
})

test('a verified room is reused if closing it would make a timely return impossible',async()=>{
  const h=harness()
  h.discovery.verifyRoom=async()=>{
    h.repo.change(a=>a.navigations.push({url:'https://live.douyin.com/12345678',at:h.now()-3000,fresh:false}))
    return verified(h,64)
  }
  await h.runner.start();await pulse(h);await pulse(h)
  assert.equal(h.counts().entered,1)
  assert.equal(h.runner.getState().candidateCount,0)
  await h.runner.stop()
})

test('an occupied lottery room remains active beyond navigation spacing without scanning another room', async () => {
  const h=harness()
  h.config.enterBeforeSeconds=600
  let occupied=false, verifications=0
  h.rooms.getAllRooms=()=>occupied?[{} as Room]:[]
  h.rooms.addRoomFromPage=async()=>{occupied=true;return {} as Room}
  h.discovery.verifyRoom=async()=>{verifications++;return verified(h,400)}
  await h.runner.start()
  await pulse(h)
  await pulse(h)
  assert.equal(occupied,true)
  const before=h.counts().scanCount
  await runFor(h,240000)
  assert.equal(occupied,true)
  assert.equal(verifications,1)
  assert.equal(h.counts().scanCount,before)
  await h.runner.stop()
})

test('reserved candidate rechecks new share and paid requirements instead of using stale free eligibility', async () => {
  for (const patch of [{ requiresShare: true }, { cost: 1, membership: 'needs-payment' as const }]) {
    const h = harness()
    h.config.candidatePoolLimit = 1
    let calls = 0,
      drawAt = 0
    h.env.paymentReason = (_url, cost) => (cost ? '钻石预算不足' : null)
    h.discovery.verifyRoom = async () => {
      calls++
      if (calls === 1) drawAt = h.now() + 540000
      return verified(h, (drawAt - h.now()) / 1000, { drawAt, ...(calls > 1 ? patch : {}) })
    }
    await h.runner.start()
    await pulse(h)
    await pulse(h)
    await runFor(h, 451000)
    assert.equal(calls, 2)
    assert.equal(h.counts().entered, 0)
    assert.equal(h.runner.getState().candidateCount, 0)
    assert.match(h.repo.account().decisions.at(-1)!.reason, patch.requiresShare ? /分享/ : /预算/)
    await h.runner.stop()
  }
})

test('a changed lottery at reservation is rescheduled using its new countdown', async () => {
  const h = harness()
  h.config.candidatePoolLimit = 1
  let calls = 0
  h.discovery.verifyRoom = async () => {
    calls++
    return verified(h, 540, { lotteryId: `round-${calls}` })
  }
  await h.runner.start()
  await pulse(h)
  await pulse(h)
  await runFor(h, 451000)
  assert.equal(calls, 2)
  assert.equal(h.counts().entered, 0)
  assert.equal(h.runner.getState().candidateCount, 1)
  assert.equal(h.repo.account().decisions.at(-1)!.snapshot!.opportunity.lotteryId, 'round-2')
  await h.runner.stop()
})

test('new-room hourly limit preserves the pending queue and never cools down unvisited rooms', async () => {
  const h = harness()
  h.config.policy.newRoomsPerHour = 1
  await h.runner.start()
  await pulse(h)
  h.repo.change((a) => {
    a.navigations.push({ at: h.now(), url: 'https://live.douyin.com/87654321', fresh: true })
  })
  await runFor(h, 60000)
  assert.equal(h.counts().verifyCount, 0)
  assert.equal(h.runner.getState().pendingVerifyCount, 1)
  assert.match(h.runner.getState().waitingReason, /小时额度/)
  assert.equal(h.logs.filter((x) => x.includes('小时额度')).length, 1)
  assert.equal(Object.values(h.repo.account().rooms).filter((r) => r.failures > 0).length, 0)
  await h.runner.stop()
})

test('stop while reserved room is being verified closes its page and cannot hand it over', async () => {
  const h = harness()
  let release!: (result: VerifyRoomResult) => void,
    closed = 0
  h.discovery.verifyRoom = () =>
    new Promise((resolve) => {
      release = resolve
    })
  await h.runner.start()
  await pulse(h)
  await pulse(h)
  await h.runner.stop()
  const result = verified(h, 64)
  result.page = {
    close: async () => {
      closed++
    }
  } as Page
  release(result)
  await flush()
  assert.equal(h.counts().entered, 0)
  assert.equal(closed, 1)
  assert.equal(h.runner.getState().candidateCount, 0)
})
test('stop during a deferred login check cannot start a new run', async () => {
  const h = harness()
  let resolve!: (value: boolean) => void
  h.runner.setResumeCheck(
    () =>
      new Promise<boolean>((r) => {
        resolve = r
      })
  )
  const starting = h.runner.start()
  await h.runner.stop()
  resolve(true)
  await assert.rejects(starting, /取消/)
  assert.equal(h.runner.getState().running, false)
  assert.equal(h.env.execution.signal.aborted, true)
})

test('manual start waits for cancelled discovery to finish unwinding', async () => {
  const h = harness()
  let release!: () => void
  h.discovery.scan = async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return { rooms: [], riskDetected: false, riskReason: '' }
  }
  await h.runner.start()
  await h.runner.pulse()
  await h.runner.stop()
  await assert.rejects(h.runner.ensureManual(), /收尾/)
  assert.equal(h.env.execution.signal.aborted, true)
  release()
  await flush()
  await h.runner.ensureManual()
  assert.equal(h.runner.getState().status, 'running')
  await h.runner.stop()
})
test('manual room requests cannot bypass rest or risk holds', async () => {
  const h = harness()
  await h.runner.start()
  h.repo.change((a) => {
    a.session.phase = 'resting'
    a.session.nextResumeAt = h.now() + 60000
  })
  await assert.rejects(h.runner.ensureManual(), /休息/)
  h.repo.risk('challenge', 'fixture')
  await assert.rejects(h.runner.ensureManual(), /风险/)
  await h.runner.stop()
})
test('stop during resume check cancels the pending auto-resume', async () => {
  const h = harness()
  await h.runner.start()
  h.repo.change((a) => {
    a.session.phase = 'resting'
    a.session.nextResumeAt = h.now()
  })
  let resolve!: (v: boolean) => void
  h.runner.setResumeCheck(
    () =>
      new Promise<boolean>((r) => {
        resolve = r
      })
  )
  const pulse = h.runner.pulse()
  await flush()
  await h.runner.stop()
  resolve(true)
  await pulse
  assert.equal(h.runner.getState().status, 'stopped')
  assert.equal(h.env.execution.signal.aborted, true)
  assert.equal(h.counts().scanCount, 0)
})
test('planned rest resumes only after current checks, and restart is a fresh session', async () => {
  const h = harness()
  await h.runner.start()
  const first = h.repo.account().session.startedAt
  h.repo.change((a) => {
    a.session.phase = 'resting'
    a.session.nextResumeAt = h.now() + 60000
  })
  h.advance(60000)
  await h.runner.pulse()
  assert.equal(h.repo.account().session.phase, 'running')
  assert.notEqual(h.repo.account().session.startedAt, first)
  assert.equal(h.env.execution.signal.aborted, false)
  assert.equal(h.logs.filter(m => !m.trim()).length, 0)
  assert.equal(h.logs.filter(m => m.includes('休息结束，检查通过')).length, 1)
  await h.runner.stop()
})


test('finish request drops reservations, forbids continuation and produces a single report after room closes',async()=>{
  const h=harness();await h.runner.start()
  let active=true;h.rooms.getAllRooms=()=>active?[{} as Room]:[]
  await h.runner.finishCurrent();assert.equal(h.runner.getState().status,'draining')
  assert.match(h.continue(null,{url:'https://live.douyin.com/12345678',name:'x'})!,/停止/)
  await h.runner.pulse();assert.equal(h.runner.getState().status,'draining')
  active=false;await h.runner.pulse();assert.equal(h.runner.getState().status,'stopped')
  assert.equal(h.repo.account().runs?.length,1);const reason=h.repo.account().runs![0].reason
  await h.runner.stop('应用退出');assert.equal(h.repo.account().runs![0].reason,reason)
})


test('removing a queued round persists its skip and rejects stale queue commands',async()=>{
  const h=harness();h.discovery.verifyRoom=async()=>verified(h,540)
  await h.runner.start();await pulse(h);await pulse(h)
  const candidate=h.runner.getState().candidates[0]
  assert.ok(candidate)
  assert.throws(()=>h.runner.removeCandidate(candidate.url,'stale'),/变化/)
  h.runner.removeCandidate(candidate.url,candidate.lotteryId)
  assert.equal(h.runner.getState().candidateCount,0)
  assert.equal(h.repo.isSkipped(candidate.url,candidate.lotteryId),true)
  await h.runner.stop();await h.runner.start();await pulse(h);await pulse(h)
  assert.equal(h.runner.getState().candidateCount,0)
  await h.runner.stop()
})

test('measured return allowance preserves the 45-second task target and yields before the next reservation',async()=>{
  const h=harness(),url='https://live.douyin.com/12345678'
  h.repo.room(url);h.repo.recordVerificationTiming(url,6)
  h.discovery.verifyRoom=async()=>verified(h,300)
  await h.runner.start();await pulse(h);await pulse(h)
  const c=h.runner.getState().candidates[0]
  assert.equal(c.drawAt!-c.startAt,65000)
  assert.equal(c.drawAt!-c.taskAt,45000)
  h.advance(c.startAt-h.now()-5001)
  assert.equal(h.continue(null,{url,name:'fixture'}),null)
  h.advance(1)
  assert.match(h.continue(null,{url,name:'fixture'})!,/切换时间/)
  await h.runner.stop()
})
