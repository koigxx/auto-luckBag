const { _electron } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
async function main() {
  const root = path.resolve(__dirname, '..'),
    output = path.join(root, '.test-output')
  fs.mkdirSync(output, { recursive: true })
  const profile = fs.mkdtempSync(path.join(output, 'smoke-profile-'))
  fs.writeFileSync(
    path.join(profile, 'config.json'),
    JSON.stringify({
      diamondUsed: 7,
      diamondBudget: 10,
      preferredRooms: [{ id: 'old', url: 'https://live.douyin.com/12345678', name: 'Legacy fixture' }]
    })
  )
  const bootstrap = path.join(output, 'smoke-bootstrap.cjs')
  fs.writeFileSync(
    bootstrap,
    "const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.LUCKBAG_SMOKE_PROFILE);BrowserWindow.prototype.show=function(){};require(process.env.LUCKBAG_SMOKE_ENTRY);"
  )
  const env = {
    ...process.env,
    LUCKBAG_SMOKE_PROFILE: profile,
    LUCKBAG_SMOKE_ENTRY: path.join(root, 'out/main/index.js')
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const electron = await _electron.launch({ args: [bootstrap], env, timeout: 30000 })
  const errors = []
  try {
    const page = await electron.firstWindow()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!window.api)
    const config = await page.evaluate(() => window.api.config.get())
    assert.equal(config.diamondUsed, 7)
    assert.equal(config.policy.navigationMinSeconds, 45)
    assert.equal((await page.evaluate(() => window.api.autoRun.status())).running, false)
    assert.equal((await page.evaluate(() => window.api.auth.status())).isLoggedIn, false)
    const backup = path.join(profile, 'config.json.before-runtime-v2.bak')
    assert.ok(fs.existsSync(backup))
    const original = JSON.parse(fs.readFileSync(backup, 'utf8'))
    assert.equal(original.diamondUsed, 7)
    assert.equal(original.diamondBudget, 10)
    const restored = path.join(profile, 'rollback-fixture.json')
    fs.copyFileSync(backup, restored)
    assert.deepEqual(JSON.parse(fs.readFileSync(restored, 'utf8')), original)
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '策略设置', exact: true })
      .click()
    assert.equal((await page.evaluate(() => window.api.config.set({ diamondUsed: 0 }))).success, false)
    assert.equal(
      (await page.evaluate(() => window.api.config.set({ policy: { sessionMin: 100, sessionMax: 10 } })))
        .success,
      false
    )
    assert.equal((await page.evaluate(() => window.api.config.set({ language: 'en-US' }))).success, true)
    // The view updates through its regular language selector, rather than injecting renderer internals.
    const language = page.locator('select').first()
    if (await language.count()) await language.selectOption('en-US')
    await page.waitForTimeout(100)
    assert.deepEqual(errors, [])
    await require('./ui-smoke.cjs')(config, output)
    console.log(
      'Electron smoke passed: isolated profile, legacy backup/restore, IPC validation, stopped-on-start, Vue render.'
    )
    console.log('Screenshots: .test-output/ui-*.png')
  } finally {
    await electron.close()
  }
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
