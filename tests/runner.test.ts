import test from 'node:test'
import assert from 'node:assert/strict'
import { AutoRunner, AutoRunnerEnvironment } from '../src/main/auto-runner'
import { RuntimeRepository, emptyRuntime } from '../src/main/runtime-repository'
import { SessionEngine } from '../src/main/session-engine'
import { ExecutionGate, checkSignal } from '../src/main/execution-gate'
import { defaults } from '../src/shared/config'
import type { Room } from '../src/main/room-manager'
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
  const rooms = {
    setContinuationCheck: () => {},
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
    advance: (ms: number) => {
      time += ms
    },
    counts: () => ({ scanCount, verifyCount, closeCount, entered }),
    now: () => time
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
test('source scanning interval never delays a queued verification or drifts during idle polling', async () => {
  const h = harness()
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

test('free manual-participation bag with 64 seconds is taken over from the verification page', async () => {
  const h = harness()
  h.discovery.verifyRoom = async () => verified(h, 64)
  await h.runner.start({ scanIntervalSeconds: 180 })
  await pulse(h)
  await pulse(h)
  assert.equal(h.counts().entered, 1)
  assert.equal(h.runner.getState().candidateCount, 0)
  const d = h.repo.account().decisions.at(-1)!
  assert.equal(d.action, 'takeover')
  assert.equal(d.snapshot!.leadSeconds, 28)
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
  h.config.candidatePoolLimit = 1
  let calls = 0,
    drawAt = 0
  h.discovery.verifyRoom = async () => {
    calls++
    if (calls === 1) drawAt = h.now() + 540000
    else h.advance(25000)
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
  await runFor(h, 72000)
  assert.equal(calls, 2)
  assert.equal(h.counts().entered, 1)
  assert.equal(h.runner.getState().candidateCount, 0)
  assert.equal(h.repo.account().decisions.at(-1)!.action, 'takeover')
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
    await runFor(h, 402000)
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
  await runFor(h, 402000)
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
  await h.runner.stop()
})
