import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { hasOwnProfileEntry } from '../src/main/auth-dom'

// Minimal synthetic reconstruction of the actual application browser DOM,
// inspected 2026-11-06. ALink rendered a bare href, without enter_method.
// No downloaded page, account identifiers, cookies or user images are stored.
const avatar = '<img src="data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E" width="40" height="40">'
const ownLink = `<a href="//www.douyin.com/user/self"><span data-e2e="live-avatar">${avatar}</span></a>`
const style = '<style>body{margin:0}header{position:fixed;right:20px;top:12px}a{display:inline-block;width:40px;height:40px}img{display:block}</style>'

test('current header identifies only a visible self avatar from the top bar', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }))
    const page = await context.newPage()
    await page.goto('https://live.douyin.com/')
    const cases: [string, string, boolean][] = [
      ['new top-bar avatar without legacy markers', `<header>${ownLink}</header>`, true],
      ['hidden first match does not mask visible match', `<header><div hidden>${ownLink}</div>${ownLink}</header>`, true],
      ['unrelated malformed URL does not mask avatar', `<a href="https://[invalid"></a><header>${ownLink}</header>`, true],
      ['signed-out self menu exists without login', '<header><button>登录</button><a href="//www.douyin.com/user/self">我的喜欢</a><a href="//www.douyin.com/user/self">我的收藏</a></header>', false],
      ['unscoped self avatar is not a top-bar entry', `<div style="position:fixed;right:20px;top:12px">${ownLink}</div>`, false],
      ['generic image in a self link is not the avatar component', `<header>${ownLink.replace('data-e2e="live-avatar"','data-e2e="unrelated-image"')}</header>`, false],
      ['query parameters are not authentication evidence', `<header><a href="//www.douyin.com/user/self?enter_method=top_bar">${avatar}</a></header>`, false],
      ['anchor avatar belongs to somebody else', `<header>${ownLink.replace('/user/self','/user/synthetic-anchor')}</header>`, false],
      ['generic avatar and removed legacy markers', `<header><div data-e2e="user-avatar">${avatar}</div><div data-e2e="user-info">${avatar}</div></header>`, false],
      ['wrong destination host', `<header>${ownLink.replace('www.douyin.com','example.com')}</header>`, false],
      ['no profile image', '<header><a href="//www.douyin.com/user/self?enter_method=top_bar">我的</a></header>', false],
      ['hidden ancestor', `<header style="display:none">${ownLink}</header>`, false],
      ['transparent ancestor', `<header style="opacity:0">${ownLink}</header>`, false],
      ['off-screen entry', `<header style="right:-20px">${ownLink}</header>`, false],
      ['content avatar below header', `<header style="top:300px">${ownLink}</header>`, false],
      ['avatar covered by login dialog', `<header>${ownLink}</header><div style="position:fixed;inset:0;background:white;z-index:999">请登录</div>`, false]
    ]
    for (const [name, body, expected] of cases) {
      await page.setContent(style + body.replaceAll('<header','<header id="douyin-header-menuCt"'))
      assert.equal(await hasOwnProfileEntry(page), expected, name)
    }
    await page.goto('https://example.com/')
    await page.setContent(style + `<header id="douyin-header-menuCt">${ownLink}</header>`)
    assert.equal(await hasOwnProfileEntry(page), false, 'unrelated document cannot prove authentication')
    await page.close()
    assert.equal(await hasOwnProfileEntry(page), false, 'closed page provides no evidence')
  } finally { await browser.close() }
})
