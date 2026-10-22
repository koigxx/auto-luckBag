import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium, Browser, Page } from 'playwright'
import { LotteryDom } from '../src/main/lottery-dom'
import { PassiveObserver } from '../src/main/passive-observer'
import { FudaiService, FudaiEnvironment, FudaiGrabResult } from '../src/main/fudai-service'
import { RuntimeRepository, emptyRuntime } from '../src/main/runtime-repository'
import { DEFAULT_POLICY, Opportunity } from '../src/shared/policy'
import { defaults } from '../src/shared/config'
import { checkSignal } from '../src/main/execution-gate'
import { parseLottery } from '../src/main/lottery-parser'

let browser: Browser
before(async () => {
  browser = await chromium.launch({ headless: true })
})
after(async () => {
  await browser?.close()
})
const url = 'https://live.douyin.com/12345678'
const css =
  '<style>.lottery-dialog{width:340px;height:250px;margin:60px;padding:10px;background:#eee}button{width:160px;height:36px}#ShortTouchLayout .ycjwPFJI{width:60px;height:30px}</style>'
async function page(html: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } })
  await context.route('**/*', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
  )
  const p = await context.newPage()
  await p.goto(url)
  return p
}
const run = async <T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> => {
  checkSignal(signal)
  return fn()
}
function opportunity(now: number, patch: Partial<Opportunity> = {}): Opportunity {
  return {
    lotteryId: 'b1',
    drawAt: now + 120000,
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
function harness(p: Page, patch: Partial<Opportunity> = {}) {
  let time = Date.now(),
    data = emptyRuntime()
  const controller = new AbortController(),
    repo = new RuntimeRepository(
      {
        read: () => data,
        write: (d) => {
          data = structuredClone(d)
        }
      },
      () => time
    )
  repo.bind('test', { spent: 0, stats: {}, rooms: [{ url, name: 'Fixture' }] })
  repo.updateRoom(url, { allowPaid: true })
  const policy = { ...DEFAULT_POLICY, membership: 'whitelist' as const }
  repo.change((a) => {
    a.session.phase = 'running'
    a.session.hardStopAt = time + 3600000
  })
  const results: FudaiGrabResult[] = [],
    risks: string[] = [],
    logs: string[] = []
  const env: FudaiEnvironment = {
    signal: controller.signal,
    now: () => time,
    repository: repo,
    getConfig: () => ({ ...defaults, policy }),
    policy: () => policy,
    assertActive: checkSignal,
    paymentReason: (_url, cost) => repo.canPay(url, cost, 10, false, policy),
    reportRisk: (r) => {
      risks.push(r)
      repo.risk(r, 'fixture')
      controller.abort()
    },
    canFinish: () => true,
    perform: run
  }
  const service = new FudaiService(
    p,
    url,
    {
      onUpdate: () => {},
      onResult: (r) => results.push(r),
      onLog: (m) => logs.push(m),
      mayContinue: () => null
    },
    env
  )
  const o = opportunity(time, patch)
  service.seed(o)
  service.observer.panelLotteryId = o.lotteryId
  return {
    service,
    repo,
    controller,
    o,
    env,
    results,
    risks,
    logs,
    now: () => time,
    advance: (ms: number) => {
      time += ms
    },
    finish: async () => {
      service.stopMonitoring()
      await p.context().close()
    }
  }
}

test('only visible ShortTouch entries inside viewport can be clicked', async () => {
  const p = await page(
    css +
      '<div id="ShortTouchLayout"><div class="ycjwPFJI" style="display:none">01:00</div><div class="ycjwPFJI" style="position:absolute;top:1200px">02:00</div></div><p>开奖倒计时 03:00</p>'
  )
  try {
    const dom = new LotteryDom(p, new AbortController().signal, run)
    assert.equal((await dom.entry()).visible, false)
    assert.equal(await dom.open(), false)
    await p
      .locator('.ycjwPFJI')
      .first()
      .evaluate((e) => ((e as HTMLElement).style.display = 'block'))
    assert.equal((await dom.entry()).seconds, 60)
  } finally {
    await p.context().close()
  }
})
test('header, gift stream and containing parent are not fan task buttons', async () => {
  const p = await page(
    css +
      '<button>+加粉丝团</button><div>送点亮粉丝团</div><div class="lottery-dialog"><h3>福袋参与条件</h3><div style="width:180px;height:35px">加入粉丝团(1钻石)</div></div>'
  )
  try {
    const dom = new LotteryDom(p, new AbortController().signal, run)
    assert.equal(await dom.action(/^加入粉丝团\(1钻石\)$/), false)
    await p.locator('.lottery-dialog').evaluate((e) => {
      const b = document.createElement('button')
      b.textContent = '加入粉丝团(1钻石)'
      e.append(b)
    })
    assert.equal(await dom.action(/^加入粉丝团\(1钻石\)$/), true)
  } finally {
    await p.context().close()
  }
})
test('chat congratulations are outside the result panel', async () => {
  const p = await page(
      css +
        '<div class="chat">恭喜您获得999钻石</div><div class="lottery-dialog"><h3>福袋</h3>已参与，等待开奖</div>'
    ),
    h = harness(p)
  try {
    await h.service.tick()
    await h.service.tick()
    assert.equal(h.repo.stats().participated, 1)
    assert.equal(h.repo.stats().diamondWonAmount, 0)
  } finally {
    await h.finish()
  }
})
test('click without confirmation is a submitted unknown, never a success', async () => {
  const p = await page(css + '<div class="lottery-dialog"><h3>福袋</h3><button>立即参与</button></div>'),
    h = harness(p)
  try {
    await h.service.tick()
    await h.service.tick()
    await h.service.tick()
    assert.equal(h.repo.stats().participated, 0)
    assert.equal(h.repo.stats().submittedUnknown, 1)
  } finally {
    await h.finish()
  }
})
test('late own win and amount completion update one participation', async () => {
  const p = await page(
      css +
        '<div class="lottery-dialog"><h3>福袋</h3><button onclick="this.textContent=\'已参与，等待开奖\'">立即参与</button></div>'
    ),
    h = harness(p)
  try {
    await h.service.tick()
    await h.service.tick()
    await h.service.tick()
    assert.equal(h.repo.stats().participated, 1)
    h.advance(120000)
    await p
      .locator('.lottery-dialog')
      .evaluate((e) => (e.innerHTML = '<h3>福袋开奖</h3>恭喜您已中奖，获得钻石'))
    await h.service.tick()
    assert.equal(h.repo.stats().diamondWins, 1)
    assert.equal(h.repo.stats().diamondWonAmount, 0)
    await p.locator('.lottery-dialog').evaluate((e) => (e.innerHTML = '<h3>福袋开奖</h3>恭喜您获得8钻石'))
    await h.service.tick()
    await h.service.tick()
    assert.equal(h.repo.stats().diamondWonAmount, 8)
    assert.equal(h.repo.stats().participated, 1)
  } finally {
    await h.finish()
  }
})
test('comment precedes paid fan task in the same modal; no extra entry click', async () => {
  const p = await page(
    css +
      `<script>window.calls=[]</script><div id="ShortTouchLayout"><div class="ycjwPFJI" onclick="window.calls.push('entry')">02:00</div></div><button onclick="window.calls.push('header')">+加粉丝团</button><div class="lottery-dialog"><h3>福袋参与条件</h3><button id="task" onclick="window.calls.push('comment');this.textContent='加入粉丝团(1钻石)';this.onclick=function(){window.calls.push('pay');this.textContent='立即参与';this.onclick=function(){window.calls.push('submit');this.textContent='已参与，等待开奖'}}">发送口令</button></div>`
  )
  const h = harness(p, {
    requiresComment: true,
    commentText: '测试口令',
    membership: 'needs-payment',
    cost: 1
  })
  try {
    await h.service.tick()
    await h.service.tick()
    h.service.observer.lastChatSuccess = h.now()
    await h.service.tick()
    assert.equal(h.repo.budget(10, false, h.env.policy()).reserved, 1)
    h.service.observer.lastFanSuccess = h.now()
    await h.service.tick()
    await h.service.tick()
    await h.service.tick()
    assert.deepEqual(await p.evaluate(() => (window as any).calls), ['comment', 'pay', 'submit'])
    assert.equal(h.repo.stats().participated, 1)
    assert.equal(h.repo.budget(10, false, h.env.policy()).spent, 1)
  } finally {
    await h.finish()
  }
})
test('stopping in payment confirmation preserves unresolved cost and prevents retry', async () => {
  const p = await page(
      css + '<div class="lottery-dialog"><h3>福袋</h3><button>加入粉丝团(1钻石)</button></div>'
    ),
    h = harness(p, { membership: 'needs-payment', cost: 1 })
  try {
    await h.service.tick()
    await h.service.tick()
    h.controller.abort()
    h.service.stopMonitoring()
    await h.service.tick()
    const payments = Object.values(h.repo.account().payments)
    assert.equal(payments.length, 1)
    assert.equal(payments[0].state, 'unresolved')
    assert.equal(h.repo.budget(10, false, h.env.policy()).reserved, 1)
  } finally {
    await h.finish()
  }
})
test('payment timeout blocks and never assumes a successful charge', async () => {
  const p = await page(
      css + '<div class="lottery-dialog"><h3>福袋</h3><button>加入粉丝团(1钻石)</button></div>'
    ),
    h = harness(p, { membership: 'needs-payment', cost: 1 })
  try {
    await h.service.tick()
    await h.service.tick()
    h.advance(13000)
    await h.service.tick()
    assert.equal(h.risks.length, 1)
    assert.equal(Object.values(h.repo.account().payments)[0].state, 'unresolved')
    assert.equal(h.repo.budget(10, false, h.env.policy()).spent, 0)
  } finally {
    await h.finish()
  }
})
test('two distinct rounds settle independently; next round does not re-pay', async () => {
  const p = await page(
      css +
        '<div class="lottery-dialog"><h3>福袋</h3><button onclick="this.textContent=\'已参与，等待开奖\'">立即参与</button></div>'
    ),
    h = harness(p)
  try {
    await h.service.tick()
    await h.service.tick()
    await h.service.tick()
    h.advance(146000)
    await h.service.tick()
    assert.equal(Object.values(h.repo.account().rounds)[0].result, 'unknown')
    const next = opportunity(h.now(), { lotteryId: 'b2' })
    h.service.seed(next)
    h.service.observer.panelLotteryId = next.lotteryId
    await p
      .locator('.lottery-dialog')
      .evaluate(
        (e) =>
          (e.innerHTML =
            '<h3>福袋</h3><button onclick="this.textContent=\'已参与，等待开奖\'">立即参与</button>')
      )
    await h.service.tick()
    await h.service.tick()
    await h.service.tick()
    assert.equal(h.repo.stats().participated, 2)
    assert.equal(Object.values(h.repo.account().payments).length, 0)
    assert.equal(h.service.doneReason, '')
  } finally {
    await h.finish()
  }
})
test('risk words in chat are ignored but a visible challenge blocks', async () => {
  const p = await page('<div class="chat">安全验证</div>'),
    controller = new AbortController(),
    risks: string[] = []
  const observer = new PassiveObserver(p, controller.signal, (r) => risks.push(r))
  try {
    await observer.checkPageRisk()
    assert.equal(risks.length, 0)
    await p.setContent('<div role="dialog" style="width:200px;height:100px">请完成安全验证</div>')
    await observer.checkPageRisk()
    assert.equal(risks.length, 1)
  } finally {
    observer.close()
    await p.context().close()
  }
})
test('passive observer installs before navigation and parses only successful business receipts', async () => {
  const context = await browser.newContext()
  let code = 1
  await context.route('**/*', (r) =>
    r.fulfill({
      status: 200,
      contentType: r.request().url().includes('/webcast/') ? 'application/json' : 'text/html',
      body: r.request().url().includes('/gift/')
        ? JSON.stringify({ status_code: code })
        : r.request().url().includes('/lottery/')
          ? JSON.stringify({
              status_code: 0,
              data: { lottery_info: { lottery_id_str: 'initial', count_down: 120, conditions: [] } }
            })
          : '<script>fetch("/webcast/lottery/right/")</script>'
    })
  )
  const p = await context.newPage(),
    controller = new AbortController(),
    observer = new PassiveObserver(p, controller.signal, () => {})
  try {
    await p.goto(url)
    await p.waitForTimeout(150)
    assert.equal(observer.latest?.lotteryId, 'initial')
    await p.evaluate(() => fetch('/webcast/gift/send/', { method: 'POST', body: 'gift_id=6937' }))
    await p.waitForTimeout(100)
    assert.equal(observer.lastFanSuccess, 0)
    assert.ok(observer.lastFanFailure > 0)
    code = 0
    await p.evaluate(() => fetch('/webcast/gift/send/', { method: 'POST', body: 'gift_id=6937' }))
    await p.waitForTimeout(100)
    assert.ok(observer.lastFanSuccess > 0)
    observer.close()
    assert.equal((p as any).listenerCount('response'), 0)
    assert.equal((p as any).listenerCount('websocket'), 0)
  } finally {
    observer.close()
    await context.close()
  }
})
test('late older lottery never overwrites a newer round', async () => {
  const p = await page(''),
    controller = new AbortController(),
    observer = new PassiveObserver(p, controller.signal, () => {}),
    now = Date.now()
  try {
    observer.accept(opportunity(now, { lotteryId: 'new', drawAt: now + 300000 }))
    observer.accept(opportunity(now + 1, { lotteryId: 'old', drawAt: now + 120000 }))
    assert.equal(observer.latest?.lotteryId, 'new')
  } finally {
    observer.close()
    await p.context().close()
  }
})
test('a new lottery response cannot reuse the previous result modal', async () => {
  const p = await page(css + '<div class="lottery-dialog"><h3>福袋</h3>已参与，等待开奖</div>'),
    h = harness(p)
  try {
    await h.service.tick()
    await h.service.tick()
    h.advance(146000)
    await h.service.tick()
    h.service.seed(opportunity(h.now(), { lotteryId: 'b2' }))
    // Only the background observation changes; the open modal still belongs to b1.
    await h.service.tick()
    await h.service.tick()
    assert.equal(h.repo.stats().participated, 1)
    assert.equal(Object.values(h.repo.account().rounds).length, 1)
  } finally {
    await h.finish()
  }
})
test('a changed lottery aborts incomplete tasks before a paid button can be clicked', async () => {
  const p = await page(
      css +
        '<script>window.paid=0</script><div class="lottery-dialog"><h3>福袋</h3><button onclick="window.paid++">加入粉丝团(1钻石)</button></div>'
    ),
    h = harness(p, { membership: 'needs-payment', cost: 1 })
  try {
    await h.service.tick()
    h.service.seed(opportunity(h.now(), { lotteryId: 'b2', drawAt: h.now() + 200000 }))
    await h.service.tick()
    assert.equal(await p.evaluate(() => (window as any).paid), 0)
    assert.match(h.service.doneReason, /身份已变化/)
  } finally {
    await h.finish()
  }
})
test('watch progress cannot shorten the originally required remaining watch time', async () => {
  const p = await page(
      css +
        '<script>window.submitted=0</script><div class="lottery-dialog"><h3>福袋</h3><button onclick="window.submitted++">立即参与</button></div>'
    ),
    h = harness(p, { watchSeconds: 60 })
  try {
    await h.service.tick()
    h.advance(30000)
    h.service.seed({ ...h.o, observedAt: h.now(), watchSeconds: 30 })
    await h.service.tick()
    assert.equal(await p.evaluate(() => (window as any).submitted), 0)
    h.advance(30000)
    await h.service.tick()
    assert.equal(await p.evaluate(() => (window as any).submitted), 1)
  } finally {
    await h.finish()
  }
})

async function eventually(check: () => boolean): Promise<void> {
  const until = Date.now() + 2000
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(check(), 'fixture response was not observed in time')
}

test('manual/free participation button submits once at zero budget and waits for actual confirmation', async () => {
  for (const label of ['手动参与', '免费参与']) {
    const p = await page(
        css +
          `<script>window.calls=0</script><div class="lottery-dialog"><h3>福袋</h3><button onclick="window.calls++;this.textContent='已参与，等待开奖'">${label}</button></div>`
      ),
      h = harness(p, { lotteryId: 'free-submit' })
    h.env.paymentReason = (_url, cost) => h.repo.canPay(url, cost, 0, false, h.env.policy())
    const o = parseLottery(
      JSON.stringify({
        data: {
          lottery_info: {
            lottery_id_str: 'free-submit',
            count_down: 64,
            conditions: [{ description: '手动参与', status: 0 }]
          }
        }
      }),
      h.now()
    )!
    h.service.seed(o)
    h.service.observer.panelLotteryId = o.lotteryId
    try {
      await h.service.tick()
      assert.equal(h.repo.stats().participated, 0)
      await h.service.tick()
      await h.service.tick()
      await h.service.tick()
      assert.equal(await p.evaluate(() => (window as any).calls), 1)
      assert.equal(h.repo.stats().participated, 1)
      assert.equal(Object.values(h.repo.account().payments).length, 0)
    } finally {
      await h.finish()
    }
  }
})

test('normal comment then fan-club payment then participation works through passive fixture responses', async () => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } })
  let commented = false,
    paid = false,
    actualComment = ''
  const payload = () => ({
    status_code: 0,
    data: {
      lottery_info: {
        lottery_id_str: 'full-flow',
        count_down: 180,
        conditions: [
          { description: '手动参与', status: 0 },
          { type: 3, description: '发送口令', content: '测试口令', status: commented ? 1 : 0 },
          { type: 1, description: '关注主播', status: paid ? 1 : 0 },
          { type: 8, description: '加入粉丝团(1钻石)', status: paid ? 1 : 0 }
        ]
      },
      user_condition: { has_command: commented, has_follow: paid, is_fansclub_member: paid }
    }
  })
  const html =
    css +
    `<script>window.calls=[];window.step=0;async function task(b){
    if(window.step===0){window.calls.push('comment');await fetch('/webcast/room/chat/',{method:'POST',body:new URLSearchParams({content:'测试口令'})});b.textContent='加入粉丝团(1钻石)';window.step=1}
    else if(window.step===1){window.calls.push('pay');await fetch('/webcast/gift/send/',{method:'POST',body:'gift_id=6937'});b.textContent='免费参与';window.step=2}
    else {window.calls.push('submit');b.textContent='已参与，等待开奖';window.step=3;return}
    await fetch('/webcast/lottery/right/')
  }</script><button onclick="window.calls.push('header')">+加粉丝团</button><div id="ShortTouchLayout"><div class="ycjwPFJI" onclick="window.calls.push('entry')">03:00</div></div><div class="lottery-dialog"><h3>福袋参与条件</h3><button onclick="task(this)">一键评论参与</button></div>`
  await context.route('**/*', async (route) => {
    const request = route.request(),
      pathname = new URL(request.url()).pathname
    if (pathname === '/webcast/room/chat/') {
      commented = true
      actualComment = new URLSearchParams(request.postData() || '').get('content') || ''
    }
    if (pathname === '/webcast/gift/send/') paid = true
    await route.fulfill({
      status: 200,
      contentType: pathname.startsWith('/webcast/') ? 'application/json' : 'text/html; charset=utf-8',
      body:
        pathname === '/webcast/lottery/right/'
          ? JSON.stringify(payload())
          : pathname.startsWith('/webcast/')
            ? '{"status_code":0}'
            : html
    })
  })
  const p = await context.newPage()
  await p.goto(url)
  const h = harness(p)
  try {
    await p.evaluate(() => fetch('/webcast/lottery/right/'))
    await eventually(() => h.service.observer.latest?.lotteryId === 'full-flow')
    await h.service.tick()
    await h.service.tick()
    await eventually(
      () => h.service.observer.latest?.requiresComment === false && h.service.observer.lastChatSuccess > 0
    )
    assert.equal(actualComment, '测试口令')
    assert.equal(h.repo.stats().participated, 0)
    await h.service.tick()
    await eventually(
      () => h.service.observer.lastFanSuccess > 0 && h.service.observer.latest?.membership === 'satisfied'
    )
    await h.service.tick()
    await h.service.tick()
    await h.service.tick()
    await h.service.tick()
    assert.deepEqual(await p.evaluate(() => (window as any).calls), ['comment', 'pay', 'submit'])
    assert.equal(h.repo.stats().participated, 1)
    assert.equal(h.repo.budget(10, false, h.env.policy()).spent, 1)
    assert.equal(Object.values(h.repo.account().payments).length, 1)
    assert.equal(h.service.doneReason, '')
  } finally {
    await h.finish()
  }
})

test('standalone follow updates eligibility before submitting, without repeating the follow', async () => {
  const p = await page(
      css +
        `<script>window.calls=[]</script><button onclick="window.calls.push('outside')">关注</button><div class="lottery-dialog"><h3>福袋参与条件</h3><button onclick="window.calls.push('follow');this.textContent='免费参与';this.onclick=function(){window.calls.push('submit');this.textContent='已参与，等待开奖'}">关注</button></div>`
    ),
    h = harness(p, { requiresFollow: true })
  try {
    await h.service.tick()
    await h.service.tick()
    await h.service.tick()
    assert.deepEqual(await p.evaluate(() => (window as any).calls), ['follow'])
    h.service.seed({ ...h.o, observedAt: h.now() + 1, requiresFollow: false })
    await h.service.tick()
    await h.service.tick()
    await h.service.tick()
    assert.deepEqual(await p.evaluate(() => (window as any).calls), ['follow', 'submit'])
    assert.equal(h.repo.stats().participated, 1)
  } finally {
    await h.finish()
  }
})

test('share tasks, unknown commands and exhausted payment budget never click task buttons', async () => {
  for (const patch of [
    { requiresShare: true },
    { requiresComment: true, commentText: '' },
    { membership: 'needs-payment' as const, cost: 1 }
  ]) {
    const p = await page(
        css +
          `<script>window.calls=0</script><div class="lottery-dialog"><h3>福袋参与条件</h3><button onclick="window.calls++">免费参与</button><button onclick="window.calls++">加入粉丝团(1钻石)</button><button onclick="window.calls++">发送口令</button></div>`
      ),
      h = harness(p, patch)
    h.env.paymentReason = (_url, cost) => h.repo.canPay(url, cost, 0, false, h.env.policy())
    try {
      await h.service.tick()
      await h.service.tick()
      assert.equal(await p.evaluate(() => (window as any).calls), 0)
      assert.equal(h.repo.stats().participated, 0)
      assert.equal(Object.values(h.repo.account().payments).length, 0)
    } finally {
      await h.finish()
    }
  }
})
