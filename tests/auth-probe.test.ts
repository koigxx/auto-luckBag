import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { probeSession, selfResponseResult } from '../src/main/auth-probe'

const self='https://www.douyin.com/aweme/v1/web/user/profile/self/'
test('authentication evidence excludes other users, errors, empty and unrelated responses',()=>{
  assert.equal(selfResponseResult(self,200,{status_code:0,user:{uid:'123'}}),'connected')
  assert.equal(selfResponseResult(self,200,{status_code:0,user:{uid:'0'}}),'unknown')
  assert.equal(selfResponseResult(self,200,{status_code:0}),'unknown')
  assert.equal(selfResponseResult(self,401,null),'expired')
  assert.equal(selfResponseResult(self,200,{data:{is_login:false}}),'expired')
  assert.equal(selfResponseResult(self,200,{status_code:8,status_msg:'用户未登录'}),'expired')
  assert.equal(selfResponseResult(self,200,{status_code:8,status_msg:'请完成安全验证'}),'unknown')
  for(const status of [403,429,500])assert.equal(selfResponseResult(self,status,{user:{uid:'123'}}),'unknown')
  assert.equal(selfResponseResult(self.replace('/self/','/other/'),200,{status_code:0,user:{uid:'123'}}),'unknown')
  assert.equal(selfResponseResult(self.replace('www.douyin.com','example.com'),401,null),'unknown')
})

test('hidden probe observes only page-generated evidence, closes pages, and handles offline/abort',async()=>{
  const browser=await chromium.launch({headless:true})
  try{
    for(const mode of ['connected','dom-connected','expired','offline','no-evidence','abort','closed']){
      const context=await browser.newContext()
      const visited:string[]=[]
      await context.route('**/*',async route=>{
        const url=route.request().url();visited.push(url)
        if(mode==='offline'){await route.abort();return}
        if(url===self){await route.fulfill({contentType:'application/json',body:JSON.stringify(mode==='expired'?{is_login:false}:{status_code:0,user:{uid:'123'}})});return}
        const dom='<div id="douyin-header-menuCt"><a href="https://www.douyin.com/user/self" style="position:fixed;right:20px;top:10px;width:40px;height:40px"><span data-e2e="live-avatar"><img src="data:image/svg+xml,%3Csvg/%3E" width="40" height="40"></span></a></div>'
        await route.fulfill({contentType:'text/html',body: mode==='dom-connected'?dom:['no-evidence','abort','closed'].includes(mode)?'<p>Loading</p>':`<script>fetch('${self}')</script>`})
      })
      const controller=new AbortController()
      const observations:string[]=[]
      const pending=probeSession(context,controller.signal,mode==='no-evidence'?150:3000,event=>observations.push(event))
      if(mode==='abort')controller.abort()
      if(mode==='closed') {
        // A user/browser close should resolve without waiting for probe timeout.
        const page=context.pages()[0]||await context.waitForEvent('page')
        await page.close()
      }
      assert.equal(await pending,['connected','dom-connected'].includes(mode)?'connected':mode==='expired'?'expired':'unknown')
      if(['connected','dom-connected'].includes(mode))assert.ok(observations.includes('evidence'))
      if(mode==='expired')assert.ok(observations.includes('expired'))
      if(mode==='offline')assert.ok(observations.includes('page-error'))
      if(mode==='abort')assert.deepEqual(observations,[])
      if(mode==='closed')assert.ok(observations.includes('closed'))
      assert.equal(context.pages().length,0)
      assert.ok(visited.every(url=>url==='https://www.douyin.com/user/self'||url===self))
      await context.close()
    }
  }finally{await browser.close()}
})
