import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium, Browser } from 'playwright'

// Exercise real contexts/cookies/DOM offline. Visible launches are intercepted
// so this test never opens windows or accesses a user profile.
test('browser mode carries current session, opens manual review visibly, and clears logout state', async () => {
  const Module = require('node:module')
  const originalLoad = Module._load
  const launch = chromium.launch.bind(chromium)
  const modes: boolean[] = []
  const processes: Browser[] = []
  let failLaunch = false
  Module._load = function(name: string, ...args: any[]) {
    if (name === './runtime') return {
      execution: { signal: new AbortController().signal },
      onHalt: () => {}, assertActive: (signal: AbortSignal) => signal.throwIfAborted(),
      perform: async (_signal: AbortSignal, fn: () => Promise<unknown>) => fn()
    }
    return originalLoad.call(this, name, ...args)
  }
  const { BrowserManager } = require('../src/main/browser-manager') as typeof import('../src/main/browser-manager')
  Module._load = originalLoad
  chromium.launch = async options => {
    modes.push(!!options?.headless)
    if (failLaunch) { failLaunch = false; throw new Error('synthetic launch failure') }
    const browser = await launch({ ...options, headless: true })
    processes.push(browser)
    const newContext = browser.newContext.bind(browser)
    browser.newContext = async options => {
      const context = await newContext(options)
      await context.route('**/*', route => route.fulfill({contentType:'text/html',body:'<p>离线人工处理页</p>'}))
      return context
    }
    return browser
  }
  const manager = new BrowserManager()
  let disconnected = 0
  manager.setDisconnected(() => { disconnected++ })
  try {
    const initial = await manager.getContext()
    await initial.addCookies([{name:'uid_tt',value:'synthetic-stable-user',domain:'.douyin.com',path:'/'}])
    const page = await initial.newPage()
    await page.goto('https://live.douyin.com')
    await page.evaluate(() => localStorage.setItem('synthetic', 'latest'))
    const snapshot=initial.storageState.bind(initial)
    initial.storageState=async () => { throw new Error('synthetic snapshot failure') }
    await assert.rejects(manager.setBackgroundMode(true), /snapshot failure/)
    assert.equal(page.isClosed(), false, 'failed snapshot preserves original browser')
    initial.storageState=snapshot
    await manager.setBackgroundMode(true)
    assert.equal(page.isClosed(), true)
    const hidden = await manager.getContext()
    assert.notEqual(hidden, initial)
    assert.equal((await hidden.cookies())[0].value, 'synthetic-stable-user')
    assert.equal((await hidden.storageState()).origins[0].localStorage[0].value, 'latest')
    assert.deepEqual(modes, [false, true])
    assert.equal(disconnected, 0, 'intentional switch must not signal a crash')
    await manager.setBackgroundMode(true)
    assert.equal(await manager.getContext(), hidden, 'same-mode start reuses context')
    const work = await manager.newManagedPage()
    await assert.rejects(manager.setBackgroundMode(false), /停止所有工作页面/)
    assert.equal(work.isClosed(), false)
    await manager.closeManagedPages()
    await manager.openManualReview('https://live.douyin.com', 'synthetic-account')
    assert.equal(modes.at(-1), false, 'manual review requires a visible launch')
    const manual = manager.getExistingContext()!
    assert.equal(manual.pages().length, 1)
    await assert.rejects(manager.checkManualReview('another-account'), /账号已变化/)
    await manager.checkManualReview('synthetic-account')
    await manual.addCookies([{name:'sessionid',value:'synthetic-updated-session',domain:'.douyin.com',path:'/'}])
    failLaunch = true
    await assert.rejects(manager.setBackgroundMode(true), /synthetic launch failure/)
    await manager.setBackgroundMode(true) // Retry the selected mode after a launch failure.
    const recovered = await manager.getContext()
    assert.equal((await recovered.cookies()).find(c=>c.name==='sessionid')?.value, 'synthetic-updated-session')
    const before = modes.length
    await assert.rejects(manager.setBackgroundMode(false, () => false), /启动已取消/)
    assert.equal(modes.length, before)
    await manager.closeContext()
    assert.deepEqual(await (await manager.getContext()).cookies(), [], 'logout drops carried state')
  } finally {
    await manager.close()
    chromium.launch = launch
    await Promise.all(processes.map(b => b.close()))
  }
})
