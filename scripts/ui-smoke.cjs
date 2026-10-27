const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

// This fixture supplies all IPC results and fulfills every browser request locally.
module.exports = async function verifyUI(config, output) {
  const root = path.resolve(__dirname, '..')
  const browser = await chromium.launch({ headless: true })
  const errors = []
  let checks = 0
  const check = (condition, message) => {
    assert.ok(condition, message)
    checks++
  }
  try {
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 } })
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      const relative = url.pathname.replace(/^\//, '') || 'index.html'
      if (url.hostname !== 'fixture.local' || !/^(?:index\.html|assets\/[A-Za-z0-9_.-]+)$/.test(relative))
        return route.abort()
      const file = path.join(root, 'out/renderer', relative)
      return route.fulfill({
        body: fs.readFileSync(file),
        contentType: relative.endsWith('.js')
          ? 'application/javascript'
          : relative.endsWith('.css')
            ? 'text/css'
            : 'text/html; charset=utf-8'
      })
    })
    await context.addInitScript((config) => {
      const now = Date.now(),
        callbacks = {},
        url = 'https://live.douyin.com/10000001'
      const empty = {
        participated: 0,
        physicalWins: 0,
        diamondWins: 0,
        diamondWonAmount: 0,
        couponWins: 0,
        submittedUnknown: 0,
        unknownResults: 0,
        lastStartedAt: null,
        lastStoppedAt: null
      }
      const session = {
        phase: 'stopped',
        policy: config.policy,
        nextResumeAt: null,
        hardStopAt: null,
        activeByDay: {},
        startedAt: null,
        reason: '',
        drainAt: null,
        stopAt: null,
        lastTickAt: null,
        seed: 1
      }
      const fixture = (window.__fixture = {
        loggedIn: false,
        config,
        calls: {},
        rejectSave: false,
        rejectRoom: false,
        rejectRoomChange: false,
        releaseStart: null,
        releaseStop: null,
        totals: { ...empty },
        rooms: [],
        state: {
          running: false,
          status: 'stopped',
          candidates: [],
          candidateCount: 0,
          pendingVerifyCount: 0,
          session,
          resumeRemainingSeconds: null
        },
        insights: {
          rooms: [],
          rounds: [],
          payments: [],
          risks: [],
          decisions: [],
          session,
          budget: {
            spent: 7,
            reserved: 0,
            awards: 0,
            credit: 0,
            effective: 10,
            remaining: 3,
            dailyRemaining: 5
          },
          metrics: {
            visits: 0,
            confirmed: 0,
            reuse: 0,
            unknown: 0,
            reusePerPayment: 0,
            costPerRound: 0,
            activeMinutes: 0
          },
          legacy: {}
        }
      })
      const copy = (value) => JSON.parse(JSON.stringify(value))
      const count = (key) => {
        fixture.calls[key] = (fixture.calls[key] || 0) + 1
      }
      const emit = (key, value) => (callbacks[key] || []).forEach((fn) => fn(copy(value)))
      fixture.emit = emit
      fixture.phase = (phase) => {
        if (['stopped', 'blocked'].includes(phase)) {
          fixture.state.candidates = []
          fixture.state.candidateCount = 0
          fixture.state.pendingVerifyCount = 0
        }
        fixture.state.status = phase
        fixture.state.running = ['running', 'draining', 'resting', 'resume-check'].includes(phase)
        fixture.state.session = {
          ...session,
          policy: fixture.config.policy,
          phase,
          hardStopAt: now + 1800000,
          nextResumeAt: phase === 'resting' ? now + 600000 : null
        }
        fixture.state.resumeRemainingSeconds = phase === 'resting' ? 600 : null
        fixture.insights.session = fixture.state.session
        emit('auto-run:update', fixture.state)
      }
      fixture.populate = () => {
        fixture.totals = {
          ...empty,
          participated: 18,
          physicalWins: 1,
          diamondWins: 2,
          diamondWonAmount: 12,
          unknownResults: 1
        }
        fixture.rooms = [
          {
            id: 'fixture-room',
            url,
            name: '示例生活好物直播间',
            status: 'monitoring',
            phase: '等待开奖',
            timeline: {stage:'draw',startedAt:now-14000,endsAt:now+86000,remainingSeconds:86,taskAt:now-45000,drawAt:now+86000,nextUntil:null},
            fudaiCount: 1,
            hasFanBadge: true,
            remainingSeconds: 86,
            drawAt: now + 86000,
            countdownText: '1:26'
          }
        ]
        fixture.state.candidateCount = 2
        fixture.state.pendingVerifyCount = 3
        fixture.state.candidates = [
          { url: url + '2', name: '示例数码好物', lotteryId:'next-1',cost:0,verifiedAt:now-145000,startAt:now+155000,taskAt:now+200000,drawAt:now+245000,score: 0.2, remainingSeconds: 245, entryRemainingSeconds:155, probability: null },
          { url: url + '3', name: '示例家居直播', lotteryId:'next-2',cost:1,verifiedAt:now-110000,startAt:now+390000,taskAt:now+435000,drawAt:now+480000,score: 0.3, remainingSeconds: 480, entryRemainingSeconds:390, probability: 0.02 }
        ]
        fixture.insights.rooms = Array.from({ length: 18 }, (_, i) => ({
          url: i ? url + i : url,
          name: i ? `示例直播间 ${i + 1}` : '示例生活好物直播间',
          source: 'discovery',
          favorite: i < 2,
          blocked: i === 17,
          allowPaid: i < 3,
          lastSeenAt: now - i * 1000,
          nextEligibleCheckAt: now + 300000,
          membership: i < 3 ? 'satisfied' : 'unknown',
          visits: [{ at: now, found: true }],
          observations: [],
          membershipAt: now,
          failures: 0,
          everPaid: i < 3
        }))
        fixture.insights.rounds = [
          {
            key: 'fixture-round',
            lotteryId: 'bag-1',
            roomUrl: url,
            createdAt: now - 600000,
            drawAt: now - 400000,
            submittedAt: now - 500000,
            confirmedAt: now - 499000,
            result: 'won',
            prizeType: 'diamond',
            diamondAmount: 6,
            updatedAt: now,
            taskSeconds: 8,
            claimDueAt: null,
            claimed: false
          }
        ]
        fixture.insights.payments = [
          {
            id: 'fixture-payment',
            roundKey: 'fixture-round',
            roomUrl: url,
            cost: 1,
            newClub: true,
            at: now - 600000,
            state: 'confirmed'
          }
        ]
        fixture.insights.metrics = {
          visits: 22,
          confirmed: 18,
          reuse: 0.66,
          unknown: 1,
          reusePerPayment: 3,
          costPerRound: 0.17,
          activeMinutes: 36
        }
        emit('run-stats:update', fixture.totals)
        fixture.insights.reports=[{id:'live',startedAt:now-720000,endedAt:null,activeMs:720000,reason:'',source:'首页',budgetCycle:0,confirmed:4,won:1,lost:2,unknown:0,pending:1,spent:1,reserved:0,skipReasons:{}}]
        fixture.insights.rounds.push({key:'current',roomUrl:url,lotteryId:'current',createdAt:now-34000,drawAt:now+86000,confirmedAt:now-20000,result:'pending',budgetCycle:0})
        fixture.rooms.forEach((room) => emit('room:update', room))
        emit('auto-run:update', fixture.state)
        emit('log:add', {
          time: now,
          roomId: 'auto',
          message: '示例数据：验证通过，接管当前直播间并等待开奖。'
        })
      }
      window.api = {
        auth: {
          status: async (force = false) => {
            const mode = new URL(location.href).searchParams.get('auth')
            if (force && mode === 'unknown') fixture.loggedIn = true
            return { isLoggedIn: fixture.loggedIn, state: fixture.loggedIn ? 'connected' : mode || 'signed-out', checkedAt: null }
          },
          login: async () => {
            count('login')
            fixture.loggedIn = true
            return { success: true, isLoggedIn: true }
          },
          logout: async () => {
            fixture.loggedIn = false
            fixture.phase('stopped')
            fixture.rooms = []
            return { success: true }
          }
        },
        config: {
          get: async () => copy(fixture.config),
          resetDiamondUsed: async () => {
            count('budgetReset')
            fixture.config.diamondUsed=0
            Object.assign(fixture.insights.budget,{spent:0,lifetimeSpent:7,hasActivity:false,credit:0,remaining:fixture.config.diamondBudget,dailyRemaining:fixture.config.policy.dailySpend})
            return {success:true,config:copy(fixture.config)}
          },
          set: async (patch) => {
            // Match the IPC boundary: JSON copying would silently hide Vue Proxy errors.
            const serialized = structuredClone(patch)
            count('save')
            if (fixture.rejectSave) return { success: false, error: '模拟保存失败，请重试' }
            Object.assign(fixture.config, serialized)
            fixture.insights.budget.effective = fixture.config.diamondBudget
            fixture.insights.budget.remaining = Math.max(0, fixture.config.diamondBudget - 7)
            return { success: true, config: copy(fixture.config) }
          }
        },
        stats: {
          get: async () => ({
            totalFudai: fixture.totals.participated,
            activeRooms: fixture.rooms.length,
            diamondUsed: 7,
            diamondReserved: 0,
            diamondRemaining: Math.max(0, fixture.config.diamondBudget - 7),
            diamondBudget: fixture.config.diamondBudget
          })
        },
        runStats: {
          get: async () => copy(fixture.totals),
          reset: async () => {
            fixture.totals = { ...empty }
            return copy(fixture.totals)
          }
        },
        room: {
          list: async () => copy(fixture.rooms),
          add: async () => {
            count('addRoom')
            return fixture.rejectRoom
              ? { success: false, error: '模拟验证失败，输入应保留' }
              : {
                  success: true,
                  room: {
                    id: 'manual',
                    url,
                    name: '手动测试房间',
                    status: 'monitoring',
                    remainingSeconds: 100,
                    drawAt: now + 100000,
                    fudaiCount: 0,
                    hasFanBadge: false
                  }
                }
          },
          remove: async (id) => {
            fixture.rooms = fixture.rooms.filter((room) => room.id !== id)
            emit('room:removed', id)
            return { success: true }
          }
        },
        alerts:{dismiss:async(id)=>{count('dismissAlert');fixture.insights.alerts=(fixture.insights.alerts||[]).filter(n=>n.id!==id);emit('alerts:update',fixture.insights.alerts);return {success:true}}},
        autoRun: {
          extend:async(minutes,stopAt)=>{count('extend');if(stopAt!==fixture.state.stopAt)return {success:false,error:'stale'};fixture.state.stopAt+=minutes*60000;fixture.state.session.stopAt=fixture.state.stopAt;return {success:true,state:copy(fixture.state)}},
          finish:async()=>{count('finish');fixture.phase('draining');fixture.state.session.finishRequested=true;return {success:true,state:copy(fixture.state)}},
          skip:async(url,id,today)=>{count(today?'skipToday':'skipRound');fixture.state.candidates=fixture.state.candidates.filter(c=>c.url!==url);return {success:true,state:copy(fixture.state)}},
          status: async () => copy(fixture.state),
          start: async () => {
            count('start')
            await new Promise((resolve) => {
              fixture.releaseStart = resolve
            })
            fixture.phase('running')
            return { success: true, state: copy(fixture.state) }
          },
          stop: async () => {
            count('stop')
            await new Promise((resolve) => {
              fixture.releaseStop = resolve
            })
            fixture.phase('stopped')
            fixture.rooms = []
            return { success: true, state: copy(fixture.state) }
          }
        },
        insights: {
          openClaim:async()=>{count('openClaim');return {success:true}},
          claim:async(key,claimed)=>{count('claim');fixture.insights.rounds.find(r=>r.key===key).claimed=claimed;return {success:true}},
          get: async () => (fixture.loggedIn ? copy(fixture.insights) : null),
          room: async (roomUrl, patch) => {
            fixture.lastRoomPatch = copy(patch)
            if (fixture.rejectRoomChange) return { success: false, error: '模拟房间设置保存失败' }
            Object.assign(
              fixture.insights.rooms.find((room) => room.url === roomUrl),
              patch
            )
            return { success: true }
          },
          payment: async (id, state) => {
            fixture.insights.payments.find((p) => p.id === id).state = state
            return { success: true }
          },
          openRisk: async () => {count('openRisk');return {success:true}},
          resolveRisk: async () => {
            count('resolveRisk')
            if(fixture.riskError)return {success:false,error:fixture.riskError}
            fixture.insights.risks.forEach((r) => {
              r.resolvedAt = now
            })
            fixture.phase('stopped')
            return { success: true }
          },
          export: async () => ({ success: false, error: '已取消导出' })
        },
        on: (key, fn) => {
          ;(callbacks[key] ||= []).push(fn)
          return () => {
            callbacks[key] = callbacks[key].filter((value) => value !== fn)
          }
        }
      }
    }, config)
    const page = await context.newPage()
    page.setDefaultTimeout(12000)
    page.on('pageerror', (error) => errors.push(error.message))
    const nav = (name) =>
      page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true })
    await page.goto('http://fixture.local/')
    await page.getByRole('heading', { name: '先连接你的抖音账号' }).waitFor()
    check(
      (await page.getByRole('button', { name: '登录抖音', exact: true }).count()) === 2,
      'sign-in has a clear primary entry'
    )
    await page.screenshot({ path: path.join(output, 'ui-overview-empty.png'), fullPage: true })
    await nav('策略设置').click()
    await page.getByRole('button', { name: '支出与粉丝团', exact: true }).click()
    await page.getByLabel('总钻石预算', { exact: true }).fill('12')
    await nav('运行面板').click()
    await page.getByRole('button', { name: '登录抖音', exact: true }).last().click()
    await page.getByRole('heading', { name: '准备好，开始下一轮' }).waitFor()
    check(
      await page.getByRole('button', { name: '开始运行', exact: true }).isDisabled(),
      'unsaved settings prevent ambiguous start'
    )
    await nav('策略设置').click()
    check(
      (await page.getByLabel('总钻石预算', { exact: true }).inputValue()) === '12',
      'draft survives navigation and login refresh'
    )
    await page.evaluate(() => {
      window.__fixture.rejectSave = true
    })
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await page.getByText('保存未成功，草稿已保留。请查看上方提示后重试。').waitFor()
    check(
      (await page.getByLabel('总钻石预算', { exact: true }).inputValue()) === '12',
      'save failure keeps draft'
    )
    await page.evaluate(() => {
      window.__fixture.rejectSave = false
    })
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await page.getByText('已保存，下次运行生效', { exact: true }).waitFor()
    check(
      (await page.evaluate(() => window.__fixture.config.diamondBudget)) === 12,
      'saved values come from successful IPC'
    )
    check(
      (await page.getByText('模拟保存失败，请重试', { exact: true }).count()) === 0,
      'successful retry clears the stale save error'
    )
    await page.getByRole('button', { name: '运行与休息', exact: true }).click()
    await page.getByLabel('单段运行最短（分钟）').fill('60')
    const savesBefore = await page.evaluate(() => window.__fixture.calls.save)
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await page.getByText('最短时间不能大于最长时间。').waitFor()
    check(
      (await page.evaluate(() => window.__fixture.calls.save)) === savesBefore,
      'invalid ranges do not reach IPC'
    )
    await page.getByRole('button', { name: '还原更改', exact: true }).click()
    await page.getByRole('button', { name: '参与偏好', exact: true }).click()
    await page.screenshot({ path: path.join(output, 'ui-settings.png'), fullPage: true })
    await nav('运行面板').click()
    await page.getByRole('button', { name: '开始运行', exact: true }).click()
    check(
      await page.getByRole('button', { name: '正在启动…', exact: true }).isDisabled(),
      'pending start disables repeated submission'
    )
    check((await page.evaluate(() => window.__fixture.calls.start)) === 1, 'one start request')
    await page.evaluate(() => window.__fixture.releaseStart())
    await page.getByRole('button', { name: '立即停止', exact: true }).waitFor()
    await page.evaluate(() => window.__fixture.populate())
    await page.getByText('示例生活好物直播间', { exact: true }).waitFor()
    await page.evaluate(()=>{const f=window.__fixture;f.originalCandidateName=f.state.candidates[0].name;f.state.candidates[0].name=f.state.candidates[0].url;f.emit('auto-run:update',f.state)})
    check(/^直播间 \d+$/.test(await page.locator('.reservation-heading h3').first().textContent()),'unnamed candidate uses room ID instead of URL')
    await page.locator('.reservation-details summary').first().click()
    check(await page.locator('.reservation-details .room-address').first().isVisible(),'full candidate URL remains in expanded details')
    await page.locator('.reservation-details summary').first().click()
    await page.evaluate(()=>{const f=window.__fixture;f.state.candidates[0].name=f.originalCandidateName;f.emit('auto-run:update',f.state)})

    await page.getByRole('region',{name:'运行数据',exact:true}).getByText('活跃 12.0 分钟',{exact:true}).waitFor()
    check(!(await page.locator('#run-plan').isVisible()),'running defaults to compact controls and hidden strategy')
    check(await page.getByRole('button',{name:'立即停止',exact:true}).isVisible(),'immediate stop is always visible when strategy is collapsed')
    check((await page.getByRole('progressbar',{name:'示例数码好物 距离返房进度',exact:true}).getAttribute('aria-valuenow'))==='48','return progress follows pushed countdown')
    await page.waitForTimeout(1100)
    check((await page.getByRole('progressbar',{name:'示例数码好物 距离返房进度',exact:true}).getAttribute('aria-valuenow'))==='48','renderer does not decrement its own timer')
    await page.getByRole('button',{name:'查看策略',exact:true}).click()
    check(await page.locator('#run-plan').isVisible(),'strategy can be expanded during a run')
    await page.getByRole('button',{name:'收起策略',exact:true}).click()
    await page.locator('.app-notice.success').waitFor({state:'hidden'})
    await page.screenshot({ path: path.join(output, 'ui-overview-running.png'), fullPage: true })
    check((await page.locator('.room-timeline [aria-current="step"] strong').textContent())==='开奖与核对','phase highlight follows main-process draw stage')
    check((await page.getByRole('progressbar',{name:'开奖与核对',exact:true}).getAttribute('aria-valuenow'))==='14','draw progress uses its own confirmed-to-draw interval')
    await page.evaluate(()=>{const f=window.__fixture;f.savedTimeline={...f.rooms[0].timeline};f.rooms[0].phase='等待评论反馈';f.rooms[0].timeline={...f.savedTimeline,stage:'prepare',endsAt:null,remainingSeconds:null};f.emit('room:update',f.rooms[0])})
    check((await page.getByRole('progressbar',{name:'准备任务',exact:true}).getAttribute('aria-valuenow'))===null,'unknown task completion duration has no fabricated percentage')
    await page.screenshot({path:path.join(output,'ui-task-preparing.png'),fullPage:true})
    await page.evaluate(()=>{const f=window.__fixture;const now=Date.now();f.rooms[0].phase='等待下一轮福袋';f.rooms[0].timeline={...f.savedTimeline,stage:'next',startedAt:now-10000,endsAt:now+20000,remainingSeconds:20,nextUntil:now+20000};f.emit('room:update',f.rooms[0])})
    check((await page.locator('.room-timeline [aria-current="step"] strong').textContent())==='观察续轮','next-round observation activates its own segment')
    check((await page.locator('.room-timeline .done').count())===2,'completed phases fill only their own segments')
    await page.screenshot({path:path.join(output,'ui-task-next-round.png'),fullPage:true})
    await page.evaluate(()=>{const f=window.__fixture;f.rooms[0].phase='等待开奖';f.rooms[0].timeline=f.savedTimeline;f.emit('room:update',f.rooms[0])})

    await page.evaluate(()=>{
      const f=window.__fixture;f.savedCandidates=JSON.parse(JSON.stringify(f.state.candidates))
      f.state.candidates[0].entryRemainingSeconds=75;f.phase('running')
    })
    check((await page.getByRole('progressbar',{name:'示例数码好物 距离返房进度',exact:true}).getAttribute('aria-valuenow'))==='75','new main-process countdown advances return progress')
    await page.evaluate(()=>{
      const f=window.__fixture;f.state.candidates=JSON.parse(JSON.stringify(f.savedCandidates))
      for(let i=0;i<3;i++)f.state.candidates.push({...f.savedCandidates[1],url:'https://live.douyin.com/'+(90000001+i),lotteryId:'extra-'+i,name:i===0?'很长的直播间名称用于验证布局换行与预约列表的可读性：家居生活好物分享专场':'后续预约房间 '+(i+1),cost:i===0?null:0,verifiedAt:i===0?undefined:f.savedCandidates[1].verifiedAt})
      f.state.candidateCount=5;f.phase('running')
    })
    check((await page.locator('.reservation').count())===5,'all five reservations remain individually legible')
    check((await page.locator('.reservation').nth(2).getByRole('progressbar').count())===0,'unknown timing has no fabricated progress')
    await page.setViewportSize({width:390,height:844})
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'five long-name candidates fit a narrow viewport')
    await page.screenshot({path:path.join(output,'ui-running-mobile.png'),fullPage:true})
    await page.setViewportSize({width:1180,height:820})
    await page.getByLabel('界面语言').selectOption('en-US')
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'running dashboard fits English labels')
    await page.screenshot({path:path.join(output,'ui-running-english.png'),fullPage:true})
    await page.getByLabel('Interface language').selectOption('zh-CN')
    await page.evaluate(()=>{const f=window.__fixture;f.state.candidates=f.savedCandidates;f.state.candidateCount=2;f.phase('running')})
    await page.evaluate(()=>{
      const f=window.__fixture
      f.emit('log:add',{roomId:f.rooms[0].id,roomName:'离房后仍可搜索的房间',message:'离线结算记录',time:Date.now()})
      f.savedRooms=f.rooms
      f.rooms.forEach(r=>f.emit('room:removed',r.id));f.rooms=[]
      f.state.waitingReason='等待候选预约进房，暂不验证其他房间'
      f.phase('running')
    })
    check(await page.getByRole('heading',{name:'等待候选预约进房，暂不验证其他房间',exact:true}).isVisible(),'empty room shows reservation wait rather than exploration')
    await page.evaluate(()=>window.__fixture.phase('resting'))
    check(await page.locator('.empty-state').getByRole('heading',{name:'计划休息中',exact:true}).isVisible(),'empty room shows planned rest')
    await page.evaluate(()=>{const f=window.__fixture;f.state.session.stopAt=f.state.session.nextResumeAt-60000;f.emit('auto-run:update',f.state)})
    check(await page.locator('.empty-state').getByRole('heading',{name:'等待定时结束',exact:true}).isVisible(),'terminal wait is distinct from planned rest')
    check((await page.locator('.control-deadline').textContent()).includes('定时结束'),'terminal wait shows stop time instead of resume countdown')
    check(await page.getByText('本轮已完成，等待定时结束',{exact:true}).first().isVisible(),'terminal wait explains no further round is expected')
    await page.screenshot({path:path.join(output,'ui-waiting-scheduled-stop.png'),fullPage:true})
    await page.evaluate(()=>window.__fixture.phase('resting'))

    await page.evaluate(()=>{
      const f=window.__fixture;f.rooms=f.savedRooms;f.rooms.forEach(r=>f.emit('room:update',r));f.state.waitingReason='';f.phase('running')
    })
    await nav('策略设置').click()
    check(
      await page.getByRole('radio', { name: /参与机会/ }).isDisabled(),
      'settings are locked during a run'
    )
    await page.getByLabel('界面语言').selectOption('en-US')
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
    check(
      await page.getByRole('button', { name: 'Save settings', exact: true }).isDisabled(),
      'English labels retain the running lock'
    )
    await page.getByLabel('Interface language').selectOption('zh-CN')
    await nav('运行面板').click()
    await page.evaluate(() => window.__fixture.phase('resting'))
    check(
      await page.getByRole('heading', { name: '计划休息中', exact: true }).isVisible(),
      'planned break is distinct from running'
    )
    check(
      await page.getByText('10:00', { exact: true }).isVisible(),
      'resume countdown uses main-process value'
    )
    await page.getByRole('button', { name: '立即停止', exact: true }).click()
    check(
      await page.getByRole('button', { name: '正在停止…', exact: true }).isDisabled(),
      'stop waits for acknowledgement'
    )
    check(
      (await page.getByRole('button', { name: '开始运行', exact: true }).count()) === 0,
      'no premature stopped state'
    )
    await page.evaluate(() => window.__fixture.releaseStop())
    await page.getByRole('button', { name: '开始运行', exact: true }).waitFor()
    await page.getByRole('button', { name: '手动参与', exact: true }).click()
    await page.getByLabel('直播间地址', { exact: true }).fill('https://example.com/room')
    await page.getByRole('button', { name: '验证并参与', exact: true }).click()
    check(
      (await page.getByRole('dialog').getByRole('alert').count()) === 1,
      'invalid room URL is reported inside the dialog'
    )
    await page.getByLabel('直播间地址', { exact: true }).fill('https://live.douyin.com/10000001')
    await page.evaluate(() => {
      window.__fixture.rejectRoom = true
    })
    await page.getByRole('button', { name: '验证并参与', exact: true }).click()
    await page.getByRole('dialog').getByText('模拟验证失败，输入应保留').waitFor()
    check(
      (await page.getByLabel('直播间地址', { exact: true }).inputValue()) ===
        'https://live.douyin.com/10000001',
      'failed room add preserves input'
    )
    await page.keyboard.press('Escape')
    check((await page.getByRole('dialog').count()) === 0, 'Escape dismisses the idle dialog')
    check(
      await page.evaluate(() => document.activeElement.textContent.includes('手动参与')),
      'dialog restores keyboard focus to the trigger'
    )
    await nav('房间库').click()
    await page.getByText('示例生活好物直播间', { exact: true }).waitFor()
    check((await page.locator('.room-history-row').count()) === 15, 'room library is paginated')
    await page.evaluate(() => {
      window.__fixture.rejectRoomChange = true
    })
    const block = page.getByRole('button', { name: '示例生活好物直播间 屏蔽', exact: true })
    check((await page.locator('.room-library input[type=checkbox]').count())===0,'room library removes manual permission and favorite switches')
    await block.click()
    await page.getByText('模拟房间设置保存失败', { exact: true }).waitFor()
    check(await block.isVisible(), 'failed block leaves persisted room state unchanged')
    check(JSON.stringify(await page.evaluate(()=>window.__fixture.lastRoomPatch))===JSON.stringify({blocked:true}),'room action only changes blocking')
    await page.evaluate(() => {
      window.__fixture.rejectRoomChange = false
    })
    await page.getByRole('button', { name: '关闭提示', exact: true }).click()
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    check((await page.locator('.room-history-row').count()) === 3, 'room library next page works')
    await page.getByLabel('搜索房间', { exact: true }).fill('生活')
    check((await page.locator('.room-history-row').count()) === 1, 'search filters and resets pagination')
    await block.click()
    await page.getByRole('button',{name:'示例生活好物直播间 取消屏蔽',exact:true}).waitFor()
    check((await page.evaluate(()=>window.__fixture.insights.rooms[0].allowPaid))===true,'blocking preserves historical payment permission')
    await page.getByRole('button',{name:'示例生活好物直播间 取消屏蔽',exact:true}).click()
    await block.waitFor()
    await page.locator('.room-history-detail summary').click()
    check(await page.getByText('上次观察到的资格',{exact:true}).isVisible(),'room eligibility is clearly historical')
    await page.getByLabel('搜索房间', { exact: true }).fill('')
    await page.getByLabel('搜索房间', { exact: true }).blur()
    if(await page.getByRole('button',{name:'关闭提示',exact:true}).isVisible())await page.getByRole('button',{name:'关闭提示',exact:true}).click()
    await page.evaluate(()=>window.scrollTo(0,0))
    await page.screenshot({ path: path.join(output, 'ui-library.png') })
    await page.evaluate(() => {
      window.__fixture.insights.payments[0].state = 'unresolved'
      window.__fixture.insights.budget.spent = 6
      window.__fixture.insights.budget.reserved = 1
      window.__fixture.insights.risks = [
        { at: Date.now(), reason: '模拟安全验证提示', source: 'offline-fixture', resolvedAt: null }
      ]
      window.__fixture.phase('blocked')
    })
    await nav('运行记录').click()
    await page.getByRole('heading', { name: '异常待办', exact: true }).waitFor({ timeout: 8000 })
    await nav('运行面板').click()
    check(
      await page.getByRole('button', { name: '手动参与', exact: true }).isDisabled(),
      'risk hold also disables the manual entry point'
    )
    await nav('运行记录').click()
    check(
      await page.getByRole('button', { name: '已处理，检查并完成', exact: true }).isDisabled(),
      'unresolved charges keep risk resolution disabled'
    )
    await page.getByRole('button',{name:'前往浏览器处理',exact:true}).click()
    check((await page.evaluate(()=>window.__fixture.calls.openRisk))===1,'issue todo exposes the manual browser action')
    await page.evaluate(()=>{
      const f=window.__fixture
      f.insights.payments[0].state='failed'
      f.riskError='页面仍显示验证或异常，请完成后再检查'
      f.emit('alerts:update',[{id:'risk-ui',kind:'risk',title:'异常待办需要处理',message:'fixture',at:Date.now(),dismissedAt:null}])
    })
    await nav('运行面板').click()
    await nav('运行记录').click()
    check(await page.locator('.alert-toast').count()===0,'risk notification never overlays issue actions on records page')
    await page.getByRole('button',{name:'已处理，检查并完成',exact:true}).click()
    check(await page.locator('.review-row [role="status"]').getByText('页面仍显示验证或异常，请完成后再检查',{exact:true}).isVisible(),'failed review displays actionable feedback next to issue')
    check((await page.evaluate(()=>window.__fixture.insights.risks[0].resolvedAt))===null,'failed review keeps risk unresolved')
    check((await page.evaluate(()=>window.__fixture.calls.resolveRisk))===1,'completion button dispatches exactly once without forcing click')
    await page.evaluate(()=>{window.__fixture.insights.payments[0].state='unresolved';delete window.__fixture.riskError})
    await nav('运行面板').click()
    await nav('运行记录').click()
    await page.getByRole('button', { name: '核实未扣款', exact: true }).click()
    check(await page.getByRole('dialog').isVisible(), 'reconciliation requires an explicit review dialog')
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
    check(
      (await page.evaluate(() => window.__fixture.insights.payments[0].state)) === 'unresolved',
      'cancelling reconciliation leaves the ledger unchanged'
    )
    await page.getByRole('button',{name:'支出账本',exact:true}).click()
    check(await page.locator('.payment-table').getByText('支付待核对',{exact:true}).isVisible(),'unresolved payments are not labelled successful')
    check(await page.locator('.payment-table').getByText('仍占用预算',{exact:true}).isVisible(),'pending charges still visibly occupy budget')
    await page.getByRole('button',{name:'参与记录',exact:true}).click()
    await page.screenshot({ path: path.join(output, 'ui-records-review.png'), fullPage: true })
    await nav('运行日志').click()
    await page.evaluate(()=>{const f=window.__fixture;f.emit('log:add',{roomId:'system',time:Date.now(),message:'较早测试事件'});f.emit('log:add',{roomId:'system',time:Date.now(),message:'最新测试事件'})})
    check((await page.locator('.log-line p').first().textContent())==='最新测试事件','newest log is first even when timestamps match')
    check(await page.getByLabel('跟随最新',{exact:true}).isChecked(),'log follows the newest events by default')

    await page.getByLabel('搜索日志',{exact:true}).fill('离房后仍可搜索的房间')
    check(await page.getByText('离线结算记录',{exact:true}).isVisible(),'log name survives room removal and remains searchable')
    await page.getByLabel('搜索日志', { exact: true }).fill('不存在')
    check(
      await page.getByRole('heading', { name: '没有匹配的日志' }).isVisible(),
      'log search has a useful empty state'
    )
    for (const size of [
      { width: 800, height: 600 },
      { width: 390, height: 844 }
    ]) {
      await page.setViewportSize(size)
      for (const destination of ['运行面板', '策略设置', '房间库', '运行记录', '运行日志']) {
        await nav(destination).click()
        check(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `no page overflow at ${size.width}px: ${destination}`
        )
        if(size.width===390 && ['房间库','运行记录'].includes(destination)){
          await page.evaluate(()=>window.scrollTo(0,0))
          await page.screenshot({path:path.join(output, destination==='房间库'?'ui-library-mobile.png':'ui-records-mobile.png'),fullPage:true})
        }
      }
      await nav('运行面板').click()
      await page.screenshot({ path: path.join(output, `ui-narrow-${size.width}.png`), fullPage: true })
    }
    await page.setViewportSize({width:1180,height:820})
    await page.goto('https://fixture.local/?auth=unknown')
    await page.getByRole('heading',{name:'暂时无法验证登录状态'}).waitFor()
    check(await page.getByText('已保留原登录信息。', {exact:false}).isVisible(), 'unknown retains saved login and explains retry')
    await page.getByRole('button',{name:'重新校验',exact:true}).click()
    await page.getByText('已连接',{exact:true}).waitFor()
    check(!(await page.evaluate(()=>window.__fixture.calls.login)), 'background retry does not open manual login')
    await nav('策略设置').click()
    await page.getByRole('button',{name:'支出与粉丝团',exact:true}).click()
    await page.getByRole('button',{name:'重置本轮预算',exact:true}).click()
    await page.getByRole('dialog').waitFor()
    check(await page.getByRole('dialog').getByText('每日已用同时归零',{exact:false}).isVisible(),'budget reset explains daily allowance')
    await page.screenshot({path:path.join(output,'ui-budget-reset.png'),fullPage:true})
    await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click()
    check(!(await page.evaluate(()=>window.__fixture.calls.budgetReset)),'cancel keeps budget unchanged')
    await page.getByRole('button',{name:'重置本轮预算',exact:true}).click()
    await page.getByRole('dialog').getByRole('button',{name:'确认重置预算',exact:true}).click()
    await page.getByRole('dialog').waitFor({state:'hidden'})
    check((await page.evaluate(()=>window.__fixture.calls.budgetReset))===1,'budget reset dispatches once')
    check(await page.getByRole('button',{name:'重置本轮预算',exact:true}).isDisabled(),'empty budget cycle cannot be reset twice')
    check(await page.getByText('当前预算轮次尚无参与或支付记录，无需重复重置。',{exact:true}).isVisible(),'disabled empty reset explains why')
    check(await page.getByText('本轮已用 0 · 累计支出 7',{exact:false}).isVisible(),'cycle and lifetime totals remain distinguishable')
    await nav('策略设置').click()
    await page.getByRole('button',{name:'参与偏好',exact:true}).click()
    const budgetBefore=await page.evaluate(()=>window.__fixture.config.diamondBudget)
    check(await page.getByRole('button',{name:'实物优先（暂不可用）',exact:true}).isDisabled(),'physical preset disabled')
    check(await page.getByLabel('实物福袋',{exact:true}).isDisabled(),'physical type disabled')
    check(await page.locator('input[name="objective"][value="physical"]').isDisabled(),'physical objective disabled')
    await page.getByRole('button',{name:'钻石优先',exact:true}).click()
    await page.getByRole('button',{name:'保存设置',exact:true}).click()
    await page.getByText('已保存，下次运行生效',{exact:true}).waitFor()
    check((await page.evaluate(()=>window.__fixture.config.diamondBudget))===budgetBefore,'presets preserve budget')
    check((await page.evaluate(()=>window.__fixture.config.fudaiTypes.diamond))===true,'available preset updates preferences')
    check((await page.evaluate(()=>window.__fixture.config.fudaiTypes.physical))===false,'available preset does not enable physical prizes')
    await page.evaluate(()=>{
      const f=window.__fixture,n=Date.now(),u='https://live.douyin.com/10000001'
      f.insights.rounds=Array.from({length:320},(_,i)=>({key:`round-${i}`,roomUrl:u,lotteryId:`lottery-${i}`,createdAt:n-i*1000,drawAt:n-i*1000,confirmedAt:n-i*1000,result:i===319?'won':'lost',prizeType:i===319?'physical':null,prizeName:i===319?'离线实物奖品':null,claimed:false,budgetCycle:0,claimDueAt:null}))
      f.insights.reports=[{id:'run',startedAt:n-120000,endedAt:n,activeMs:60000,reason:'定时停止',source:'首页',budgetCycle:0,confirmed:3,won:1,lost:1,unknown:1,pending:0,spent:1,reserved:0,skipReasons:{'任务无法完成':2}}]
      f.insights.cycles=[{cycle:0,spent:7,reserved:0,confirmed:320}]
      f.insights.alerts=[{id:'claim:round-319',kind:'claim',title:'实物中奖，待填写领取信息',message:'离线测试提醒',at:n,dismissedAt:null}]
    })
    await nav('运行记录').click()
    await page.getByText('离线实物奖品',{exact:false}).first().waitFor({timeout:8000})
    check(await page.getByText('领取期限未识别，请在抖音确认',{exact:false}).isVisible(),'claim deadline is not invented')
    await page.getByRole('button',{name:'打开直播间查看',exact:true}).click()
    check((await page.evaluate(()=>window.__fixture.calls.openClaim))===1,'claim link uses explicit user action')
    await page.getByRole('button',{name:'已完成领取信息处理',exact:true}).click()
    await page.getByText('暂无待处理奖励',{exact:true}).waitFor()
    check((await page.evaluate(()=>window.__fixture.insights.rounds[319].claimed))===true,'claim completion is persisted')
    await page.getByLabel('记录状态',{exact:true}).selectOption('won')
    check((await page.getByRole('row').count())===2,'result filter reaches records beyond 300')
    check(await page.getByText('共 1 条',{exact:true}).isVisible(),'filtered count is accurate')
    await page.getByText('预算轮次历史',{exact:true}).click()
    check(await page.getByText('支出 7 钻 / 预留 0 钻',{exact:true}).isVisible(),'budget cycle history is visible')
    await page.locator('.report-archive > summary').click()
    await page.locator('.run-report summary').click()
    check(await page.locator('.report-facts').getByText('活跃 1.0 分钟',{exact:true}).isVisible(),'run report separates active time')
    check(await page.locator('.report-facts').getByText('未知 1',{exact:true}).isVisible(),'report retains unknown results')
    await page.evaluate(()=>window.scrollTo(0,0))
    await page.screenshot({path:path.join(output,'ui-product-review.png'),fullPage:true})
    await page.getByLabel('记录状态',{exact:true}).selectOption('')
    await page.evaluate(()=>{
      const f=window.__fixture
      f.insights.rounds[0].runId='run'
      f.insights.rounds[319].runId='run'
      f.insights.decisions=[{at:Date.now(),url:f.insights.rounds[0].roomUrl,action:'skip',reason:'剩余时间不足以完成任务',score:null,probability:null},{at:Date.now()-60000,url:f.insights.rounds[0].roomUrl,action:'candidate',reason:'任务可完成，已加入预约队列',score:0.2,probability:0.02}]
      f.insights.payments=[{id:'scope-payment',runId:'run',roomUrl:f.insights.rounds[0].roomUrl,roundKey:'round-0',at:Date.now(),cost:1,newClub:false,state:'confirmed'}]
    })
    await nav('房间库').click();await nav('运行记录').click()
    await page.getByLabel('运行范围',{exact:true}).selectOption('run')
    await page.waitForFunction(()=>document.querySelectorAll('.data-surface tbody tr').length===2)
    check((await page.getByRole('row').count())===3,'selected run includes only persisted ownership including late reward')
    check((await page.locator('.entry-confirmation').filter({hasText:'已确认参与'}).count())===2,'entry rows separate confirmation from draw result')
    check((await page.locator('.entry-table .cell-title').first().innerText())==='直播间 10000001','missing room name uses readable ID instead of raw URL')
    await page.locator('.entry-table .record-evidence summary').first().click()
    check(await page.locator('.entry-table').getByText('福袋编号',{exact:true}).first().isVisible(),'submission timestamps and bag identity remain in details')
    await page.locator('.entry-table .record-evidence summary').first().click()

    check((await page.locator('.record-headline strong').first().innerText())==='2','run summary follows the selected scope')
    await page.getByRole('button',{name:'支出账本',exact:true}).click()
    check((await page.getByRole('row').count())===2,'payment tab preserves run scope')
    check(await page.locator('.payment-table').getByText('已确认扣款',{exact:true}).isVisible(),'payment ledger explicitly distinguishes confirmed spending')
    await page.evaluate(()=>window.scrollTo(0,0))
    await page.screenshot({path:path.join(output,'ui-payments-focused.png'),fullPage:true})

    await page.getByLabel('运行范围',{exact:true}).selectOption('unassigned')
    check(await page.getByRole('heading',{name:'没有匹配的记录',exact:true}).isVisible(),'legacy scope does not infer newer payment ownership')
    await page.getByRole('button',{name:'参与记录',exact:true}).click()
    check(await page.getByText('共 318 条',{exact:true}).isVisible(),'unassigned history remains accessible')
    await page.getByLabel('运行范围',{exact:true}).selectOption('run')
    await page.getByRole('button',{name:'选择依据',exact:true}).click()
    check((await page.getByLabel('运行范围',{exact:true}).count())===0,'unowned decisions are not misrepresented as run-specific')
    check((await page.locator('.decision-event').count())===2,'decisions use chronological reason-focused rows')
    await page.locator('.decision-event .record-evidence summary').first().click()
    check(await page.locator('.decision-event').first().getByText('无法估计',{exact:false}).isVisible(),'missing probability remains unknown in decision details')
    await page.locator('.decision-event .record-evidence summary').first().click()
    await page.evaluate(()=>window.scrollTo(0,0))
    await page.screenshot({path:path.join(output,'ui-decisions-focused.png'),fullPage:true})

    await page.getByRole('button',{name:'参与记录',exact:true}).click()
    await page.getByLabel('运行范围',{exact:true}).selectOption('run')
    await page.locator('.advanced-filters summary').click()
    await page.getByLabel('记录开始日期',{exact:true}).fill('2099-01-01')
    check(await page.getByRole('heading',{name:'没有匹配的记录',exact:true}).isVisible(),'advanced dates filter detail rows')
    check((await page.locator('.record-headline strong').first().innerText())==='2','detail filters do not relabel full-run summary')
    await page.getByRole('button',{name:'清除筛选',exact:true}).click()
    await page.locator('.advanced-filters summary').click()
    await page.locator('.record-actions summary').click()
    check(await page.getByRole('button',{name:'脱敏导出',exact:true}).isVisible(),'secondary ledger actions remain accessible')
    await page.locator('.record-actions summary').click()
    await page.getByRole('button',{name:'稍后查看提醒',exact:true}).click()
    check((await page.evaluate(()=>window.__fixture.calls.dismissAlert))===1,'popup can be dismissed')
    if(await page.getByRole('button',{name:'关闭提示',exact:true}).isVisible())await page.getByRole('button',{name:'关闭提示',exact:true}).click()
    await page.evaluate(()=>window.scrollTo(0,0))
    await page.screenshot({path:path.join(output,'ui-records-focused.png'),fullPage:true})
    for(const [tabName,file] of [['支出账本','ui-payments-focused.png'],['选择依据','ui-decisions-focused.png']]){
      await page.getByRole('button',{name:tabName,exact:true}).click()
      await page.mouse.move(0,0)
      await page.evaluate(()=>window.scrollTo(0,0))
      await page.screenshot({path:path.join(output,file),fullPage:true,animations:'disabled'})
    }
    await page.getByRole('button',{name:'参与记录',exact:true}).click()
    await page.evaluate(()=>{const r=window.__fixture.insights.rounds[319];r.prizeType='diamond';r.prizeName=null;r.diamondAmount=0})
    await page.getByLabel('记录状态',{exact:true}).selectOption('won')
    await page.locator('.reward-amount').waitFor()
    check((await page.locator('.reward-amount').innerText()).includes('0'),'explicit zero reward remains zero rather than missing')
    await page.evaluate(()=>{window.__fixture.insights.rounds[319].diamondAmount=null})
    await page.locator('.entry-table').getByText('数量待确认',{exact:true}).waitFor()
    check((await page.locator('.reward-amount').count())===0,'unknown diamond quantity is not rendered as zero')
    await page.evaluate(()=>{window.__fixture.insights.rounds[319].result='unknown'})
    await page.getByLabel('记录状态',{exact:true}).selectOption('unknown')
    await page.locator('.entry-table').getByText('暂无已确认奖励',{exact:true}).waitFor()
    check((await page.locator('.reward-title').count())===0,'unknown outcomes do not display candidate prize data as winnings')
    await page.getByRole('button',{name:'支出账本',exact:true}).click()
    await page.evaluate(()=>{window.__fixture.insights.payments[0].state='reserved'})
    await page.locator('.payment-table').getByText('仅预留，未付款',{exact:true}).waitFor()
    check(await page.locator('.payment-table').getByText('仍占用预算',{exact:true}).isVisible(),'reservation remains held and is not presented as a charge')

    await nav('运行面板').click()
    await page.evaluate(()=>{const f=window.__fixture;f.state.candidates=[{url:'https://live.douyin.com/10000002',name:'可移除候选',lotteryId:'x',cost:1,startAt:Date.now()+30000,taskAt:Date.now()+75000,entryRemainingSeconds:30,remainingSeconds:120}];f.phase('running')})
    await page.locator('.reservation-details summary').click()
    await page.getByRole('button',{name:'今天跳过',exact:true}).click()
    check((await page.evaluate(()=>window.__fixture.calls.skipToday))===1,'skip today dispatches once')
    await page.evaluate(()=>{const f=window.__fixture;f.state.automatic=true;f.state.stopAt=Date.now()+600000;f.state.session.stopAt=f.state.stopAt;f.state.session.finishRequested=false;f.emit('auto-run:update',f.state)})
    await page.getByRole('button',{name:'延长时间',exact:true}).click()
    check(await page.locator('#extend-run').isVisible(),'extension preview opens separately from stop controls')
    await page.getByLabel('增加时长',{exact:true}).selectOption('15')
    const oldEnd=await page.evaluate(()=>window.__fixture.state.stopAt)
    await page.screenshot({path:path.join(output,'ui-extend-run.png'),fullPage:true,animations:'disabled'})
    await page.getByRole('button',{name:'确认延长',exact:true}).click()
    await page.locator('#extend-run').waitFor({state:'hidden'})
    check((await page.evaluate(()=>window.__fixture.state.stopAt))===oldEnd+900000,'extension adds selected minutes to original deadline')
    check((await page.evaluate(()=>window.__fixture.calls.extend))===1,'extension dispatches once')
    await page.getByRole('button',{name:'本轮结束后停止',exact:true}).click()
    check((await page.evaluate(()=>window.__fixture.calls.finish))===1,'graceful stop is separate from immediate stop')
    check(await page.getByRole('button',{name:'正在等待本轮结束',exact:true}).isDisabled(),'finish request cannot repeat')
    check(await page.getByRole('button',{name:'延长时间',exact:true}).count()===0,'finish request hides extension')
    await page.goto('https://fixture.local/?auth=expired')
    await page.getByRole('heading',{name:'登录已失效，请重新登录'}).waitFor()
    check(await page.getByRole('button',{name:'登录抖音',exact:true}).first().isVisible(), 'explicit expiry offers manual login')
    check(errors.length === 0, `no page errors: ${errors.join('; ')}`)
    console.log(
      `UI smoke passed: ${checks} interaction/layout checks; offline screenshots in .test-output/ui-*.png`
    )
  } finally {
    await browser.close()
  }
}
