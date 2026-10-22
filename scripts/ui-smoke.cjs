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
          { url: url + '2', name: '示例数码好物', score: 0.2, remainingSeconds: 245, probability: null },
          { url: url + '3', name: '示例家居直播', score: 0.3, remainingSeconds: 480, probability: 0.02 }
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
          status: async () => ({ isLoggedIn: fixture.loggedIn }),
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
          set: async (patch) => {
            count('save')
            if (fixture.rejectSave) return { success: false, error: '模拟保存失败，请重试' }
            Object.assign(fixture.config, copy(patch))
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
        autoRun: {
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
          get: async () => (fixture.loggedIn ? copy(fixture.insights) : null),
          room: async (roomUrl, patch) => {
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
          resolveRisk: async () => {
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
    await page.getByRole('button', { name: '停止运行', exact: true }).waitFor()
    await page.evaluate(() => window.__fixture.populate())
    await page.getByText('示例生活好物直播间', { exact: true }).waitFor()
    await page.screenshot({ path: path.join(output, 'ui-overview-running.png'), fullPage: true })
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
    await page.getByRole('button', { name: '停止运行', exact: true }).click()
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
    check((await page.getByRole('row').count()) === 16, 'room library is paginated')
    await page.evaluate(() => {
      window.__fixture.rejectRoomChange = true
    })
    const favorite = page.getByRole('checkbox', { name: '示例生活好物直播间 收藏', exact: true })
    await favorite.click()
    await page.getByText('模拟房间设置保存失败', { exact: true }).waitFor()
    check(await favorite.isChecked(), 'failed room changes keep the persisted checkbox state')
    await page.evaluate(() => {
      window.__fixture.rejectRoomChange = false
    })
    await page.getByRole('button', { name: '关闭提示', exact: true }).click()
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    check((await page.getByRole('row').count()) === 4, 'room library next page works')
    await page.getByLabel('搜索房间', { exact: true }).fill('生活')
    check((await page.getByRole('row').count()) === 2, 'search filters and resets pagination')
    await page.getByLabel('搜索房间', { exact: true }).fill('')
    await page.screenshot({ path: path.join(output, 'ui-library.png'), fullPage: true })
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
    await page.getByRole('heading', { name: '需要处理', exact: true }).waitFor({ timeout: 8000 })
    await nav('运行面板').click()
    check(
      await page.getByRole('button', { name: '手动参与', exact: true }).isDisabled(),
      'risk hold also disables the manual entry point'
    )
    await nav('运行记录').click()
    check(
      await page.getByRole('button', { name: '已处理，解除阻断', exact: true }).isDisabled(),
      'unresolved charges keep risk resolution disabled'
    )
    await page.getByRole('button', { name: '核实未扣款', exact: true }).click()
    check(await page.getByRole('dialog').isVisible(), 'reconciliation requires an explicit review dialog')
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
    check(
      (await page.evaluate(() => window.__fixture.insights.payments[0].state)) === 'unresolved',
      'cancelling reconciliation leaves the ledger unchanged'
    )
    await page.screenshot({ path: path.join(output, 'ui-records-review.png'), fullPage: true })
    await nav('运行日志').click()
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
      }
      await nav('运行面板').click()
      await page.screenshot({ path: path.join(output, `ui-narrow-${size.width}.png`), fullPage: true })
    }
    check(errors.length === 0, `no page errors: ${errors.join('; ')}`)
    console.log(
      `UI smoke passed: ${checks} interaction/layout checks; offline screenshots in .test-output/ui-*.png`
    )
  } finally {
    await browser.close()
  }
}
