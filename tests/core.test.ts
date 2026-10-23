import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ref } from 'vue'
import { DEFAULT_POLICY, Opportunity, validatePolicy, normalizeRoomUrl } from '../src/shared/policy'
import { validateConfigPatch } from '../src/shared/config-validation'
import { RuntimeRepository, emptyRuntime, allowedNow, dayKey } from '../src/main/runtime-repository'
import { SessionEngine, seededRandom } from '../src/main/session-engine'
import { ExecutionGate, delay, checkSignal, navigationQuotaReadyAt, navigationSpacingReadyAt } from '../src/main/execution-gate'
import { parseLottery, parseLotteryPayload, panelIdentity, parseOwnResult, supplementVisibleTask, riskFromText } from '../src/main/lottery-parser'
import { evaluate, bestSchedule, rankHistory, taskLead, projectedParticipants } from '../src/main/strategy'

const url = 'https://live.douyin.com/12345678',
  url2 = 'https://live.douyin.com/87654321'
function setup(spent = 0) {
  let data = emptyRuntime(),
    now = Date.UTC(2026, 9, 22, 2)
  const repo = new RuntimeRepository(
    {
      read: () => data,
      write: (v) => {
        data = structuredClone(v)
      }
    },
    () => now
  )
  repo.bind('account-a', { spent, stats: { diamondWonAmount: 100 }, rooms: [{ url, name: 'sample' }] })
  return {
    repo,
    time: (v: number) => {
      now = v
    },
    advance: (ms: number) => {
      now += ms
    },
    now: () => now
  }
}
function opportunity(now: number, patch: Partial<Opportunity> = {}): Opportunity {
  return {
    lotteryId: 'round-1',
    drawAt: now + 180000,
    observedAt: now,
    source: 'network',
    confidence: 'exact',
    prizeType: 'diamond',
    winnerCount: null,
    participantCount: null,
    totalDiamonds: null,
    diamondPerWinner: null,
    cost: 0,
    membership: 'satisfied',
    requiresFollow: false,
    requiresComment: false,
    requiresShare: false,
    commentText: '',
    watchSeconds: 0,
    unsupported: [],
    tasksKnown: true,
    ...patch
  }
}
const p = {
  ...DEFAULT_POLICY,
  membership: 'whitelist' as const,
  anchorSpend: 10,
  dailySpend: 10,
  dailyNewClubs: 10
}

test('configuration rejects private ledger fields, unknown fields and nonfinite values', () => {
  for (const input of [
    { diamondUsed: 0 },
    { runStats: {} },
    { autoFollow: false },
    { diamondBudget: NaN },
    { candidatePoolLimit: 6 },
    { policy: { sessionMin: 50, sessionMax: 20 } },
    { policy: { navigationMinSeconds: 1 } },
    { policy: { allowedStart: '25:00' } },
    { policy: { timezone: 'Invalid/Zone' } },
    { policy: JSON.parse('{"__proto__":{}}') }
  ])
    assert.throws(() => validateConfigPatch(input))
  assert.equal(validateConfigPatch({ diamondBudget: 0 }).diamondBudget, 0)
  assert.equal(validatePolicy({}).timezone, 'Asia/Shanghai')
})
test('settings drafts produce detached data that Electron can clone', () => {
  const draft = ref({
    fudaiTypes: { all: false, physical: true, diamond: true },
    diamondBudget: 50,
    allowDiamondProfit: false,
    debugLogs: false,
    scanIntervalSeconds: 40,
    enterBeforeSeconds: 75,
    candidatePoolLimit: 4,
    policy: { ...DEFAULT_POLICY, dailySpend: 50, anchorSpend: 5 }
  })
  const patch = validateConfigPatch(draft.value)
  const snapshot = structuredClone(patch)
  assert.deepEqual(snapshot, {
    ...draft.value,
    fudaiTypes: { all: false, physical: true, diamond: true },
    policy: { ...DEFAULT_POLICY, dailySpend: 50, anchorSpend: 5 }
  })
  patch.fudaiTypes!.all = true
  patch.policy!.dailySpend = 10
  assert.equal(draft.value.fudaiTypes.all, false)
  assert.equal(draft.value.policy.dailySpend, 50)
  draft.value.fudaiTypes.diamond = false
  assert.equal(patch.fudaiTypes!.diamond, true)
})

test('URLs are canonical and reject spoofed domains, reserved paths and UUIDs', () => {
  assert.equal(normalizeRoomUrl(url + '?from=feed#x'), url)
  for (const bad of [
    'https://evil-douyin.com/123456',
    'https://live.douyin.com/search',
    'https://live.douyin.com/123456/more',
    'https://live.douyin.com/12345678-1234-1234-1234-123456789012',
    'file:///123456'
  ])
    assert.throws(() => normalizeRoomUrl(bad))
})
test('migration preserves spent, isolates accounts, and never credits legacy wins', () => {
  const { repo } = setup(8)
  assert.equal(repo.budget(10, true, p).remaining, 2)
  assert.equal(repo.account().rooms[url].membership, 'unknown')
  repo.bind('account-b', { spent: 8, stats: {}, rooms: [] })
  assert.equal(repo.budget(10, true, p).spent, 0)
  repo.bind('account-a', { spent: 999, stats: {}, rooms: [] })
  assert.equal(repo.budget(10, true, p).spent, 8)
})
test('last unit can be reserved exactly once across rooms', () => {
  const { repo } = setup()
  repo.updateRoom(url, { allowPaid: true })
  repo.updateRoom(url2, { allowPaid: true })
  const entry = repo.reserve(url, 'bag1', 1, 1, false, p)
  assert.throws(() => repo.reserve(url2, 'bag2', 1, 1, false, p), /预算/)
  assert.throws(() => repo.reserve(url, 'bag1', 1, 10, false, p), /重复/)
  repo.payment(entry.id, 'confirmed')
  repo.payment(entry.id, 'confirmed')
  assert.equal(repo.budget(1, false, p).spent, 1)
})
test('failed payment releases reservation while unknown payment survives restart', () => {
  const { repo } = setup()
  repo.updateRoom(url, { allowPaid: true })
  const first = repo.reserve(url, 'bag1', 1, 2, false, p)
  repo.payment(first.id, 'failed')
  assert.equal(repo.budget(2, false, p).remaining, 2)
  const second = repo.reserve(url, 'bag2', 1, 2, false, p)
  repo.payment(second.id, 'submitted')
  repo.recover()
  assert.equal(repo.read().activeAccount, null)
  repo.bind('account-a', { spent: 0, stats: {}, rooms: [] })
  assert.equal(repo.account().payments[second.id].state, 'unresolved')
  assert.equal(repo.budget(2, false, p).remaining, 1)
  assert.throws(() => new SessionEngine(repo).start(p), /未决支付/)
})
test('free eligibility is allowed at zero budget and existing-only policy', () => {
  const { repo } = setup(10)
  assert.equal(repo.canPay(url, 0, 0, false, { ...p, membership: 'existing' }), null)
  assert.match(repo.canPay(url, 1, 10, false, { ...p, membership: 'existing' })!, /已有/)
  assert.match(repo.canPay(url, null, 10, false, p)!, /未知/)
})
test('new clubs, daily costs, per-host costs and single costs are independent caps', () => {
  const { repo } = setup()
  repo.updateRoom(url, { allowPaid: true })
  repo.updateRoom(url2, { allowPaid: true })
  assert.match(repo.canPay(url, 2, 10, false, p)!, /单次/)
  const entry = repo.reserve(url, 'b', 1, 10, false, p)
  repo.payment(entry.id, 'confirmed')
  assert.match(repo.canPay(url, 1, 10, false, { ...p, anchorSpend: 1 })!, /主播/)
  assert.match(repo.canPay(url2, 1, 10, false, { ...p, dailySpend: 1 })!, /预算/)
  assert.match(repo.canPay(url2, 1, 10, false, { ...p, dailyNewClubs: 1 })!, /新开团/)
  assert.equal(repo.canPay(url, 1, 10, false, { ...p, dailyNewClubs: 1 }), null)
})
test('prefer allows first discovery within budget while restrictive policies and limits still apply', () => {
  const { repo } = setup(),
    prefer = { ...p, membership: 'prefer' as const }
  repo.visit(url, true)
  assert.equal(repo.canPay(url, 1, 10, false, prefer), null)
  assert.match(repo.canPay(url, 1, 0, false, prefer)!, /预算/)
  assert.match(repo.canPay(url, 2, 10, false, prefer)!, /单次/)
  assert.match(repo.canPay(url, 1, 10, false, {...prefer,membership:'whitelist'})!, /许可/)
  assert.match(repo.canPay(url, 1, 10, false, {...prefer,membership:'existing'})!, /已有/)
})

test('source scanning does not reset room spacing, and long stays satisfy spacing without extra wait', () => {
  const now=1000000, source={url:'https://live.douyin.com',at:now}, room={url,at:now-60000}
  assert.equal(navigationSpacingReadyAt([source],url,180000,now+20000),now+20000)
  assert.equal(navigationSpacingReadyAt([room,source],url2,180000,now+20000),room.at+180000)
  assert.equal(navigationSpacingReadyAt([room],url2,180000,now+300000),now+300000)
  assert.equal(navigationSpacingReadyAt([source],source.url,180000,now+20000),now+180000)
})
test('submission, confirmation, late win and amount updates are idempotent', () => {
  const { repo, advance, now } = setup()
  repo.record(url, 'b', { submittedAt: now() })
  assert.equal(repo.stats().participated, 0)
  assert.equal(repo.stats().submittedUnknown, 1)
  repo.record(url, 'b', { confirmedAt: now(), taskSeconds: 8 })
  advance(1000)
  repo.record(url, 'b', { result: 'won', prizeType: 'diamond', diamondAmount: 0 })
  repo.record(url, 'b', { result: 'won', prizeType: 'diamond', diamondAmount: 10 })
  repo.record(url, 'b', {
    result: 'won',
    prizeType: 'diamond',
    diamondAmount: 10,
    taskSeconds: 900,
    confirmedAt: now()
  })
  repo.record(url, 'b', { result: 'unknown', diamondAmount: 0 })
  assert.equal(repo.stats().participated, 1)
  assert.equal(repo.stats().diamondWins, 1)
  assert.equal(repo.stats().diamondWonAmount, 10)
  assert.equal(repo.account().rounds[repo.roundKey(url, 'b')].taskSeconds, 8)
})
test('display reset does not release spending or erase verified reward credit', () => {
  const { repo, now, advance } = setup(4)
  repo.record(url, 'b', { confirmedAt: now(), result: 'won', prizeType: 'diamond', diamondAmount: 10 })
  advance(1)
  repo.change((a) => {
    a.statsSince = now()
  })
  assert.equal(repo.stats().participated, 0)
  assert.equal(repo.budget(5, true, { ...p, reinvestRatio: 0.5, reinvestCap: 3 }).remaining, 4)
})
test('daily rollover leaves global spending and reservations intact', () => {
  const { repo, time } = setup()
  repo.updateRoom(url, { allowPaid: true })
  repo.reserve(url, 'b', 1, 3, false, p)
  time(Date.UTC(2026, 9, 23, 2))
  assert.equal(repo.budget(3, false, p).dailyRemaining, 9)
  assert.equal(repo.budget(3, false, p).remaining, 2)
})

test('late payment confirmation occupies the confirmation day and is idempotent', () => {
  const { repo, time } = setup()
  repo.updateRoom(url, { allowPaid: true })
  const entry = repo.reserve(url, 'late-payment', 1, 3, false, p)
  time(Date.UTC(2026, 9, 23, 2))
  repo.payment(entry.id, 'confirmed')
  assert.equal(repo.budget(3, false, p).dailyRemaining, 9)
  const confirmedAt = repo.account().payments[entry.id].confirmedAt
  time(Date.UTC(2026, 9, 24, 2))
  repo.payment(entry.id, 'confirmed')
  assert.equal(repo.account().payments[entry.id].confirmedAt, confirmedAt)
  assert.equal(repo.budget(3, false, p).dailyRemaining, 10)
  assert.equal(repo.budget(3, false, p).spent, 1)
})

test('known membership permits relighting without consuming a new-club slot', () => {
  const { repo, now } = setup()
  repo.updateRoom(url, { allowPaid: true })
  repo.observe(url, opportunity(now(), { memberKnown: true, membership: 'needs-payment', cost: 1 }))
  const noNewClubs = { ...p, dailyNewClubs: 0 }
  assert.equal(repo.canPay(url, 1, 3, false, noNewClubs), null)
  const entry = repo.reserve(url, 'relight', 1, 3, false, noNewClubs)
  assert.equal(entry.newClub, false)
  assert.equal(repo.budget(3, false, noNewClubs).remaining, 2)
})

test('free task eligibility does not imply membership or bypass new-club limits', () => {
  const { repo, now } = setup()
  repo.updateRoom(url, { allowPaid: true })
  repo.observe(url, opportunity(now(), { membership: 'satisfied', cost: 0 }))
  assert.notEqual(repo.account().rooms[url].memberKnown, true)
  assert.equal(repo.canPay(url, 0, 3, false, { ...p, dailyNewClubs: 0 }), null)
  assert.match(repo.canPay(url, 1, 3, false, { ...p, dailyNewClubs: 0 })!, /新开团/)
})
test('cooldowns persist and repeat failures back off without depending on wins', () => {
  const { repo, now } = setup()
  repo.visit(url, false)
  assert.equal(repo.account().rooms[url].nextEligibleCheckAt, now() + 30 * 60000)
  repo.visit(url, false)
  assert.equal(repo.account().rooms[url].nextEligibleCheckAt, now() + 60 * 60000)
  repo.recover()
  repo.bind('account-a', { spent: 0, stats: {}, rooms: [] })
  assert.equal(rankHistory(Object.values(repo.account().rooms), now(), p, () => 0.5).length, 0)
})
test('draw time uses server offset and optional fields remain unknown', () => {
  const fixture = JSON.parse(fs.readFileSync('tests/fixtures/lottery.json', 'utf8'))
  const o = parseLottery(JSON.stringify(fixture), 2000000000000)!
  assert.equal(o.drawAt, 2000000120000)
  assert.equal(o.commentText, '测试口令')
  assert.equal(o.cost, 1)
  assert.equal(o.totalDiamonds, 30)
  delete fixture.data.lottery_info.participant_count
  fixture.data.lottery_info.online_count = 999
  assert.equal(parseLottery(JSON.stringify(fixture))!.participantCount, null)
})
test('generic countdowns and failed business responses are not lottery evidence', () => {
  for (const v of [
    { countdown: 30 },
    { data: { count_down: 20 } },
    { status_code: 95152, data: { lottery_info: { draw_time: 1900000000 } } }
  ])
    assert.equal(parseLottery(JSON.stringify(v)), null)
})
test('member activity and current task completion are distinguished from historical membership', () => {
  const base = {
    data: {
      lottery_info: {
        lottery_id: 'x',
        count_down: 120,
        conditions: [{ type: 8, description: '加入粉丝团', status: 0 }]
      },
      user_condition: { is_fansclub_member: true, fansclub_status_active: false }
    }
  }
  assert.equal(parseLottery(JSON.stringify(base))!.cost, null)
  base.data.lottery_info.conditions[0].status = 1
  assert.equal(parseLottery(JSON.stringify(base))!.cost, 0)
  base.data.lottery_info.conditions[0].status = 0
  const o = supplementVisibleTask(parseLottery(JSON.stringify(base))!, '加入粉丝团（1钻石）')
  assert.equal(o.cost, 1)
})
test('share, unknown conditions and watch durations fail closed', () => {
  const make = (c: any) =>
    parseLottery(
      JSON.stringify({ data: { lottery_info: { lottery_id: 'b', count_down: 300, conditions: [c] } } })
    )!
  assert.equal(make({ type: 4 }).requiresShare, true)
  assert.equal(make({ description: '观看直播5分钟' }).watchSeconds, null)
  assert.equal(make({ description: '观看直播', remaining_seconds: 60 }).watchSeconds, 60)
  assert.equal(make({ type: 999 }).unsupported.length, 1)
})

test('lottery IDs retain all 64 bits; rights binding rejects conflicts, generic success and failed responses', () => {
  const raw = '{"status_code":0,"data":{"lottery_info":{"lottery_id":7399123456789012345,"count_down":180,"conditions":[]}}}'
  const id = '7399123456789012345'
  assert.equal(parseLottery(raw)!.lotteryId, id)
  const endpoint = new URL(`https://live.douyin.com/webcast/lottery/right/?lottery_id=${id}`)
  assert.equal(panelIdentity(parseLotteryPayload(raw), endpoint).id, id)
  assert.equal(panelIdentity({ status_code: 0, data: { user_condition: {} } }, endpoint).id, id)
  assert.equal(panelIdentity({ status_code: 0, data: { user_condition: {} } }, new URL(endpoint.origin + endpoint.pathname), `lottery_id=${id}`).id, id)
  assert.equal(panelIdentity({ status_code: 0, data: {} }, endpoint).id, null)
  assert.equal(panelIdentity({ status_code: 1, data: { user_condition: {} } }, endpoint).id, null)
  assert.equal(panelIdentity({ status_code: null, data: { user_condition: {} } }, endpoint).id, null)
  assert.equal(parseLottery('null'), null)
  assert.equal(panelIdentity(parseLotteryPayload(raw), endpoint, 'lottery_id=other').id, null)
})

test('command keywords are not follow/fan/share tasks and current incomplete status beats historical flags', () => {
  for (const type of [3, undefined]) {
    const o = parseLottery(JSON.stringify({ data: { lottery_info: { lottery_id: 'command', count_down: 180,
      conditions: [{ type, description: '发送评论：关注价值3000元显卡，加入粉丝团', status: 0 }]
    }, user_condition: { has_command: true, has_follow: true } } }))!
    assert.equal(o.requiresComment, true)
    assert.equal(o.commentText, '关注价值3000元显卡，加入粉丝团')
    assert.equal(o.requiresFollow, false)
    assert.equal(o.membership, 'satisfied')
    assert.equal(o.cost, 0)
  }
})

test('only level one or explicitly satisfied fan levels can participate; active membership never proves higher levels', () => {
  const make = (description: string, status?: number) => parseLottery(JSON.stringify({ data: {
    lottery_info: { lottery_id: 'level', count_down: 180, conditions: [{ type: 8, description, status }] },
    user_condition: { is_fansclub_member: true, fansclub_status_active: true }
  } }))!
  const one = make('粉丝团点亮且达到1级及以上', 0)
  assert.deepEqual(one.unsupported, [])
  assert.equal(one.cost, null)
  assert.equal(supplementVisibleTask(one, '加入粉丝团（1钻）').cost, 1)
  for (const description of ['粉丝团点亮且达到2级及以上', '粉丝团等级未知', '粉丝团等级>1级']) {
    assert.match(make(description, 0).unsupported.join(), /等级/)
    assert.match(make(description).unsupported.join(), /等级/)
    assert.deepEqual(make(description, 1).unsupported, [])
  }
  const two = make('粉丝团点亮且达到2级及以上', 0)
  assert.match(supplementVisibleTask(two, '加入粉丝团 已达成', true).unsupported.join(), /等级/)
  assert.deepEqual(supplementVisibleTask(two, '粉丝团点亮且达到2级及以上\n已达成', true).unsupported, [])
  assert.match(supplementVisibleTask(two, '粉丝团点亮且达到2级及以上\n已达成').unsupported.join(), /等级/)
  assert.match(supplementVisibleTask(one, '粉丝团点亮且达到2级及以上 未达成\n提升亲密度', true).unsupported.join(), /等级/)
})

test('only bound panel rows update task completion and audience participation is not own confirmation', () => {
  const o = parseLottery(JSON.stringify({ data: { lottery_info: { lottery_id: 'rows', count_down: 180,
    conditions: [{ type: 3, description: '发送评论：我的爱播', status: 0 }, { type: 1, description: '关注主播', status: 0 }]
  } } }))!
  const text = '福袋\n发送评论：我的爱播\n已达成\n关注主播\n已完成\n免费参与'
  assert.equal(supplementVisibleTask(o, text).requiresComment, true)
  assert.equal(supplementVisibleTask(o, text, true).requiresComment, false)
  assert.equal(supplementVisibleTask(o, text, true).requiresFollow, false)
  assert.equal(supplementVisibleTask(o, '免费参与', true).requiresComment, true)
  assert.equal(supplementVisibleTask(o, '关注并分享直播间 未达成', true).requiresShare, true)
  assert.ok(supplementVisibleTask(o, '购买商品 未达成', true).unsupported.length)
  for (const text of ['福袋 52人已参与', '1.2万人已参与', '已参与 52 人', '未参与成功', '发送评论：已参与\n未达成', '评论：恭喜您获得100钻石\n未达成'])
    assert.equal(parseOwnResult(text).participated, false)
  assert.equal(parseOwnResult('52人已参与\n已参与，等待开奖').participated, true)
})

test('manual participation is a submit step; it never implies confirmation or permits other unknown tasks', () => {
  const make = (conditions: unknown[]) =>
    parseLottery(
      JSON.stringify({
        data: { lottery_info: { lottery_id_str: 'manual-fixture', count_down: 64, conditions } }
      }),
      1000000
    )!
  const free = make([{ type: 1, description: '手动参与', status: 0 }])
  assert.equal(free.cost, 0)
  assert.equal(free.requiresFollow, false)
  assert.deepEqual(free.unsupported, [])
  assert.equal(evaluate(free, p, 1000000, undefined, [], true).feasible, true)
  for (const description of ['手动参与并购买商品', '未知资格限制'])
    assert.equal(make([{ description, status: 0 }]).unsupported.length, 1)
  for (const description of ['转发直播间', '分享直播间', '转发并发送评论']) {
    const o = make([{ description, status: 1 }, { description: '手动参与' }])
    assert.equal(o.requiresShare, true)
    assert.match(evaluate(o, p, 1000000, undefined, [], true).reason, /分享/)
  }
})

test('task claims survive recovery and remain scoped to account, room and lottery', () => {
  const { repo } = setup()
  repo.claimAction(url, 'claimed', 'comment', '测试口令')
  repo.claimAction(url, 'claimed', 'follow')
  const accountId = repo.read().activeAccount!
  repo.recover()
  repo.bind(accountId, { spent: 0, stats: {}, rooms: [] })
  assert.throws(() => repo.claimAction(url, 'claimed', 'comment', '测试口令'), /禁止重复/)
  assert.throws(() => repo.claimAction(url, 'claimed', 'follow'), /禁止重复/)
  repo.claimAction(url, 'other-round', 'comment', '测试口令')
  repo.claimAction(url2, 'claimed', 'comment', '测试口令')
  repo.bind('another-account', { spent: 0, stats: {}, rooms: [] })
  repo.claimAction(url, 'claimed', 'comment', '测试口令')
})

test('comment commands come from explicit content or labelled text, never from an instruction alone', () => {
  const make = (c: unknown) =>
    parseLottery(
      JSON.stringify({ data: { lottery_info: { lottery_id: 'comment', count_down: 300, conditions: [c] } } })
    )!
  assert.equal(make({ description: '发送口令', content: '测试口令' }).commentText, '测试口令')
  assert.equal(make({ type: 3, content: '我的爱播！好运，来到。' }).commentText, '我的爱播！好运，来到。')
  assert.equal(make({ type: 3, content: '发表评论' }).commentText, '')
  assert.equal(make({ description: '评论：好运来到' }).commentText, '好运来到')
  assert.equal(make({ description: '发送“好运来到”参与福袋' }).commentText, '好运来到')
  const unknown = make({ description: '发表评论' })
  assert.equal(unknown.commentText, '')
  assert.match(evaluate(unknown, p, Date.now(), undefined, [], true).reason, /口令/)
  assert.equal(supplementVisibleTask(unknown, '福袋参与条件\n发送口令：“好运来到”').commentText, '好运来到')
})

test('hourly navigation quota waits for slots without changing room cooldowns', () => {
  const now = 4000000,
    policy = { ...p, navigationsPerHour: 3, newRoomsPerHour: 1 }
  const visits = [{ at: now - 1000, fresh: true }]
  assert.equal(navigationQuotaReadyAt(visits, policy, now, true), now - 1000 + 3600000)
  assert.equal(navigationQuotaReadyAt(visits, policy, now, false), now)
  assert.equal(navigationQuotaReadyAt(visits, policy, now + 3599000, true), now + 3599000)
  assert.equal(navigationQuotaReadyAt([], { ...policy, newRoomsPerHour: 0 }, now, true), Infinity)
})
test('only own result wording credits a diamond amount, not generic congratulation or coins', () => {
  assert.equal(parseOwnResult('恭喜用户小明获得100钻石').won, false)
  assert.equal(parseOwnResult('恭喜您获得100钻石').diamondAmount, 100)
  assert.equal(parseOwnResult('恭喜您获得100抖币').diamondAmount, null)
  assert.equal(parseOwnResult('已参与，等待开奖').won, false)
  assert.equal(parseOwnResult('本次未中奖').lost, true)
})
test('risk text matching requires explicit restrictions', () => {
  assert.equal(riskFromText('网络慢，稍后再试，主播介绍安全验证'), '安全验证')
  assert.equal(riskFromText('请稍后再试'), '')
  assert.ok(riskFromText('请完成安全验证'))
})
test('unknown odds retain fallback and online count is not used', () => {
  const { now } = setup(),
    e = evaluate(opportunity(now()), p, now(), undefined, [], true)
  assert.equal(e.mode, 'fallback')
  assert.equal(e.probability, null)
  assert.equal(e.feasible, true)
  assert.equal(
    evaluate(opportunity(now(), { winnerCount: 2, participantCount: 100 }), p, now(), undefined, [], true).probability,
    0.02
  )
})
test('task lead accounts for paid/comment/watch work and existing page avoids another navigation', () => {
  const { now } = setup(),
    o = opportunity(now(), { watchSeconds: 45, requiresComment: true, membership: 'needs-payment', cost: 1 })
  assert.ok(taskLead(o, p) > taskLead(o, p, [], true))
  assert.equal(evaluate({ ...o, drawAt: now() + 10000 }, p, now()).feasible, false)
})

test('return lead budgets loading and revalidation separately from remaining tasks',()=>{
  const {now}=setup()
  const o=opportunity(now(),{requiresComment:true,membership:'needs-payment',cost:1})
  assert.equal(taskLead(o,p),80)
  assert.equal(taskLead(o,{...p,navigationMaxSeconds:600}),80)
  assert.equal(taskLead(o,p,[],true),35)
  assert.equal(taskLead({...o,watchSeconds:60},p),140)
})

test('an explicit non-participant result never counts as participation or loss',()=>{
  const result=parseOwnResult('您未参与本轮福袋，本次未中奖')
  assert.equal(result.participated,false)
  assert.equal(result.lost,false)
  assert.equal(result.won,false)
})

test('own result variants distinguish unknown amounts and preserve named prize quantities',()=>{
  for (const text of ['恭喜中奖！\n8钻', '恭喜您中奖！获得8钻石', '中奖啦！\n钻石奖励：8']) {
    const r=parseOwnResult(text)
    assert.equal(r.won,true,text); assert.equal(r.diamondAmount,8,text)
  }
  const unknown=parseOwnResult('恭喜中奖！\n奖品：钻石\n总2000钻\n200个福袋')
  assert.equal(unknown.won,true); assert.equal(unknown.diamondAmount,null)
  assert.equal(parseOwnResult('恭喜中奖！\n奖励：0钻石').diamondAmount,0)
  const prize=parseOwnResult('恭喜中奖！\n奖品：蓝牙耳机 × 2副\n请填写收货地址')
  assert.equal(prize.prizeType,'physical'); assert.equal(prize.prizeName,'蓝牙耳机')
  assert.equal(prize.prizeQuantity,2); assert.equal(prize.prizeUnit,'副')
  const coupon=parseOwnResult('恭喜您获得10元优惠券1张')
  assert.equal(coupon.prizeType,'coupon'); assert.equal(coupon.prizeName,'10元优惠券')
  assert.equal(coupon.prizeQuantity,1)
  const separate=parseOwnResult('恭喜中奖！ 奖品：蓝牙耳机 数量：2副 请填写收货地址')
  assert.equal(separate.prizeName,'蓝牙耳机');assert.equal(separate.prizeQuantity,2)
  const unitUnknown=parseOwnResult('恭喜中奖！\n奖品：蓝牙耳机\n数量：2\n请填写收货地址')
  assert.equal(unitUnknown.prizeQuantity,2);assert.equal(unitUnknown.prizeUnit,null)
  assert.equal(parseOwnResult('恭喜中奖！\n8钻\n12钻').diamondAmount,null)
  assert.equal(parseOwnResult('很遗憾，这次没抽中，下次好运').lost,true)
  for (const text of ['未成功参与，本次未中奖','恭喜用户小明获得100钻石','评论：恭喜中奖！','我的奖品','恭喜中奖！本次未中奖','恭喜您获得抽奖资格','本次获得1次抽奖机会']) {
    const r=parseOwnResult(text); assert.equal(r.won,false,text)
  }
})

test('unknown reward contributes no budget and later details update one record without losing known data',()=>{
  const {repo,now}=setup(),url='https://live.douyin.com/12345678'
  repo.record(url,'result',{confirmedAt:now(),result:'won',prizeType:'diamond',diamondAmount:null})
  assert.equal(repo.stats().diamondWonAmount,0)
  assert.equal(repo.account().rounds[repo.roundKey(url,'result')].diamondAmount,null)
  repo.record(url,'result',{result:'won',prizeType:'diamond',diamondAmount:8})
  repo.record(url,'result',{result:'won',prizeType:'unknown',diamondAmount:null})
  assert.equal(repo.stats().diamondWonAmount,8)
  repo.record(url,'physical',{confirmedAt:now(),result:'won',prizeType:'physical',prizeName:'蓝牙耳机'})
  repo.record(url,'physical',{result:'won',prizeQuantity:2,prizeUnit:'副'})
  repo.record(url,'physical',{result:'unknown',prizeName:null,prizeQuantity:null,prizeUnit:null})
  const r=repo.account().rounds[repo.roundKey(url,'physical')]
  assert.equal(r.result,'won'); assert.equal(r.prizeName,'蓝牙耳机'); assert.equal(r.prizeQuantity,2)
  assert.equal(repo.stats().physicalWins,1)
})

test('candidate combination reserves both occupancy and navigation gaps',()=>{
  const {now}=setup(),base=evaluate(opportunity(now()),p,now(),undefined,[],true)
  const items=[0,90000,180000].map((startAt,id)=>({id,evaluation:{...base,startAt,endAt:startAt+70000}}))
  assert.deepEqual(bestSchedule(items,5,120).map(r=>r.id),[0,2])
})
test('scheduling maximizes total utility among compatible occupancy intervals', () => {
  const { now } = setup(),
    base = evaluate(opportunity(now()), p, now(), undefined, [], true)
  const a = { id: 'a', evaluation: { ...base, startAt: 0, endAt: 10, score: 100, utility: 1 } },
    b = { id: 'b', evaluation: { ...base, startAt: 0, endAt: 20, score: 1, utility: 5 } },
    c = { id: 'c', evaluation: { ...base, startAt: 10, endAt: 20, score: 100, utility: 1 } }
  assert.deepEqual(
    bestSchedule([a, b, c]).map((x) => x.id),
    ['b']
  )
  assert.deepEqual(
    bestSchedule([a, c]).map((x) => x.id),
    ['a', 'c']
  )
})
test('participant growth requires three observations and never invents a negative rate', () => {
  const { repo, now } = setup(),
    o = opportunity(now(), { participantCount: 100 })
  assert.equal(projectedParticipants(o, repo.account().rooms[url]), 100)
  for (let i = 0; i < 3; i++)
    repo.observe(url, { ...o, observedAt: now() - 40000 + i * 20000, participantCount: 60 + i * 20 })
  assert.equal(projectedParticipants(o, repo.account().rooms[url]), 280)
})
test('seeded near-tie ordering is replayable and blocked rooms are excluded', () => {
  const { repo, now } = setup()
  repo.room(url2)
  repo.updateRoom(url, { blocked: true })
  const rooms = Object.values(repo.account().rooms)
  assert.deepEqual(
    rankHistory(rooms, now(), p, seededRandom(4)),
    rankHistory(rooms, now(), p, seededRandom(4))
  )
  assert.equal(rankHistory(rooms, now(), p, seededRandom(4))[0].url, url2)
})
test('cross-midnight allowed hours and timezone daily boundary', () => {
  const schedule = { ...p, allowedStart: '22:00', allowedEnd: '02:00' }
  assert.equal(allowedNow(Date.UTC(2026, 9, 22, 15), schedule), true)
  assert.equal(allowedNow(Date.UTC(2026, 9, 22, 3), schedule), false)
  assert.notEqual(
    dayKey(Date.UTC(2026, 9, 22, 15, 59, 59), p.timezone),
    dayKey(Date.UTC(2026, 9, 22, 16), p.timezone)
  )
})
test('session drains then rests once; planned resume is distinct from manual restart', () => {
  const { repo, advance, now } = setup(),
    engine = new SessionEngine(repo, () => 0.1),
    short = { ...p, sessionMin: 3, sessionMax: 3, breakMin: 1, breakMax: 1 }
  engine.start(short)
  advance(60000)
  engine.tick(true)
  advance(40000)
  assert.equal(engine.tick(true).phase, 'draining')
  const rest = engine.tick(false)
  assert.equal(rest.phase, 'resting')
  const resume = rest.nextResumeAt
  advance(30000)
  assert.equal(engine.tick(false).nextResumeAt, resume)
  advance(30000)
  assert.equal(engine.tick(false).phase, 'resume-check')
  engine.start(short)
  engine.stop()
  advance(60000)
  assert.equal(engine.tick(false).phase, 'stopped')
  assert.ok(now() > 0)
})
test('hard deadline closes unfinished work, but time accounting stops at the boundary', () => {
  const { repo, advance, now } = setup(),
    engine = new SessionEngine(repo),
    short = { ...p, sessionMin: 1, sessionMax: 1 }
  engine.start(short)
  advance(70000)
  assert.equal(engine.tick(true).phase, 'resting')
  assert.equal(repo.account().session.activeByDay[dayKey(now(), p.timezone)], 60000)
})
test('clock rollback and sleep never replay missed sessions', () => {
  for (const gap of [-1000, 120000]) {
    const { repo, advance } = setup(),
      e = new SessionEngine(repo)
    e.start(p)
    advance(gap)
    assert.equal(e.tick(false).phase, 'stopped')
  }
})
test('risk survives stop and restart and is never timer-resumed', () => {
  const { repo, advance } = setup(),
    e = new SessionEngine(repo)
  e.start(p)
  repo.risk('challenge', 'fixture')
  e.stop()
  advance(3600000)
  assert.equal(e.tick(false).phase, 'blocked')
  assert.throws(() => e.start(p), /风险/)
  repo.recover()
  repo.bind('account-a', { spent: 0, stats: {}, rooms: [] })
  assert.equal(repo.account().session.phase, 'blocked')
  repo.resolveRisk()
  assert.equal(repo.account().session.phase, 'stopped')
})
test('restart never auto-runs and does not clear cooldown or budget', () => {
  const { repo } = setup(2),
    e = new SessionEngine(repo)
  e.start(p)
  repo.visit(url, false)
  const next = repo.account().rooms[url].nextEligibleCheckAt
  repo.recover()
  repo.bind('account-a', { spent: 0, stats: {}, rooms: [] })
  assert.equal(repo.account().session.phase, 'stopped')
  assert.equal(repo.account().rooms[url].nextEligibleCheckAt, next)
  assert.equal(repo.budget(3, false, p).spent, 2)
})
test('cancellation rejects queued operations and old generations cannot resume', async () => {
  const gate = new ExecutionGate()
  gate.start()
  const old = gate.signal
  let calls = 0
  const first = gate.run(
      old,
      async () => {
        calls++
      },
      () => delay(1000, old)
    ),
    second = gate.run(old, async () => {
      calls++
    })
  const results = Promise.allSettled([first, second])
  gate.stop()
  gate.start()
  assert.equal((await results).filter((x) => x.status === 'rejected').length, 2)
  assert.equal(calls, 0)
  await assert.rejects(gate.run(old, async () => {}))
  await gate.run(gate.signal, async () => {
    calls++
  })
  assert.equal(calls, 1)
})
test('abortable wait releases immediately', async () => {
  const a = new AbortController(),
    start = Date.now(),
    wait = delay(10000, a.signal)
  a.abort()
  await assert.rejects(wait)
  assert.ok(Date.now() - start < 500)
  assert.throws(() => checkSignal(a.signal))
})
test('allowed-hours boundary is part of the hard admission deadline', () => {
  const h = setup()
  h.time(Date.UTC(2026, 9, 22, 15, 58))
  const engine = new SessionEngine(h.repo)
  const s = engine.start({ ...p, allowedStart: '22:00', allowedEnd: '00:00' })
  assert.equal(s.hardStopAt, Date.UTC(2026, 9, 22, 16))
  assert.equal(engine.canFinish(Date.UTC(2026, 9, 22, 16)), false)
})
test('clock adjustment during rest requires manual recovery', () => {
  const h = setup()
  let mono = 0
  const engine = new SessionEngine(
    h.repo,
    () => 0.5,
    () => mono
  )
  engine.start(p)
  h.repo.change((a) => {
    a.session.phase = 'resting'
    a.session.nextResumeAt = h.now() + 10000
  })
  h.advance(30000)
  mono += 1000
  assert.equal(engine.tick(false).phase, 'stopped')
})
