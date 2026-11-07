import type { Browser, BrowserContext, Frame, Page } from 'playwright'
import fs from 'node:fs/promises'

// Playwright 1.59.1 supports Chromium's windowless "other" targets behind this
// driver option. It changes target attachment only, not the page's identity.
export function enableHiddenPages(): void {
  process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1'
}

/** Keep ordinary Chromium rendering/authentication without task windows. */
export async function installHiddenPages(browser: Browser, context: BrowserContext): Promise<void> {
  const session = await browser.newBrowserCDPSession()
  const { browserContextIds } = await session.send('Target.getBrowserContexts')
  // BrowserManager owns exactly one context in its dedicated browser process.
  if (browserContextIds.length !== 1) {
    await session.detach()
    throw new Error('无法确定后台浏览器会话，已取消启动')
  }
  const browserContextId = browserContextIds[0]
  // Automatic tasks stay in their current page. Sign-in/review uses a separate
  // visible context. Do not let site popups create native windows (or hang a
  // hidden WebContents waiting for a window delegate).
  await context.addInitScript(() => {
    window.open = () => null
    document.addEventListener('click', event => {
      const link=(event.target as Element|null)?.closest?.('a[target="_blank"]')
      if(link)event.preventDefault()
    },true)
    document.addEventListener('submit',event=>{
      if((event.target as HTMLFormElement|null)?.target==='_blank')event.preventDefault()
    },true)
  })
  const origins = new Set<string>()
  const remember = (frame: Frame) => {
    try { const url=new URL(frame.url()); if(['https:','http:'].includes(url.protocol))origins.add(url.origin) } catch {}
  }
  const track = (page: Page) => {
    page.frames().forEach(remember)
    page.on('framenavigated',remember)
    page.once('close',()=>page.off('framenavigated',remember))
  }
  context.on('page',track)
  let serial: Promise<unknown> = Promise.resolve()
  let closed = false
  context.once('close', () => { closed = true; context.off('page',track); void session.detach().catch(()=>{}) })

  const create = async (hidden: boolean): Promise<Page> => {
    if (closed) throw new Error('后台浏览器已关闭')
    let created: Promise<{targetId:string}>
    const pending = context.waitForEvent('page', {timeout:10000, predicate: async page => {
      const {targetId} = await created
      const probe = await context.newCDPSession(page)
      try { return (await probe.send('Target.getTargetInfo')).targetInfo.targetId === targetId }
      finally { await probe.detach().catch(()=>{}) }
    }})
    void pending.catch(()=>{})
    created = session.send('Target.createTarget', {
      url:'about:blank', browserContextId, background:true,
      ...(hidden ? {hidden:true} : {newWindow:true,windowState:'minimized' as const,focus:false})
    })
    try { await created; return await pending }
    catch(error) {
      const target = await created.catch(()=>null)
      if (target) await session.send('Target.closeTarget',{targetId:target.targetId}).catch(()=>{})
      throw error
    }
  }

  // Chromium requires an initial frame before it can create hidden targets.
  // Bootstrap once before task execution, then close its native window. Keep a
  // blank hidden anchor so later page creation never needs another window.
  let bootstrap: Page | undefined
  try {
    bootstrap = await create(false)
    const anchor = await create(true)
    await bootstrap.close()
    bootstrap = undefined
    const rawNewPage = context.newPage.bind(context)
    const rawStorageState = context.storageState.bind(context)
    context.newPage = () => {
      const pending = serial.then(async () => {
        if (closed || anchor.isClosed()) throw new Error('后台浏览器载体已关闭，请停止后重新启动')
        if (context.pages().length >= 5) throw new Error('后台浏览器页面已达 5 个上限')
        return create(true)
      })
      serial = pending.catch(()=>{})
      return pending
    }
    // Playwright's built-in snapshot may create visible helper pages after the
    // visited origin has closed. Keep snapshot helpers windowless as well.
    context.storageState = async options => {
      if(options?.indexedDB)throw new Error('后台模式暂不支持保存 IndexedDB 登录数据')
      const state: Awaited<ReturnType<BrowserContext['storageState']>> = {cookies:await context.cookies(),origins:[]}
      if(origins.size) {
        const page=await context.newPage()
        try {
          await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}))
          for(const origin of [...origins]) {
            await page.goto(origin,{waitUntil:'domcontentloaded',timeout:10000})
            const localStorage=await page.evaluate(()=>Object.entries(window.localStorage).map(([name,value])=>({name,value})))
            if(localStorage.length)state.origins.push({origin,localStorage})
          }
        } finally { await page.close().catch(()=>{}) }
      }
      if(options?.path)await fs.writeFile(options.path,JSON.stringify(state))
      return state
    }
    context.once('close',()=>{ context.newPage=rawNewPage; context.storageState=rawStorageState })
  } catch {
    await bootstrap?.close().catch(()=>{})
    await session.detach().catch(()=>{})
    throw new Error('当前浏览器不支持隐藏任务页面，已取消后台启动；请使用前台模式')
  }
}

// Restoring origins via browser.newContext(storageState) internally creates a
// normal UI page. Restore only localStorage through hidden, fully routed pages.
export async function restoreHiddenOrigins(context: BrowserContext, origins: {origin:string;localStorage:{name:string;value:string}[];indexedDB?:unknown[]}[]): Promise<void> {
  if (!origins.length) return
  if (origins.some(o=>o.indexedDB?.length)) throw new Error('后台模式暂不支持恢复 IndexedDB 登录数据')
  const page = await context.newPage()
  try {
    await page.route('**/*', route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Session restore</title>'}))
    for (const origin of origins) {
      const url=new URL(origin.origin)
      if(!['https:','http:'].includes(url.protocol))throw new Error('登录存储来源无效')
      await page.goto(url.origin,{waitUntil:'domcontentloaded',timeout:10000})
      await page.evaluate(items=>{for(const {name,value} of items)localStorage.setItem(name,value)},origin.localStorage)
    }
  } finally { await page.close().catch(()=>{}) }
}
