const { _electron } = require('playwright')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),ts=require('typescript')
module.exports=async function alertsSmoke(output){
  const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(output,'alerts-smoke-'))
  for(const file of ['main/user-alerts','main/runtime-repository','shared/review','shared/policy']){
    const target=path.join(dir,'src',file+'.js');fs.mkdirSync(path.dirname(target),{recursive:true})
    fs.writeFileSync(target,ts.transpileModule(fs.readFileSync(path.join(root,'src',file+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText)
  }
  // Only storage/auth are fixtures. Exercise the production notifier and repository with real Electron windows.
  fs.writeFileSync(path.join(dir,'src/main/runtime.js'),`const {RuntimeRepository,emptyRuntime}=require('./runtime-repository');let data=emptyRuntime();exports.repository=new RuntimeRepository({read:()=>data,write:d=>{data=structuredClone(d)}});`)
  const entry=path.join(dir,'entry.cjs')
  fs.writeFileSync(entry,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(dir)});BrowserWindow.prototype.show=function(){};const showInactive=BrowserWindow.prototype.showInactive;BrowserWindow.prototype.showInactive=function(){global.popupShown=(global.popupShown||0)+1;showInactive.call(this)};global.repo=require('./src/main/runtime').repository;global.auth={state:'connected',getStatus(){return {state:this.state,isLoggedIn:this.state==='connected'}}};app.whenReady().then(()=>{const main=new BrowserWindow({show:false,webPreferences:{sandbox:true}});main.loadURL('data:text/html,offline');require('./src/main/user-alerts').setupAlerts(main,global.auth)});`)
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
  const electron=await _electron.launch({args:[entry],env,timeout:20000})
  try{
    await electron.firstWindow()
    const popupEvent=electron.waitForEvent('window',{timeout:10000})
    await electron.evaluate(()=>{
      global.repo.bind('offline',{spent:0,stats:{},rooms:[]});global.repo.room('https://live.douyin.com/12345678','<img src=x>离线测试')
      global.repo.record('https://live.douyin.com/12345678','won',{confirmedAt:Date.now(),result:'won',prizeType:'physical',prizeName:'杯子'})
    })
    const popup=await popupEvent;popup.setDefaultTimeout(8000)
    await popup.getByRole('heading',{name:'实物中奖，待填写领取信息'}).waitFor()
    assert.equal(await popup.locator('img').count(),0,'popup must escape stored text')
    assert.ok((await popup.textContent('body')).includes('<img src=x>'))
    await popup.screenshot({path:path.join(output,'ui-tray-notification.png')})
    const closed=popup.waitForEvent('close');await popup.getByRole('link',{name:'稍后查看'}).click();await closed
    await new Promise(r=>setTimeout(r,1800))
    assert.equal(electron.windows().length,1,'dismissed alert must not reappear')
    await electron.evaluate(()=>{
      const r=global.repo;r.beginRun('offline');const p=r.reserve('https://live.douyin.com/12345678','payment',1,50,false,r.account().session.policy)
      r.payment(p.id,'unresolved');r.finishRun('支付回执待核对')
    })
    await new Promise(r=>setTimeout(r,1800))
    assert.equal(electron.windows().length,1,'payment uncertainty stays silent')
    const loginEvent=electron.waitForEvent('window',{timeout:10000})
    await electron.evaluate(()=>{global.repo.unbind();global.auth.state='expired'})
    const login=await loginEvent;await login.getByRole('heading',{name:'登录已失效'}).waitFor()
    await new Promise(r=>setTimeout(r,1800));assert.equal(login.isClosed(),false,'signed-out alert must not be recreated on each poll')
    const loginClosed=login.waitForEvent('close');await login.getByRole('link',{name:'返回登录'}).click();await loginClosed
    assert.ok(await electron.evaluate(()=>global.popupShown>=2),'popup uses showInactive')
    console.log('Notification smoke passed: isolated native popup, escaped text, dismissal, payment silence, logged-out expiry and non-focus display.')
  }finally{await electron.close()}
}
