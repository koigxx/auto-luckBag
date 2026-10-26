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
import { visiblePageRisk } from '../src/main/page-risk'
import { ManualReviewBrowser } from '../src/main/manual-review-browser'

let browser: Browser
before(async () => {
  browser = await chromium.launch({ headless: true })
})
after(async () => {
  await browser?.close()
})
const url = 'https://live.douyin.com/12345678'
test('visible slider and phone challenges block, hidden templates and ordinary chat do not',async()=>{
  const p=await page('<div id="captcha_container" style="width:400px;height:300px">请完成下列验证后继续</div>')
  try {
    assert.match(await visiblePageRisk(p),/请完成下列验证/)
    await p.locator('#captcha_container').evaluate(el=>el.textContent='请填写手机验证码')
    assert.match(await visiblePageRisk(p),/手机验证码/)
    await p.locator('#captcha_container').evaluate(el=>el.style.display='none')
    await p.evaluate(()=>{const div=document.createElement('div');div.textContent='聊天提到手机验证码';document.body.append(div)})
    assert.equal(await visiblePageRisk(p),'')
  }finally{await p.context().close()}
})

test('challenge appearing during a click is escalated instead of retried as an ordinary error',async()=>{
  const p=await page(css+'<div class="lottery-dialog">福袋参与条件<button>一键评论</button></div>')
  const h=harness(p,{requiresComment:true,commentText:'fixture'})
  try{
    await h.service.tick()
    ;(h.service as any).dom.comment=async()=>{
      await p.evaluate(()=>{const d=document.createElement('div');d.id='captcha_container';d.style.cssText='width:400px;height:300px';d.textContent='请完成下列验证后继续';document.body.append(d)})
      throw new Error('elementHandle.click: captcha_container intercepts pointer events')
    }
    await h.service.tick()
    assert.equal(h.repo.account().session.phase,'blocked')
    assert.equal(h.controller.signal.aborted,true)
    assert.equal(h.risks.length,1)
    assert.ok(!h.logs.some(m=>m.includes('elementHandle.click')))
  }finally{await h.finish()}
})

test('visible iframe phone verification is detected but hidden iframe templates are ignored',async()=>{
  const p=await page('<iframe style="width:500px;height:400px" srcdoc="<div role=dialog style=width:300px;height:200px>短信验证码</div>"></iframe>')
  try {
    await p.frameLocator('iframe').locator('[role=dialog]').waitFor()
    assert.match(await visiblePageRisk(p),/短信验证码/)
    await p.locator('iframe').evaluate(el=>el.style.display='none')
    assert.equal(await visiblePageRisk(p),'')
  }finally{await p.context().close()}
})

test('manual review reuses the task context, never enters values, and checks visible challenges',async()=>{
  const p=await page('<div role="dialog" style="width:400px;height:300px">手机验证码<input id="code"></div>')
  const review=new ManualReviewBrowser(async()=>p.context())
  try{
    await p.context().addCookies([{name:'fixture',value:'same-session',url}])
    await Promise.all([review.openManualReview(url,'a'),review.openManualReview(url,'a')])
    assert.equal(p.context().pages().length,2)
    await review.openManualReview(url,'a')
    assert.equal(p.context().pages().length,2)
    const manual=p.context().pages()[1]
    assert.equal(await manual.locator('#code').inputValue(),'')
    assert.equal((await manual.context().cookies()).find(c=>c.name==='fixture')?.value,'same-session')
    await assert.rejects(review.checkManualReview('a'),/仍显示/)
    await assert.rejects(review.checkManualReview('b'),/保持处理页面打开/)
    await manual.locator('[role=dialog]').evaluate(el=>el.remove())
    await review.checkManualReview('a')
    await review.closeManualReview()
    await assert.rejects(review.checkManualReview('a'),/先前往/)
      await assert.rejects(review.checkManualReview('a',url),/处理页面已重新打开/)
      assert.equal(p.context().pages().length,2)
      await assert.rejects(review.checkManualReview('a',url),/仍显示/)
      assert.equal(p.context().pages().length,2,'checking an existing challenge must not create more pages')
      await p.context().pages()[1].close()
      await assert.rejects(review.checkManualReview('a',url),/处理页面已重新打开/)
      await assert.rejects(review.checkManualReview('b',url),/账号已变化/)
    assert.equal(p.isClosed(),false)
  }finally{await p.context().close()}
})
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
function harness(p: Page, patch: Partial<Opportunity> = {}, mayContinue:(o:Opportunity)=>string|null = () => null) {
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
    getConfig: () => ({ ...defaults, policy, enterBeforeSeconds: 600 }),
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
      mayContinue
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

test('delayed rights response binds the same lottery without replacing newer task data', async () => {
  const p = await page(css + '<div class="lottery-dialog">福袋开奖<button onclick="this.textContent=\'已参与，等待开奖\'">立即参与</button></div>')
  const h = harness(p)
  const deliver = async (endpoint: string, start: number, id: string, conditions: any[]) => {
    await (h.service.observer as any).readResponse({
      url: () => `https://live.douyin.com/webcast/lottery/${endpoint}/`,
      status: () => 200,
      ok: () => true,
      text: async () => JSON.stringify({ status_code: 0, data: { lottery_info: {
        lottery_id_str: id, count_down: 192, conditions
      } } }),
      request: () => ({ timing: () => ({ startTime: start }) })
    })
  }
  try {
    h.service.observer.panelLotteryId = null
    await deliver('info', 200, 'same', [])
    await deliver('right', 100, 'same', [{ type: 3, description: '评论：旧口令', status: 0 }])
    assert.equal(h.service.observer.panelLotteryId, 'same')
    assert.equal(h.service.observer.latest?.requiresComment, false)
    await h.service.tick()
    assert.equal(Object.keys(h.repo.account().rounds).length, 1)
    await h.service.tick()
    await h.service.tick()
    assert.equal(h.repo.stats().participated, 1)
    // A newer rights request for a different round invalidates association; a late
    // older rights response must not restore it just because its body arrived last.
    await deliver('right', 300, 'other', [])
    await deliver('right', 150, 'same', [])
    assert.equal(h.service.observer.panelLotteryId, 'other')
    assert.notEqual(h.service.observer.panelLotteryId, 'same')
    await deliver('right', 400, '', [])
    assert.equal(h.service.observer.panelLotteryId, null)
  } finally {
    await h.finish()
  }
})

test('takeover with missing panel identity times out explicitly without performing tasks', async () => {
  const p = await page(css + '<div class="lottery-dialog">福袋开奖<button onclick="window.taskClicks++">立即参与</button></div><script>window.taskClicks=0</script>')
  const h = harness(p, { drawAt: Date.now() + 192000 })
  try {
    h.service.observer.panelLotteryId = null
    await h.service.tick()
    h.advance(61000)
    await h.service.tick()
    assert.match(h.service.doneReason, /未获得匹配的弹窗身份响应/)
    assert.match(h.service.doneReason, /弹窗未关闭/)
    assert.match(h.service.doneReason, /未记录到福袋请求响应/)
    assert.equal(Object.keys(h.repo.account().rounds).length, 0)
    assert.equal(await p.evaluate(() => (window as any).taskClicks), 0)
    assert.equal(h.repo.account().decisions.at(-1)?.reason, h.service.doneReason)
  } finally {
    await h.finish()
  }
})

test('unavailable response timing still accepts valid rights, with redacted diagnostics', async () => {
  const p = await page(css)
  const observer = new PassiveObserver(p, new AbortController().signal, () => {})
  try {
    await (observer as any).readResponse({
      url: () => 'https://live.douyin.com/webcast/lottery/right/?secret=DO_NOT_LOG',
      status: () => 200, ok: () => true,
      text: async () => JSON.stringify({ status_code: 0, data: { lottery_info: {
        lottery_id_str: 'valid', count_down: 180, conditions: []
      } } }),
      request: () => ({ timing: () => ({ startTime: -1 }), postData: () => '' })
    })
    assert.equal(observer.panelLotteryId, 'valid')
    assert.match(observer.identityDiagnostics(), /身份已确认/)
    assert.doesNotMatch(observer.identityDiagnostics(), /secret|DO_NOT_LOG/)
  } finally { observer.close(); await p.context().close() }
})

test('rights body failure is observable and newer pending response rejects stale identity', async () => {
  const p = await page(css)
  const observer = new PassiveObserver(p, new AbortController().signal, () => {})
  const response = (start: number, text: () => Promise<string>) => ({
    url: () => 'https://live.douyin.com/webcast/lottery/right/',
    status: () => 200, ok: () => true, text,
    request: () => ({ timing: () => ({ startTime: start }), postData: () => '' })
  })
  let rejectBody!: (e: Error) => void
  try {
    const newer = (observer as any).readResponse(response(200, () => new Promise((_resolve, reject) => { rejectBody = reject })))
    assert.match(observer.panelIdentityReason, /正在读取/)
    await (observer as any).readResponse(response(100, async () => JSON.stringify({ status_code: 0,
      data: { lottery_info: { lottery_id_str: 'old', count_down: 180 } } })))
    assert.equal(observer.panelLotteryId, null)
    rejectBody(new Error('PRIVATE_ERROR_TEXT'))
    await newer
    assert.equal(observer.panelIdentityReason, '响应内容读取失败')
    assert.doesNotMatch(observer.identityDiagnostics(), /PRIVATE_ERROR_TEXT/)
  } finally { observer.close(); await p.context().close() }
})

test('ordinary lottery data is recorded for diagnosis without granting panel identity', async () => {
  const p = await page(css)
  const observer = new PassiveObserver(p, new AbortController().signal, () => {})
  try {
    for (const path of ['/webcast/lottery/info/', '/other/lottery/right/']) {
      await (observer as any).readResponse({
        url: () => `https://live.douyin.com${path}?token=DO_NOT_LOG`,
        status: () => 200, ok: () => true,
        text: async () => JSON.stringify({ status_code: 0, data: { lottery_info: {
          lottery_id_str: 'data-only', count_down: 180, conditions: []
        } } }),
        request: () => ({ timing: () => ({ startTime: 100 }) })
      })
    }
    assert.equal(observer.latest?.lotteryId, 'data-only')
    assert.equal(observer.panelLotteryId, null)
    assert.match(observer.identityDiagnostics(), /非已支持的弹窗身份接口/)
    assert.match(observer.identityDiagnostics(), /路径不在已支持范围内/)
    assert.doesNotMatch(observer.identityDiagnostics(), /token|DO_NOT_LOG/)
  } finally { observer.close(); await p.context().close() }
})

test('failed natural rights request is recorded and listener is removed on close', async () => {
  const p = await page(css)
  const observer = new PassiveObserver(p, new AbortController().signal, () => {})
  try {
    await p.route('**/webcast/lottery/right/**', r => r.abort())
    await p.evaluate(() => fetch('/webcast/lottery/right/?secret=DO_NOT_LOG').catch(() => {}))
    await eventually(() => observer.identityDiagnostics().includes('请求失败'))
    assert.equal(observer.panelLotteryId, null)
    assert.doesNotMatch(observer.identityDiagnostics(), /DO_NOT_LOG/)
    observer.close()
    assert.equal((p as any).listenerCount('requestfailed'), 0)
  } finally { observer.close(); await p.context().close() }
})

test('existing ShortTouch lottery landing with opaque classes is reused without clicking covered entry', async () => {
  const p = await page(css + `
    <div id="ShortTouchLayout"><div class="ycjwPFJI" onclick="window.entryClicks++">02:00</div></div>
    <div id="short_touch_land_lottery_land_userMain" class="opaque" style="position:absolute;top:0;left:0;width:340px;height:250px;background:white">
      <div id="lottery_close_cotainer" class="ppvsVCXU">福袋开奖：发送口令参与</div>
      <button onclick="window.taskClicks++">一键发表评论</button>
    </div><script>window.entryClicks=0;window.taskClicks=0</script>`)
  try {
    const dom = new LotteryDom(p, new AbortController().signal, run)
    assert.match(await dom.panelText(), /发送口令参与/)
    assert.equal(await dom.open(), true)
    assert.equal(await dom.action(/一键发表评论/), true)
    assert.deepEqual(await p.evaluate(() => [(window as any).entryClicks, (window as any).taskClicks]), [0, 1])
    await p.locator('#short_touch_land_lottery_land_userMain').evaluate(el => { el.style.display = 'none' })
    assert.equal(await dom.panelText(), '')
  } finally { await p.context().close() }
})

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

test('follow prerequisite unlocks one-click comment in the same panel without reopening or duplicates',async()=>{
  const p=await page(css+`<script>window.calls=[];
    function followTask(){window.calls.push('follow');document.getElementById('follow-state').textContent='关注主播 已达成';
      const b=document.querySelector('.lottery-dialog button');b.textContent='一键评论';b.onclick=()=>{window.calls.push('comment');b.parentElement.textContent='已参与，等待开奖'}}
    </script><button onclick="window.calls.push('outside')">关注</button>
    <div class="lottery-dialog">福袋参与条件<p id="follow-state">关注主播 未达成</p><p>发送评论：测试口令 未达成</p><button onclick="followTask()">去关注</button></div>`)
  const h=harness(p,{requiresFollow:true,requiresComment:true,commentText:'测试口令'})
  try {
    for(let i=0;i<6;i++)await h.service.tick()
    assert.deepEqual(await p.evaluate(()=>(window as any).calls),['follow','comment'])
    assert.equal(h.repo.stats().participated,1)
    assert.equal(h.service.doneReason,'')
    assert.ok(h.repo.account().rounds[h.repo.roundKey(url,h.o.lotteryId)].actions?.follow)
  }finally{await h.finish()}
})

test('unconfirmed prerequisite follow blocks comment even if its button appears and never repeats',async()=>{
  const p=await page(css+`<script>window.calls=[]</script><div class="lottery-dialog">福袋参与条件
    <p>关注主播 未达成</p><p>发送评论：测试口令 未达成</p>
    <button onclick="window.calls.push('follow');this.textContent='一键评论';this.onclick=()=>window.calls.push('comment')">去关注</button></div>`)
  const h=harness(p,{requiresFollow:true,requiresComment:true,commentText:'测试口令'})
  try {
    await h.service.tick();await h.service.tick();await h.service.tick()
    h.advance(10000);await h.service.tick()
    assert.deepEqual(await p.evaluate(()=>(window as any).calls),['follow'])
    assert.match(h.service.doneReason,/关注状态未确认/)
    assert.equal(h.repo.stats().participated,0)
  }finally{await h.finish()}
})

test('named physical result and late quantity are saved once from the bound result panel',async()=>{
  const p=await page(css+'<div class="lottery-dialog">福袋 已参与，等待开奖</div>'),h=harness(p)
  try {
    await h.service.tick();await h.service.tick();h.advance(120000)
    await p.locator('.lottery-dialog').evaluate(el=>{
      el.id='short_touch_land_lottery_land_result';el.textContent='恭喜中奖！\n奖品：蓝牙耳机\n请填写收货地址'
    })
    await h.service.tick()
    assert.equal(h.repo.stats().physicalWins,1)
    await p.locator('.lottery-dialog').evaluate(el=>el.textContent='恭喜中奖！\n奖品：蓝牙耳机 × 2副\n请填写收货地址')
    await h.service.tick();await h.service.tick()
    const r=h.repo.account().rounds[h.repo.roundKey(url,h.o.lotteryId)]
    assert.equal(r.prizeName,'蓝牙耳机');assert.equal(r.prizeQuantity,2);assert.equal(r.prizeUnit,'副')
    assert.equal(h.repo.stats().physicalWins,1);assert.equal(h.repo.stats().diamondWonAmount,0)
    assert.equal(h.results.filter(r=>r.won).length,2,'a later quantity must publish, repeated reads must not')
  }finally{await h.finish()}
})

test('one-click comment auto-enrols and separate result root without lottery heading records own outcome', async () => {
  for (const outcome of ['很遗憾，本次未中奖', '恭喜您获得8钻']) {
    const p = await page(css + `<div id="short_touch_land_lottery_land_userMain" class="lottery-dialog">
      福袋参与条件<button onclick="this.parentElement.innerHTML='已参与，等待开奖'">一键评论</button></div>`)
    const h = harness(p, {requiresComment:true, commentText:'测试口令'})
    try {
      await h.service.tick()
      await h.service.tick()
      await h.service.tick()
      assert.equal(h.repo.stats().participated, 1)
      assert.ok(h.repo.account().rounds[h.repo.roundKey(url,h.o.lotteryId)].submittedAt)
      h.advance(120000)
      // The next info arrives first, but user-rights still binds the old popup.
      h.service.seed(opportunity(h.now(), {lotteryId:'next'}))
      await p.locator('.lottery-dialog').evaluate((el,text) => {
        el.id='short_touch_land_lottery_land_result'; el.innerHTML=`<div>${text}</div>`
      }, outcome)
      await h.service.tick()
      await h.service.tick()
      const record=h.repo.account().rounds[h.repo.roundKey(url,h.o.lotteryId)]
      assert.equal(record.result, outcome.startsWith('恭喜')?'won':'lost')
      assert.equal(record.diamondAmount, outcome.startsWith('恭喜')?8:null)
      assert.equal(h.repo.stats().participated,1)
      assert.equal(Object.keys(h.repo.account().rounds).length,1)
      assert.ok(h.logs.some(m=>m.includes('已记录')))
    } finally { await h.finish() }
  }
})

test('result with mismatched identity never credits a prior round; explicit matching result can settle after newer rights', async () => {
  const p=await page(css+'<div class="lottery-dialog">福袋 已参与，等待开奖</div>'),h=harness(p)
  try {
    await h.service.tick(); await h.service.tick(); h.advance(120000)
    h.service.seed(opportunity(h.now(),{lotteryId:'new'})); h.service.observer.panelLotteryId='new'
    await p.locator('.lottery-dialog').evaluate(el=>{
      el.id='short_touch_land_lottery_land_result';el.setAttribute('data-lottery-id','new');el.textContent='恭喜您获得8钻石'
    })
    await h.service.tick(); assert.equal(h.repo.stats().diamondWins,0)
    await p.locator('.lottery-dialog').evaluate(el=>el.removeAttribute('data-lottery-id'))
    await h.service.tick(); assert.equal(h.repo.stats().diamondWins,0)
    await p.locator('.lottery-dialog').evaluate(el=>el.setAttribute('data-lottery-id','b1'))
    await h.service.tick(); assert.equal(h.repo.stats().diamondWonAmount,8)
  } finally { await h.finish() }
})

test('unknown full-screen result overlay blocks entry clicks instead of timing out behind it',async()=>{
  const p=await page(css+`<script>window.entry=0</script><div id="ShortTouchLayout"><div class="ycjwPFJI" onclick="window.entry++">01:00</div></div>
    <div id="short_touch_land_lottery_land_result" style="position:fixed;inset:0;background:white">正在处理</div>`)
  const dom=new LotteryDom(p,new AbortController().signal,run)
  try {
    assert.equal(await dom.open(),false)
    assert.equal(await dom.reopen(),false)
    assert.equal(await p.evaluate(()=>(window as any).entry),0)
    assert.match(dom.lastOpenResult,/弹层仍存在/)
  }finally{await p.context().close()}
})

test('observed loss wording settles the bound result and its acknowledge button closes only that result',async()=>{
  const p=await page(css+`<script>window.outside=0;window.opened=0</script>
    <button onclick="window.outside++">知道了</button>
    <div id="ShortTouchLayout"><div class="ycjwPFJI" onclick="window.opened++">01:00</div></div>
    <div class="lottery-dialog">福袋 已参与，等待开奖</div>`),h=harness(p)
  try{
    await h.service.tick();await h.service.tick();h.advance(120000)
    await p.locator('.lottery-dialog').evaluate(el=>{
      el.id='short_touch_land_lottery_land_result'
      el.innerHTML='没抽中福袋<br>送你一个好运气~<br>查看幸运观众<button onclick="this.parentElement.remove()">知道了</button>'
    })
    await h.service.tick()
    assert.equal(h.repo.account().rounds[h.repo.roundKey(url,h.o.lotteryId)].result,'lost')
    const dom=new LotteryDom(p,new AbortController().signal,run)
    assert.equal(await dom.reopen(),true)
    assert.deepEqual(await p.evaluate(()=>[(window as any).outside,(window as any).opened]),[0,1])
  }finally{await h.finish()}
})

test('missing panel after a comment attempt times out with a reason and never replays the comment',async()=>{
  const p=await page(css+`<script>window.comments=0</script><div class="lottery-dialog">福袋参与条件
    <button onclick="window.comments++;this.parentElement.remove()">一键评论</button></div>`)
  const h=harness(p,{requiresComment:true,commentText:'测试'})
  try {
    await h.service.tick(); await h.service.tick(); await h.service.tick()
    h.advance(11000); await h.service.tick()
    assert.match(h.service.doneReason,/弹窗消失/)
    assert.equal(h.logs.filter(m=>m.includes('本轮弹窗读取诊断')).length,1)
    assert.ok(h.logs.some(m=>m.includes('"roots":[]')))
    assert.equal(h.repo.stats().participated,0)
    assert.equal(await p.evaluate(()=>(window as any).comments),1)
  }finally{await h.finish()}
})
test('closed comment modal reopens once for confirmation only and never executes returned tasks', async () => {
  for (const outcome of ['已参与，等待开奖', '福袋参与条件', 'other-round']) {
    const p=await page(css+`<script>window.comments=0;window.opens=0;window.paid=0</script>
      <div id="ShortTouchLayout"><div class="ycjwPFJI" onclick="window.opens++;const d=document.createElement('div');d.className='lottery-dialog';d.innerHTML=window.returned;document.body.appendChild(d)">01:40</div></div>
      <div class="lottery-dialog">福袋参与条件<button onclick="window.comments++;this.parentElement.remove()">一键评论</button></div>`)
    const h=harness(p,{requiresComment:true,commentText:'测试'})
    try {
      await p.evaluate(outcome=>{(window as any).returned=outcome==='other-round'
        ? '<div data-lottery-id="other">已参与，等待开奖</div>'
        : outcome+'<button onclick="window.comments++">一键评论</button><button onclick="window.paid++">加入粉丝团(1钻)</button>'},outcome)
      await h.service.tick();await h.service.tick();await h.service.tick()
      h.advance(1999);await h.service.tick()
      assert.equal(await p.evaluate(()=>(window as any).opens),0,'wait for stable closure')
      h.advance(1);await h.service.tick();await h.service.tick()
      assert.equal(h.repo.stats().participated,outcome==='已参与，等待开奖'?1:0)
      h.advance(11000);await h.service.tick();await h.service.tick()
      assert.deepEqual(await p.evaluate(()=>[(window as any).comments,(window as any).opens,(window as any).paid]),[1,1,0])
      if(outcome!=='已参与，等待开奖')assert.match(h.service.doneReason,/未确认本人参与/)
    }finally{await h.finish()}
  }
})

test('fast read-only confirmation does not reopen an unreadable visible panel, changed round or stopped run',async()=>{
  for(const scenario of ['unreadable','changed','stopped']){
    const p=await page(css+`<script>window.opens=0;window.comments=0</script><div id="ShortTouchLayout"><div class="ycjwPFJI" onclick="window.opens++">01:00</div></div><div class="lottery-dialog">福袋参与条件<button onclick="window.comments++;this.parentElement.remove()">一键评论</button></div>`)
    const h=harness(p,{requiresComment:true,commentText:'测试'})
    try{
      await h.service.tick();await h.service.tick();await h.service.tick()
      if(scenario==='unreadable')await p.evaluate(()=>{const d=document.createElement('div');d.className='lottery-dialog';d.textContent='加载中';document.body.appendChild(d)})
      if(scenario==='changed')h.service.observer.accept({...h.o,lotteryId:'other'})
      if(scenario==='stopped'){h.controller.abort();h.service.stopMonitoring()}
      h.advance(2500);await h.service.tick()
      assert.equal(await p.evaluate(()=>(window as any).opens),0,scenario)
      assert.equal(await p.evaluate(()=>(window as any).comments),1,scenario)
      assert.equal(h.repo.stats().participated,0,scenario)
    }finally{await h.finish()}
  }
})

test('stage timing distinguishes waiting, unbounded tasks, confirmed entry and bounded next-round observation',async()=>{
  const p=await page(css+'<div class="lottery-dialog">福袋参与条件<button>一键评论</button></div>')
  const h=harness(p,{requiresComment:true,commentText:'测试'})
  h.env.getConfig=()=>({...defaults,enterBeforeSeconds:45})
  try{
    await h.service.tick()
    let t=h.service.getTimeline()!
    assert.equal(t.stage,'prepare');assert.equal(t.taskAt,h.o.drawAt!-45000);assert.equal(t.remainingSeconds,75)
    h.advance(75000);await h.service.tick();t=h.service.getTimeline()!
    assert.equal(t.stage,'prepare');assert.equal(t.endsAt,null,'task duration has no invented percentage')
    await p.evaluate(()=>{document.querySelector('.lottery-dialog')!.innerHTML='福袋 已参与，等待开奖'})
    await h.service.tick();assert.equal(h.service.getTimeline()!.stage,'draw')
    h.advance(45000)
    await p.evaluate(()=>{document.querySelector('.lottery-dialog')!.innerHTML='福袋 很遗憾，未中奖'})
    await h.service.tick()
    assert.equal(h.service.getTimeline()!.stage,'next','clear own loss does not wait another 25 seconds')
    ;(h.service as any).callbacks.nextReservationAt=()=>h.now()+12000
    assert.equal(h.service.getTimeline()!.remainingSeconds,7,'observation leaves five seconds for handoff')
  }finally{await h.finish()}
})

test('unknown draw stays unknown when result observation yields to a reservation',async()=>{
  const p=await page(css+'<div class="lottery-dialog">福袋 已参与，等待开奖</div>'),h=harness(p)
  try{
    await h.service.tick();await h.service.tick();h.advance(120000)
    ;(h.service as any).callbacks.nextReservationAt=()=>h.now()+4000
    ;(h.service as any).callbacks.mayWaitForNext=()=> '已有预约到时，预留切换时间'
    await h.service.tick()
    assert.match(h.service.doneReason,/已有预约/)
    assert.equal(Object.values(h.repo.account().rounds)[0].result,'unknown')
  }finally{await h.finish()}
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
    h.service.seed({ ...h.o, observedAt: h.now() + 1, requiresComment: false, membership: 'satisfied', cost: 0 })
    await h.service.tick()
    await h.service.tick()
    assert.deepEqual(await p.evaluate(() => (window as any).calls), ['comment', 'pay', 'submit'])
    assert.equal(h.repo.stats().participated, 1)
    assert.equal(h.repo.budget(10, false, h.env.policy()).spent, 1)
  } finally {
    await h.finish()
  }
})
test('completed fan task is a timeout-only payment fallback and never repeats payment', async () => {
  const p = await page(css + `<script>window.pays=0</script><div class="lottery-dialog" data-lottery-id="b1"><h3>福袋</h3><p id="fan">加入粉丝团 未完成</p><button onclick="window.pays++;document.querySelector('#fan').textContent='加入粉丝团 已完成';this.remove()">加入粉丝团(1钻石)</button></div>`)
  const h = harness(p, {membership: 'needs-payment', cost: 1})
  try {
    await h.service.tick(); await h.service.tick()
    h.advance(11000); await h.service.tick()
    assert.equal(Object.values(h.repo.account().payments)[0].state, 'submitted')
    h.advance(1000); await h.service.tick()
    assert.equal(Object.values(h.repo.account().payments)[0].state, 'confirmed')
    assert.equal(h.repo.budget(10, false, h.env.policy()).spent, 1)
    assert.equal(h.repo.budget(10, false, h.env.policy()).reserved, 0)
    assert.equal(h.risks.length, 0)
    assert.ok(h.logs.some(x => x.includes('兜底确认付款')))
    await h.service.tick(); await h.service.tick()
    assert.equal(await p.evaluate(() => (window as any).pays), 1)
    assert.equal(Object.values(h.repo.account().payments).length, 1)
  } finally { await h.finish() }
})

test('payment fallback rejects unrelated or ambiguous completion and preserves explicit failure', async () => {
  for (const scenario of ['changed-round','changed-rights','dom-id','missing','comment','conflict','hidden','failure','stop']) {
    const p = await page(css + '<div class="lottery-dialog" data-lottery-id="b1"><h3>福袋</h3><p id="fan">加入粉丝团 未完成</p><button>加入粉丝团(1钻石)</button></div>')
    const h = harness(p, {membership:'needs-payment',cost:1})
    try {
      await h.service.tick(); await h.service.tick()
      await p.evaluate(() => {document.querySelector('#fan')!.textContent='加入粉丝团 已完成'})
      if (scenario === 'changed-round') h.service.seed({...h.o,lotteryId:'b2',observedAt:h.now()+1})
      if (scenario === 'changed-rights') h.service.observer.panelLotteryId='b2'
      if (scenario === 'dom-id') await p.evaluate(() => document.querySelector('.lottery-dialog')!.setAttribute('data-lottery-id','b2'))
      if (scenario === 'missing') await p.evaluate(() => {document.querySelector('#fan')!.textContent='已参与，等待开奖'})
      if (scenario === 'comment') await p.evaluate(() => {document.querySelector('#fan')!.textContent='评论口令：加入粉丝团 已完成'})
      if (scenario === 'conflict') await p.evaluate(() => document.querySelector('.lottery-dialog')!.insertAdjacentHTML('beforeend','<p>点亮灯牌 未完成</p>'))
      if (scenario === 'hidden') await p.evaluate(() => {(document.querySelector('.lottery-dialog') as HTMLElement).style.display='none'})
      if (scenario === 'failure') h.service.observer.lastFanFailure=h.now()
      if (scenario === 'stop') {h.controller.abort();h.service.stopMonitoring()}
      h.advance(12000); await h.service.tick()
      assert.equal(Object.values(h.repo.account().payments)[0].state,scenario === 'failure' ? 'failed' : 'unresolved',scenario)
      assert.equal(h.repo.budget(10,false,h.env.policy()).spent,0,scenario)
      assert.equal(h.logs.some(x=>x.includes('兜底确认付款')),false,scenario)
    } finally {await h.finish()}
  }
})

test('a returned page waits until the 45-second task window but starts earlier for long watch tasks', async () => {
  for (const watch of [0, 60]) {
    const p = await page(css + '<script>window.calls=0</script><div class="lottery-dialog"><h3>福袋</h3><button onclick="window.calls++">发送口令</button></div>')
    const h = harness(p, {requiresComment:true,commentText:'测试',watchSeconds:watch})
    h.env.getConfig=()=>({...defaults,enterBeforeSeconds:45})
    try {
      await h.service.tick(); await h.service.tick()
      assert.equal(await p.evaluate(()=>(window as any).calls),0)
      h.advance(74000); await h.service.tick()
      assert.equal(await p.evaluate(()=>(window as any).calls),watch ? 1 : 0)
      h.advance(1000); await h.service.tick()
      assert.equal(await p.evaluate(()=>(window as any).calls),1)
      await p.evaluate(()=>{document.querySelector('.lottery-dialog')!.innerHTML='<h3>福袋</h3>已参与，等待开奖'})
      await h.service.tick()
      assert.ok(Object.values(h.repo.account().rounds)[0].taskSeconds! <= 1, "idle window must not inflate learned task time")
    } finally {await h.finish()}
  }
})

test('a due reservation ends next-round waiting immediately after settlement', async () => {
  const p = await page(css + '<div class="lottery-dialog"><h3>福袋</h3>已参与，等待开奖</div>')
  const h = harness(p)
  const updates:{o:Opportunity|null;rounds:number;status:string}[]=[]
  ;(h.service as any).callbacks.onUpdate=(o:Opportunity|null,rounds:number,status:string)=>updates.push({o,rounds,status})
  try {
    await h.service.tick();await h.service.tick()
    h.advance(145000); await h.service.tick()
    assert.deepEqual(updates.at(-1),{o:null,rounds:1,status:'等待下一轮福袋'},'settlement clears the old countdown before waiting for another round')
    ;(h.service as any).callbacks.mayWaitForNext=()=> '已有预约到时，结束等待新福袋并返房复验'
    await h.service.tick()
    assert.match(h.service.doneReason,/已有预约到时/)
  } finally {await h.finish()}
})

test('a reservation becoming due in the action queue cancels next-round reopening', async () => {
  const p = await page(css + `<script>window.closes=0</script><div class="lottery-dialog"><h3>福袋</h3>已参与，等待开奖<button style="width:40px" aria-label="关闭福袋" onclick="window.closes++">×</button></div>`)
  const h = harness(p)
  try {
    await h.service.tick();await h.service.tick()
    h.advance(145000);await h.service.tick()
    let due=false
    ;(h.service as any).callbacks.mayWaitForNext=()=>due?'已有预约到时，结束等待新福袋并返房复验':null
    h.env.perform=async(signal,fn)=>{due=true;return run(signal,fn)}
    await h.service.tick()
    assert.match(h.service.doneReason,/已有预约到时/)
    assert.equal(await p.evaluate(()=>(window as any).closes),0)
  } finally {await h.finish()}
})

test('conflicting receipts and fallback DOM failures preserve pending spend and block', async () => {
  for (const scenario of ['conflict','read-error']) {
    const p=await page(css+'<div class="lottery-dialog"><h3>福袋</h3><button>加入粉丝团(1钻石)</button></div>')
    const h=harness(p,{membership:'needs-payment',cost:1})
    try {
      await h.service.tick();await h.service.tick()
      if(scenario==='conflict'){
        h.service.observer.lastFanSuccess=h.now()
        h.service.observer.lastFanFailure=h.now()
      } else {
        ;(h.service as any).dom.panelSnapshot=async()=>{throw new Error('fixture DOM detached')}
        h.advance(12000)
      }
      await h.service.tick()
      assert.equal(Object.values(h.repo.account().payments)[0].state,'unresolved',scenario)
      assert.equal(h.repo.budget(10,false,h.env.policy()).reserved,1,scenario)
      assert.equal(h.repo.budget(10,false,h.env.policy()).spent,0,scenario)
      assert.equal(h.risks.length,1,scenario)
      assert.equal(h.repo.account().session.phase,'blocked',scenario)
      await h.service.tick()
      assert.equal(Object.values(h.repo.account().payments).length,1)
    }finally{await h.finish()}
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

test('when both task buttons are visible one-click comment takes priority and is not repeated', async () => {
  const p = await page(css + `<script>window.calls=[]</script><div class="lottery-dialog">福袋参与条件
    <button onclick="window.calls.push('pay')">点亮粉丝团(1钻)</button>
    <button onclick="window.calls.push('comment')">点击一键评论并参与（自动发送）</button></div>`)
  const h = harness(p, { requiresComment: true, commentText: '测试', membership: 'needs-payment', cost: 1 })
  try {
    await h.service.tick()
    await h.service.tick()
    await h.service.tick()
    assert.deepEqual(await p.evaluate(() => (window as any).calls), ['comment'])
    assert.equal(Object.values(h.repo.account().payments).length, 0)
    h.advance(11000)
    await h.service.tick()
    assert.match(h.service.doneReason, /评论未获得业务成功反馈/)
    const diagnostic = h.logs.find(m => m.startsWith('评论反馈超时诊断：'))!
    assert.ok(diagnostic)
    assert.match(diagnostic, /"panelReadable":true/)
    assert.match(diagnostic, /"commentButtonVisible":true/)
    assert.match(diagnostic, /"rightsMatch":true/)
    assert.ok(!diagnostic.includes('测试'))
    await h.service.tick()
    assert.equal(h.logs.filter(m => m.startsWith('评论反馈超时诊断：')).length, 1)
    assert.deepEqual(await p.evaluate(() => (window as any).calls), ['comment'])
  } finally { await h.finish() }
})

test('comment diagnostic read failure keeps the terminal guard and never retries payment or comment', async () => {
  const p=await page(css+'<div class="lottery-dialog">福袋参与条件<button>一键评论</button></div>')
  const h=harness(p,{requiresComment:true,commentText:'private-command',membership:'needs-payment',cost:1})
  try {
    await h.service.tick(); await h.service.tick()
    ;(h.service as any).dom.panelDiagnostics=async()=>{throw new Error('fixture')}
    h.advance(11000); await h.service.tick(); await h.service.tick()
    assert.match(h.service.doneReason,/评论未获得业务成功反馈/)
    assert.ok(h.logs.some(m=>m.includes('页面状态读取失败；本轮已停止')))
    assert.equal(Object.values(h.repo.account().payments).length,0)
  } finally {await h.finish()}
})

test('next-round logs distinguish a retained result from a closed result without a new entry',async()=>{
  for (const canClose of [true,false]) {
    const p=await page(css+'<div class="lottery-dialog">福袋 已参与，等待开奖</div>'),h=harness(p)
    try {
      await h.service.tick(); await h.service.tick(); h.advance(120000)
      await p.locator('.lottery-dialog').evaluate((el,close)=>{
        el.id='short_touch_land_lottery_land_result'
        el.innerHTML='没抽中福袋<br>查看幸运观众'+(close?'<button onclick="this.parentElement.remove()">知道了</button>':'')
      },canClose)
      await h.service.tick(); h.advance(3000); await h.service.tick()
      assert.ok(h.logs.some(m=>m.includes(canClose?'上一轮结果弹窗已关闭':'上一轮结果弹窗仍可见')),JSON.stringify(h.logs))
      if(canClose)assert.ok(h.logs.some(m=>m.includes('没有找到可见的福袋入口')))
    }finally{await h.finish()}
  }
})

test('comment response diagnostics distinguish failure and malformed feedback without leaking content',async()=>{
  const p=await page(css+'<div class="lottery-dialog">福袋</div>'),h=harness(p)
  try {
    for (const [body,expected] of [
      ['{"status_code":1,"message":"private-message"}','评论业务返回失败'],
      ['not-json-private-message','响应不是有效的 JSON'],
      ['{"status_code":0}','评论业务成功']
    ]) {
      await p.route('**/webcast/room/chat/**',route=>route.fulfill({status:200,body}))
      await p.evaluate(()=>fetch('/webcast/room/chat/?secret=private-query',{method:'POST',body:'private-command'}))
      await eventually(()=>h.service.observer.identityDiagnostics().includes(expected))
      assert.ok(!h.service.observer.identityDiagnostics().includes('private-'))
      if(expected!=='评论业务成功')assert.equal(h.service.observer.lastChatSuccess,0)
      await p.unroute('**/webcast/room/chat/**')
    }
  }finally{await h.finish()}
})

test('fan-first waits for delayed comment without chat fallback or a second payment', async () => {
  for (const showComment of [true, false]) {
    const p = await page(css + `<script>window.calls=[]</script>
      <textarea placeholder="说点什么" onkeydown="window.calls.push('chat')"></textarea>
      <button onclick="window.calls.push('outside')">一键评论</button>
      <div class="lottery-dialog">福袋参与条件
        <button id="pay" onclick="window.calls.push('pay');this.style.display='none'">加入粉丝团(1钻)</button>
        <button id="comment" style="display:none" onclick="window.calls.push('comment');this.textContent='已参与，等待开奖'">一键发评论参与福袋</button>
      </div>`)
    const h = harness(p, { requiresComment: true, commentText: '测试', membership: 'needs-payment', cost: 1 })
    try {
      await h.service.tick()
      await h.service.tick()
      // Until a payment receipt arrives, no comment or second payment may run.
      await h.service.tick()
      assert.deepEqual(await p.evaluate(() => (window as any).calls), ['pay'])
      h.service.observer.lastFanSuccess = h.now()
      await h.service.tick()
      h.service.seed({ ...h.o, observedAt: h.now() + 1, membership: 'satisfied', cost: 0 })
      await h.service.tick()
      h.advance(showComment ? 5000 : 11000)
      if (showComment) await p.locator('#comment').evaluate(el => { (el as HTMLElement).style.display = 'block' })
      await h.service.tick()
      await h.service.tick()
      await h.service.tick()
      assert.deepEqual(await p.evaluate(() => (window as any).calls), showComment ? ['pay', 'comment'] : ['pay'])
      assert.equal(await p.locator('textarea').inputValue(), '')
      assert.equal(Object.values(h.repo.account().payments).length, 1)
      assert.equal(h.repo.budget(10, false, h.env.policy()).spent, 1)
      assert.equal(h.repo.stats().participated, showComment ? 1 : 0)
      if (!showComment) assert.match(h.service.doneReason, /一键评论按钮/)
    } finally { await h.finish() }
  }
})

test('paid receipt alone cannot submit while fan qualification is still unmet', async () => {
  const p = await page(css + `<script>window.calls=[]</script><div class="lottery-dialog">福袋参与条件
    <button onclick="window.calls.push('pay');this.textContent='立即参与';this.onclick=()=>window.calls.push('submit')">点亮粉丝团(1钻)</button></div>`)
  const h = harness(p, { membership: 'needs-payment', cost: 1 })
  try {
    await h.service.tick()
    await h.service.tick()
    h.service.observer.lastFanSuccess = h.now()
    await h.service.tick()
    await h.service.tick()
    h.advance(11000)
    await h.service.tick()
    assert.match(h.service.doneReason, /粉丝团资格尚未确认/)
    assert.deepEqual(await p.evaluate(() => (window as any).calls), ['pay'])
    assert.equal(h.repo.stats().participated, 0)
  } finally { await h.finish() }
})

test('fan-first cannot bypass budget, levels, command validity or task time after gate waiting', async () => {
  for (const scenario of ['budget', 'level', 'command', 'time', 'unknown-price']) {
    const p = await page(css + `<script>window.calls=0</script><div class="lottery-dialog">福袋参与条件
      <button onclick="window.calls++">点亮粉丝团(1钻)</button></div>`)
    const h = harness(p, { requiresComment: true, commentText: scenario === 'command' ? 'a'.repeat(101) : '测试',
      membership: 'needs-payment', cost: 1,
      ...(scenario === 'level' ? { fanLevelRequired: 2, unsupported: ['粉丝团等级条件尚未满足'] } : {}) })
    try {
      if (scenario === 'budget') h.env.paymentReason = () => '预算不足'
      await h.service.tick()
      if (scenario === 'unknown-price') await p.locator('button').evaluate(el => { el.textContent = '点亮粉丝团' })
      if (scenario === 'time') h.env.perform = async (signal, task) => { h.advance(90000); return run(signal, task) }
      await h.service.tick()
      h.advance(11000)
      await h.service.tick()
      assert.equal(await p.evaluate(() => (window as any).calls), 0, scenario)
      assert.equal(h.repo.budget(10, false, h.env.policy()).reserved, 0, scenario)
      assert.equal(h.repo.budget(10, false, h.env.policy()).spent, 0, scenario)
      assert.equal(h.repo.stats().participated, 0, scenario)
      assert.ok(h.service.doneReason, scenario)
    } finally { await h.finish() }
  }
})

test('comment wording variants are bounded and never fall back to chat or a paid/share/task row', async () => {
  const p = await page(css + `<script>window.calls=0</script><textarea placeholder="说点什么"></textarea>
    <button onclick="window.calls++">一键评论</button><div class="lottery-dialog">福袋参与条件<button id="target" onclick="window.calls++"></button></div>`)
  const dom = new LotteryDom(p, new AbortController().signal, run)
  try {
    for (const label of ['一键发表评论', '点击评论参与', '一键评论并参与', '一键评论（自动发送）', '发表评论参与福袋']) {
      await p.locator('#target').evaluate((el, text) => { el.textContent = text }, label)
      assert.equal(await dom.comment('口令'), true, label)
    }
    for (const label of ['评论参与（1钻）', '分享后评论参与', '发送评论：一键评论 未达成', '加入粉丝团(1钻)', '已完成一键评论']) {
      await p.locator('#target').evaluate((el, text) => { el.textContent = text }, label)
      assert.equal(await dom.comment('口令'), false, label)
    }
    assert.equal(await p.evaluate(() => (window as any).calls), 5)
    assert.equal(await p.locator('textarea').inputValue(), '')
  } finally { await p.context().close() }
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
test('a bound next round is offered to scheduling only after old settlement and before new tasks', async()=>{
  const p=await page(css+'<script>window.clicks=0</script><div class="lottery-dialog">福袋 已参与，等待开奖</div>')
  const offered:Opportunity[]=[]
  const h=harness(p,{},o=>{offered.push(o);return '下一轮已加入预约队列，离房继续验证其他候选'})
  try{
    h.env.policy().maxStayMinutes=5
    await h.service.tick();await h.service.tick()
    const next=opportunity(h.now(),{lotteryId:'next',drawAt:h.now()+720000,requiresComment:true,commentText:'测试'})
    h.service.seed(next)
    h.advance(130000);await h.service.tick()
    assert.equal(offered.length,0,'next round cannot replace the old settlement window')
    h.advance(16000);await h.service.tick()
    await p.locator('.lottery-dialog').evaluate(el=>{el.innerHTML='福袋 参与条件<button onclick="window.clicks++">一键评论</button>'})
    h.service.observer.panelLotteryId='next'
    await h.service.tick()
    assert.equal(offered.length,1)
    assert.equal(offered[0].lotteryId,'next')
    assert.match(h.service.doneReason,/加入预约/)
    assert.equal(await p.evaluate(()=>(window as any).clicks),0)
    assert.equal(Object.keys(h.repo.account().rounds).length,1,'queued round has not attempted participation')
  }finally{await h.finish()}
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
    assert.match(observer.identityDiagnostics(),/灯牌业务失败/)
    code = 0
    await p.evaluate(() => fetch('/webcast/gift/send/', { method: 'POST', body: 'gift_id=6937' }))
    await p.waitForTimeout(100)
    assert.ok(observer.lastFanSuccess > 0)
    assert.match(observer.identityDiagnostics(),/灯牌业务成功/)
    observer.close()
    assert.equal((p as any).listenerCount('response'), 0)
    assert.equal((p as any).listenerCount('websocket'), 0)
  } finally {
    observer.close()
    await context.close()
  }
})
test('payment receipts use observed request time, accept trailing-slash variants and reject missing timing', async () => {
  const p = await page(''), controller = new AbortController()
  const observer = new PassiveObserver(p, controller.signal, () => {})
  const request = (path: string) => ({url: () => `https://live.douyin.com${path}`, method: () => 'POST', postData: () => 'gift_id=6937', timing: () => ({startTime: -1})})
  const response = (req: ReturnType<typeof request>) => ({url: req.url, request: () => req, status: () => 200, ok: () => true, text: async () => '{"status_code":0}'})
  try {
    observer.beginPaymentObservation()
    const unobserved = request('/webcast/gift/send/')
    await (observer as any).readResponse(response(unobserved))
    assert.equal(observer.lastFanSuccess, 0, 'response time cannot substitute for dispatch time')
    const observed = request('/webcast/gift/send')
    ;(observer as any).request(observed)
    const originalTime = (observer as any).requestTimes.get(observed)
    await p.waitForTimeout(20)
    const newerPaymentStarted = Date.now()
    await (observer as any).readResponse(response(observed))
    assert.equal(observer.lastFanSuccess, originalTime)
    assert.ok(observer.lastFanSuccess < newerPaymentStarted, 'late older receipt cannot confirm a newer payment')
    observer.close()
    assert.equal((p as any).listenerCount('request'), 0)
    assert.equal((p as any).listenerCount('requestfailed'), 0)
  } finally { observer.close(); await p.context().close() }
})

test('unknown payment paths are diagnosed without authorizing spend or leaking payloads', async () => {
  const p = await page(''), controller = new AbortController()
  const observer = new PassiveObserver(p, controller.signal, () => {})
  const req = {url: () => 'https://example.invalid/payment/123456789?token=secret', method: () => 'POST', postData: () => 'gift_id=6937&secret=private', timing: () => ({startTime: Date.now()})}
  try {
    observer.beginPaymentObservation()
    ;(observer as any).request(req)
    assert.match(observer.identityDiagnostics(), /已发出，尚无响应/)
    await (observer as any).readResponse({url: req.url, request: () => req, status: () => 200, ok: () => true, text: async () => '{"status_code":0}'})
    assert.equal(observer.lastFanSuccess, 0)
    assert.match(observer.identityDiagnostics(), /其他域 \/payment\/:segment: HTTP 200/)
    assert.doesNotMatch(observer.identityDiagnostics(), /secret|private|123456789|example.invalid/)
    ;(observer as any).requestFailed(req)
    assert.match(observer.identityDiagnostics(), /请求失败/)
    observer.beginPaymentObservation()
    assert.doesNotMatch(observer.identityDiagnostics(), /payment/)
  } finally { observer.close(); await p.context().close() }
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

for (const rightsPath of ['/webcast/lottery/right/', '/webcast/lottery/melon/check_user_right/']) {
test(`comment then fan-club payment and participation through ${rightsPath}`, async () => {
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
    await fetch('${rightsPath}')
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
        pathname === rightsPath
          ? JSON.stringify(payload())
          : pathname.startsWith('/webcast/')
            ? '{"status_code":0}'
            : html
    })
  })
  const p = await context.newPage()
  await p.goto(url)
  const h = harness(p)
  h.service.observer.latest = null
  h.service.observer.panelLotteryId = null
  try {
    await p.evaluate(path => fetch(path), rightsPath)
    await eventually(() => h.service.observer.latest?.lotteryId === 'full-flow' && h.service.observer.panelLotteryId === 'full-flow')
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
}

test('melon rights bind only successful matching identities; info and similar paths cannot authorize', async () => {
  const p = await page(css)
  const observer = new PassiveObserver(p, new AbortController().signal, () => {})
  let start = 100
  const deliver = async (path: string, payload: unknown, query = '') => {
    await (observer as any).readResponse({
      url: () => `https://live.douyin.com${path}${query}`,
      status: () => 200, ok: () => true,
      text: async () => JSON.stringify(payload),
      request: () => ({ timing: () => ({ startTime: start++ }), postData: () => '' })
    })
  }
  const good = { status_code: 0, data: { lottery_info: {
    lottery_id_str: 'melon-round', count_down: 180, conditions: []
  } } }
  const rights = '/webcast/lottery/melon/check_user_right/'
  try {
    await deliver('/webcast/lottery/melon/lottery_info/', good)
    assert.equal(observer.latest?.lotteryId, 'melon-round')
    assert.equal(observer.panelLotteryId, null)
    await deliver(rights + 'unrecognized', good)
    assert.equal(observer.panelLotteryId, null)
    await deliver(rights, good)
    assert.equal(observer.panelLotteryId, 'melon-round')
    await deliver(rights, { ...good, status_code: 1 })
    assert.equal(observer.panelLotteryId, null)
    await deliver(rights, good, '?lottery_id=different-round')
    assert.equal(observer.panelLotteryId, null)
    assert.match(observer.panelIdentityReason, /身份不一致/)
    await deliver(rights, { status_code: 0 }, '?lottery_id=melon-round')
    assert.equal(observer.panelLotteryId, null)
    await deliver(rights, good)
    await deliver(rights, { ...good, data: { lottery_info: {
      lottery_id_str: 'next-round', count_down: 240, conditions: []
    } } })
    assert.equal(observer.panelLotteryId, 'next-round')
    assert.equal(observer.latest?.lotteryId, 'next-round')
  } finally { observer.close(); await p.context().close() }
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

test('passive partial rights plus live panel updates complete all task paths without duplicate actions', async () => {
  for (const scenario of ['direct', 'follow', 'comment', 'fan-comment', 'satisfied-level2', 'unmet-level2']) {
    const id = '7399123456789012345'
    const comment = ['comment', 'fan-comment', 'unmet-level2'].includes(scenario)
    const fan = scenario.includes('level2') || scenario === 'fan-comment'
    const level = scenario.includes('level2') ? 2 : 1
    const satisfied = scenario === 'satisfied-level2'
    const conditions = [
      ...(comment ? [{ type: 3, description: '发送评论：关注价值3000元显卡', status: 0 }] : []),
      ...(scenario === 'follow' ? [{ type: 1, description: '关注主播', status: 0 }] : []),
      ...(fan ? [{ type: 8, description: `粉丝团点亮且达到${level}级及以上`, status: satisfied ? 1 : 0 }] : [])
    ]
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } })
    const html = css + `<script>
      window.calls=[];let commented=${!comment},followed=${scenario !== 'follow'},paid=${!fan || satisfied};
      function render(){document.querySelector('.lottery-dialog').innerHTML='<h3>福袋 52人已参与</h3>'+
        (${comment} ? '<p>发送评论：关注价值3000元显卡 '+(commented?'已达成':'未达成')+'</p>':'')+
        (${scenario === 'follow'} ? '<p>关注主播 '+(followed?'已达成':'未达成')+'</p>':'')+
        (${fan} ? '<p>粉丝团点亮且达到${level}级及以上 '+(paid?'已达成':'未达成')+'</p>':'')+
        '<button onclick="task()">'+(${scenario === 'unmet-level2'}?'提升亲密度':!paid?'加入粉丝团(1钻)':!commented?'一键发评论参与福袋':!followed?'去关注':'抢福袋')+'</button>'}
      async function commentTask(){window.calls.push('comment');await fetch('/webcast/room/chat/',{method:'POST',body:'content=fixture'});commented=true;render()}
      async function task(){
        if(!paid){window.calls.push('pay');await fetch('/webcast/gift/send/',{method:'POST',body:'gift_id=6937'});paid=true}
        else if(!commented){await commentTask();return}
        else if(!followed){window.calls.push('follow');followed=true}
        else{window.calls.push('submit');document.querySelector('.lottery-dialog').innerHTML='<h3>福袋</h3>已参与，等待开奖';return}
        render()
      }
      </script><textarea placeholder="说点什么" onkeydown="window.calls.push('unexpected-chat')"></textarea><div class="lottery-dialog"></div><script>render()</script>`
    await context.route('**/*', route => {
      const path = new URL(route.request().url()).pathname
      const body = path.includes('/lottery/info/')
        ? JSON.stringify({ status_code: 0, data: { lottery_info: { lottery_id_str: id, count_down: 180, conditions } } })
        : path.includes('/lottery/right/') ? '{"status_code":0,"data":{"user_condition":{}}}'
        : '{"status_code":0}'
      return route.fulfill({ status: 200, contentType: path.startsWith('/webcast/') ? 'application/json' : 'text/html; charset=utf-8', body: path.startsWith('/webcast/') ? body : html })
    })
    const p = await context.newPage()
    await p.goto(url)
    const h = harness(p)
    h.service.observer.latest = null
    h.service.observer.panelLotteryId = null
    try {
      await p.evaluate(async id => {
        await fetch('/webcast/lottery/info/')
        await fetch('/webcast/lottery/right/?lottery_id=' + id)
      }, id)
      await eventually(() => h.service.observer.latest?.lotteryId === id && h.service.observer.panelLotteryId === id)
      for (let i = 0; i < 14; i++) {
        await h.service.tick()
        await p.waitForTimeout(15)
      }
      const calls = await p.evaluate(() => (window as any).calls)
      const expected = scenario === 'unmet-level2' ? [] : [
        ...(scenario === 'fan-comment' ? ['pay'] : []), ...(comment ? ['comment'] : []),
        ...(scenario === 'follow' ? ['follow'] : []), 'submit'
      ]
      assert.deepEqual(calls, expected, scenario)
      assert.equal(h.repo.stats().participated, scenario === 'unmet-level2' ? 0 : 1, scenario)
      assert.equal(h.repo.budget(10, false, h.env.policy()).spent, scenario === 'fan-comment' ? 1 : 0, scenario)
      if (scenario === 'unmet-level2') assert.match(h.service.doneReason, /等级/)
      else assert.equal(h.service.doneReason, '', scenario)
    } finally { await h.finish() }
  }
})

test('reopening uses only the lottery close control and never presses global Escape', async () => {
  const p = await page(css + `<script>window.closes=0;window.opens=0;window.escapes=0;document.addEventListener("keydown",e=>{if(e.key==="Escape")window.escapes++})</script>
    <button aria-label="关闭" onclick="throw new Error('unrelated close')">关闭</button>
    <div id="ShortTouchLayout"><div class="ycjwPFJI" onclick="window.opens++;document.querySelector('.lottery-dialog').style.display='block'">03:00</div></div>
    <div class="lottery-dialog">福袋参与条件<button style="width:40px" aria-label="关闭福袋" onclick="window.closes++;this.parentElement.style.display='none'">×</button></div>`)
  try {
    const dom = new LotteryDom(p, new AbortController().signal, run)
    assert.equal(await dom.reopen(), true)
    assert.deepEqual(await p.evaluate(() => [(window as any).closes, (window as any).opens, (window as any).escapes]), [1, 1, 0])
  } finally { await p.context().close() }
})

test('graphic close control reopens panel and obtains rights through natural page response', async () => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } })
  const requests: string[] = []
  await context.route('**/*', route => {
    const path = new URL(route.request().url()).pathname
    requests.push(path)
    if (path.startsWith('/webcast/lottery/')) return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ status_code: 0, data: { lottery_info: {
        lottery_id_str: 'observed-round', count_down: 180, conditions: []
      } } }) })
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: css + `
      <div id="ShortTouchLayout"><div class="ycjwPFJI" onclick="document.querySelector('.lottery-dialog').style.display='block';fetch('/webcast/lottery/right/')">03:00</div></div>
      <div class="lottery-dialog">福袋参与条件
        <button onclick="window.taskClicks++">立即参与</button>
        <div class="lottery-close" style="cursor:pointer;width:32px;height:32px" onclick="this.parentElement.style.display='none'">
          <svg width="24" height="24"><path d="M2 2L22 22M22 2L2 22" stroke="black"/></svg>
        </div>
      </div><script>window.taskClicks=0;fetch('/webcast/lottery/info/')</script>` })
  })
  const p = await context.newPage(), controller = new AbortController()
  const observer = new PassiveObserver(p, controller.signal, () => {})
  try {
    await p.goto(url)
    await eventually(() => !!observer.latest)
    assert.equal(observer.panelLotteryId, null)
    const dom = new LotteryDom(p, controller.signal, run)
    assert.equal(await dom.reopen(), true)
    await eventually(() => observer.panelLotteryId === 'observed-round')
    assert.equal(observer.latest?.lotteryId, 'observed-round')
    assert.equal(requests.filter(path => path === '/webcast/lottery/right/').length, 1)
    assert.equal(await p.evaluate(() => (window as any).taskClicks), 0)
  } finally { observer.close(); await context.close() }
})

test('an identity change while the action gate waits cancels dispatch and never sends a comment', async () => {
  const p = await page(css + `<script>window.calls=0</script><div class="lottery-dialog">福袋评论参与<button onclick="window.calls++">发表评论</button></div>`)
  const h = harness(p, { requiresComment: true, commentText: '测试' })
  const original = h.env.perform
  try {
    await h.service.tick()
    h.env.perform = async (signal, fn) => {
      h.service.observer.panelLotteryId = 'new-round'
      return original(signal, fn)
    }
    await h.service.tick()
    assert.match(h.service.doneReason, /身份变化/)
    await h.service.tick()
    assert.equal(await p.evaluate(() => (window as any).calls), 0)
    assert.equal(h.repo.stats().participated, 0)
  } finally { await h.finish() }
})

test('a delayed next button is awaited without resending the successful comment; a missing button times out', async () => {
  for (const nextButtonAppears of [true, false]) {
    const p = await page(css + `<script>window.calls=[]</script><div class="lottery-dialog"><h3>福袋</h3>
      <p>发送评论：测试口令 未达成</p><button onclick="window.calls.push('comment');this.previousElementSibling.textContent='发送评论：测试口令 已达成';this.remove()">一键发表评论</button></div>`)
    const h = harness(p, { requiresComment: true, commentText: '测试口令' })
    try {
      await h.service.tick()
      await h.service.tick()
      await h.service.tick()
      h.advance(5000)
      await h.service.tick()
      assert.equal(h.service.doneReason, '')
      assert.deepEqual(await p.evaluate(() => (window as any).calls), ['comment'])
      assert.equal(h.repo.stats().participated, 0)
      if (nextButtonAppears) {
        await p.locator('.lottery-dialog').evaluate(el => {
          const button = document.createElement('button')
          button.textContent = '免费参与'
          button.onclick = () => { (window as any).calls.push('submit'); button.textContent = '已参与，等待开奖' }
          el.append(button)
        })
        await h.service.tick()
        await h.service.tick()
        assert.deepEqual(await p.evaluate(() => (window as any).calls), ['comment', 'submit'])
        assert.equal(h.repo.stats().participated, 1)
      } else {
        h.advance(5001)
        await h.service.tick()
        assert.match(h.service.doneReason, /未发现明确参与按钮/)
        assert.equal(h.repo.stats().participated, 0)
      }
    } finally { await h.finish() }
  }
})

test('comment and follow dispatch survive a fresh service instance and cannot be replayed', async () => {
  for (const kind of ['comment', 'follow'] as const) {
    const p = await page(css + `<script>window.calls=0</script><div class="lottery-dialog">福袋参与条件
      <button onclick="window.calls++">${kind === 'comment' ? '发表评论' : '关注'}</button></div>`)
    const h = harness(p, kind === 'comment' ? { requiresComment: true, commentText: '测试' } : { requiresFollow: true })
    let resumed: FudaiService | undefined
    try {
      await h.service.tick()
      await h.service.tick()
      const saved = h.repo.account().rounds[h.repo.roundKey(url, h.o.lotteryId)].actions?.[kind]
      assert.ok(saved?.at)
      h.service.stopMonitoring()
      resumed = new FudaiService(p, url, { onUpdate: () => {}, onResult: () => {}, onLog: () => {}, mayContinue: () => null }, h.env)
      resumed.seed(h.o)
      resumed.observer.panelLotteryId = h.o.lotteryId
      await resumed.tick()
      h.advance(11000)
      await resumed.tick()
      await resumed.tick()
      assert.equal(await p.evaluate(() => (window as any).calls), 1, kind)
      assert.match(resumed.doneReason, /未获得业务成功反馈|关注状态未确认/)
    } finally { resumed?.stopMonitoring(); await h.finish() }
  }
})

test('a task node becoming a paid button during gate waiting is not clicked as the old task', async () => {
  const p = await page(css + `<script>window.calls=0</script><div class="lottery-dialog">福袋参与条件
    <button onclick="window.calls++">发表评论</button></div>`)
  let dispatched = 0
  const dom = new LotteryDom(p, new AbortController().signal, async (signal, fn) => {
    await p.locator('.lottery-dialog button').evaluate(el => { el.textContent = '加入粉丝团(1钻)' })
    return run(signal, fn)
  })
  try {
    assert.equal(await dom.comment('测试', () => { dispatched++ }), false)
    assert.equal(dispatched, 0)
    assert.equal(await p.evaluate(() => (window as any).calls), 0)
  } finally { await p.context().close() }
})

test('paid action timeout starts at dispatch, and cancellation before dispatch releases its reservation', async () => {
  for (const cancel of [false, true]) {
    const p = await page(css + `<script>window.calls=0</script><div class="lottery-dialog">福袋参与条件
      <button onclick="window.calls++">加入粉丝团(1钻)</button></div>`)
    const h = harness(p, { membership: 'needs-payment', cost: 1 })
    try {
      await h.service.tick()
      h.env.perform = async (signal, fn) => {
        h.advance(20000)
        if (cancel) h.service.stopMonitoring()
        return run(signal, fn)
      }
      await h.service.tick()
      h.env.perform = run
      await h.service.tick()
      assert.equal(await p.evaluate(() => (window as any).calls), cancel ? 0 : 1)
      assert.equal(Object.values(h.repo.account().payments)[0].state, cancel ? 'failed' : 'submitted')
      assert.deepEqual(h.risks, [])
      assert.equal(h.repo.budget(10, false, h.env.policy()).reserved, cancel ? 0 : 1)
    } finally { await h.finish() }
  }
})

test('a payment confirmation queued past timeout or past a successful receipt is not clicked', async () => {
  for (const outcome of ['timeout', 'success']) {
    const p = await page(css + `<script>window.confirmations=0</script><div class="lottery-dialog">福袋参与条件
      <button onclick="document.getElementById('confirm').style.display='block'">加入粉丝团(1钻)</button></div>
      <div id="confirm" role="dialog" style="display:none">加入粉丝团1钻<button onclick="window.confirmations++">确认支付</button></div>`)
    const h = harness(p, { membership: 'needs-payment', cost: 1 })
    try {
      await h.service.tick()
      await h.service.tick()
      h.advance(1001)
      h.env.perform = async (signal, fn) => {
        h.advance(20000)
        if (outcome === 'success') h.service.observer.lastFanSuccess = h.now()
        return run(signal, fn)
      }
      await h.service.tick()
      assert.equal(await p.evaluate(() => (window as any).confirmations), 0)
      assert.equal(Object.values(h.repo.account().payments)[0].state, outcome === 'success' ? 'confirmed' : 'unresolved')
      assert.equal(h.risks.length, outcome === 'success' ? 0 : 1)
    } finally { await h.finish() }
  }
})

test('navigation queue time does not consume the first-lottery observation window', async () => {
  const p = await page(css + '<div class="lottery-dialog">福袋参与条件<button>免费参与</button></div>')
  const h = harness(p, { drawAt: Date.now() + 600000 })
  h.service.stopMonitoring()
  const service = new FudaiService(p, url, { onUpdate: () => {}, onResult: () => {}, onLog: () => {}, mayContinue: () => null }, h.env, undefined, false)
  try {
    service.seed(h.o)
    service.observer.panelLotteryId = h.o.lotteryId
    h.advance(180000)
    await service.tick()
    assert.equal(Object.keys(h.repo.account().rounds).length, 0)
    service.startMonitoring()
    await service.tick()
    assert.equal(service.doneReason, '')
    assert.equal(Object.keys(h.repo.account().rounds).length, 1)
    service.stopMonitoring()
    service.startMonitoring()
    await service.tick()
    assert.equal(h.repo.account().rounds[h.repo.roundKey(url, h.o.lotteryId)].submittedAt, null)
  } finally { service.stopMonitoring(); await h.finish() }
})
