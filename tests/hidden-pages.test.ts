import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { enableHiddenPages, installHiddenPages, restoreHiddenOrigins } from '../src/main/hidden-pages'

test('hidden task pages and closed-origin session snapshots never create new native windows',async()=>{
  enableHiddenPages()
  const browser=await chromium.launch({headless:process.env.LUCKBAG_HEADED_FIXTURE!=='1',channel:'chromium'})
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hidden-session-'))
  try {
    const context=await browser.newContext({viewport:{width:1440,height:900}})
    const cdp=await browser.newBrowserCDPSession()
    const createdTypes:string[]=[]
    let outbound=0
    await context.route('**/*',route=>{outbound++;return route.fulfill({contentType:'text/html',body:'<button onclick="document.body.dataset.clicked=\'yes\'">Offline task</button>'})})
    await installHiddenPages(browser,context)
    await cdp.send('Target.setDiscoverTargets',{discover:true})
    cdp.on('Target.targetCreated',event=>createdTypes.push(event.targetInfo.type))
    await context.addCookies([{name:'sessionid',value:'synthetic',domain:'.fixture.invalid',path:'/'}])
    await restoreHiddenOrigins(context,[{origin:'https://a.fixture.invalid',localStorage:[{name:'session',value:'synthetic-local'}]}])
    assert.equal(outbound,0,'storage restoration is served locally without origin network requests')
    for(let n=0;n<8;n++) {
      const page=await context.newPage()
      await page.goto(`https://a.fixture.invalid/${n}`)
      assert.equal(await page.evaluate(()=>localStorage.getItem('session')),'synthetic-local')
      await page.getByRole('button').click()
      if(n===3) {
        await page.evaluate(()=>{window.open('https://popup.fixture.invalid/')})
        await page.waitForTimeout(250)
      }
      assert.equal(await page.evaluate(()=>document.body.dataset.clicked),'yes')
      const probe=await context.newCDPSession(page)
      assert.equal((await probe.send('Target.getTargetInfo')).targetInfo.type,'other')
      await assert.rejects(probe.send('Browser.getWindowForTarget'),/window not found/)
      await probe.detach()
      await page.close()
    }
    const beforeSnapshot=outbound
    const file=path.join(directory,'session.json')
    const saved=await context.storageState({path:file})
    assert.equal(outbound,beforeSnapshot,'snapshot helpers must not request real origin pages')
    assert.equal(saved.cookies[0].value,'synthetic')
    assert.deepEqual(saved.origins,[{origin:'https://a.fixture.invalid',localStorage:[{name:'session',value:'synthetic-local'}]}])
    assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),saved)
    assert.ok(createdTypes.length>=10)
    assert.ok(createdTypes.every(type=>type==='other'),'task, restore and snapshot targets are all windowless')
    assert.equal((await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.type==='page').length,0)
    assert.equal(context.pages().length,1,'only the hidden blank anchor survives closed tasks')
    const capacity=await Promise.all([context.newPage(),context.newPage(),context.newPage(),context.newPage()])
    await assert.rejects(context.newPage(),/5 个上限/)
    await Promise.all(capacity.map(page=>page.close()))
    await assert.rejects(context.storageState({indexedDB:true}),/IndexedDB/)
    await context.close()
    assert.equal(browser.contexts().length,0)
  }finally{await browser.close();await fs.rm(directory,{recursive:true,force:true})}
})
