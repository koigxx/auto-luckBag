import { BrowserContext,Page } from 'playwright'
import { BrowserManager } from './browser-manager'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { createHash } from 'crypto'
import { repository } from './runtime'
import { store } from './store'
import { probeSession } from './auth-probe'
import type { AuthStatus, AuthState } from '../shared/auth'

const AUTH_FILE=path.join(app.getPath('userData'),'auth.json')
export class AuthService {
  private isLoggedIn=false
  private page:Page|null=null
  private loggingIn=false
  private restoreAttempted=false
  private generation=0
  private pendingCheck:Promise<boolean>|null=null
  private state:AuthState='signed-out'
  private checkedAt:number|null=null
  private background:Promise<boolean>|null=null
  private backgroundAbort:AbortController|null=null
  constructor(private browser:BrowserManager){browser.setStorageStatePath(AUTH_FILE)}
  async login():Promise<boolean> {
    await this.background
    if(this.getLoginStatus())return true
    this.restoreAttempted=true
    return this.beginCheck(5*60000)
  }
  getStatus():AuthStatus { return {isLoggedIn:this.getLoginStatus(),state:this.state,checkedAt:this.checkedAt} }
  async restoreSession(force=false):Promise<boolean> {
    if(this.background)return this.background
    if(this.loggingIn)return false
    if(!force&&this.restoreAttempted)return this.getLoginStatus()
    this.restoreAttempted=true
    const controller=new AbortController()
    this.backgroundAbort=controller
    this.background=this.verifySavedSession(controller.signal).finally(()=>{this.background=null;this.backgroundAbort=null})
    return this.background
  }
  private async verifySavedSession(signal:AbortSignal):Promise<boolean> {
    const generation=this.generation
    this.state='checking'
    this.isLoggedIn=false
    let probe:Awaited<ReturnType<BrowserManager['createBackgroundContext']>>|undefined
    try {
      const existing=this.browser.getExistingContext()
      if(!existing&&!fs.existsSync(AUTH_FILE)){this.state='signed-out';return false}
      const state=existing?await existing.storageState():JSON.parse(fs.readFileSync(AUTH_FILE,'utf8'))
      if(signal.aborted||generation!==this.generation)return false
      if(!Array.isArray(state.cookies)||!Array.isArray(state.origins))throw new Error('Invalid saved session')
      const id=this.identityFromCookies(state.cookies)
      if(!id){this.state='expired';return false}
      probe=await this.browser.createBackgroundContext(state)
      if(signal.aborted||generation!==this.generation)return false
      const verdict=await probeSession(probe.context,signal)
      if(signal.aborted||generation!==this.generation)return false
      this.checkedAt=Date.now()
      this.state=verdict
      if(verdict==='connected') {
        if(await this.accountId(probe.context)!==id){this.state='unknown';return false}
        if(signal.aborted||generation!==this.generation)return false
        // A probe must never overwrite a live working context with an older snapshot.
        if(!existing)await this.persist(probe.context)
        if(signal.aborted||generation!==this.generation)return false
        this.bindAccount(id)
        return true
      }
      return false
    } catch { if(!signal.aborted&&generation===this.generation)this.state='unknown';return false }
    finally { await probe?.close().catch(()=>{}) }
  }
  private beginCheck(waitMs:number):Promise<boolean> {
    if(this.pendingCheck)throw new Error('登录窗口已打开')
    this.pendingCheck=this.checkLogin(waitMs).finally(()=>{this.pendingCheck=null})
    return this.pendingCheck
  }
  private async checkLogin(waitMs:number):Promise<boolean> {
    if(this.loggingIn)throw new Error('登录窗口已打开')
    this.loggingIn=true
    const generation=this.generation
    try {
      const context=await this.browser.getContext()
      if(generation!==this.generation)return false
      this.page=await context.newPage()
      await this.page.goto('https://live.douyin.com',{waitUntil:'domcontentloaded',timeout:Math.min(30000,waitMs)})
      const until=Date.now()+waitMs
      while(generation===this.generation&&Date.now()<until&&!this.page.isClosed()) {
        const id=await this.accountId(context)
        // A generic live-stream avatar and CSRF cookie are not evidence of a logged-in viewer.
        const ownAvatar=await this.page.locator('[data-e2e="user-avatar"], [data-e2e="user-info"]').first().isVisible().catch(()=>false)
        if(id&&ownAvatar&&generation===this.generation) {
          await this.persist(context)
          if(generation!==this.generation)return false
          this.bindAccount(id)
          return true
        }
        await this.page.waitForTimeout(1500)
      }
      return false
    } finally {await this.page?.close().catch(()=>{});this.page=null;this.loggingIn=false}
  }
  getLoginStatus():boolean{return this.isLoggedIn&&!!repository.read().activeAccount}
  async validateSession():Promise<boolean> {
    if(this.getLoginStatus()&&this.checkedAt&&Date.now()-this.checkedAt>=0&&Date.now()-this.checkedAt<5*60000)return true
    const valid=await this.restoreSession(true)
    if(!valid&&this.state==='unknown')throw new Error('暂时无法验证登录状态，已保留会话，请检查网络后重试')
    return valid
  }
  async logout():Promise<void> {
    this.generation++;this.restoreAttempted=true
    this.backgroundAbort?.abort()
    await this.background
    this.state='signed-out';this.checkedAt=null
    this.isLoggedIn=false;await this.page?.close().catch(()=>{});repository.unbind()
    await this.pendingCheck?.catch(()=>{})
    if(fs.existsSync(AUTH_FILE))fs.unlinkSync(AUTH_FILE)
    await this.browser.closeContext()
  }
  async saveSession():Promise<void> {
    this.generation++
    this.backgroundAbort?.abort()
    await this.background
    await this.page?.close().catch(()=>{})
    await this.pendingCheck?.catch(()=>{})
    if(!this.getLoginStatus())return
    const context=this.browser.getExistingContext()
    if(!context)return
    if(await this.accountId(context)===repository.read().activeAccount)
      await this.persist(context)
  }
  private async persist(context:BrowserContext):Promise<void> {
    const temporary=AUTH_FILE+'.tmp'
    try {
      await context.storageState({path:temporary})
      fs.renameSync(temporary,AUTH_FILE)
    } finally {
      if(fs.existsSync(temporary))fs.unlinkSync(temporary)
    }
  }
  private async accountId(context:BrowserContext):Promise<string|null> {
    return this.identityFromCookies(await context.cookies('https://live.douyin.com'))
  }
  private bindAccount(id:string):void {
    repository.bind(id,{spent:store.get('diamondUsed'),stats:{...store.get('runStats')},rooms:store.get('preferredRooms')||[]})
    this.isLoggedIn=true
    this.state='connected';this.checkedAt=Date.now()
  }
  private identityFromCookies(input:unknown[]):string|null {
    const cookies=input.filter((c):c is {name:string,value:string,expires:number,domain:string,path:string}=>{
      if(!c||typeof c!=='object')return false
      const v=c as Record<string,unknown>
      return typeof v.name==='string'&&typeof v.value==='string'&&!!v.value&&
        typeof v.expires==='number'&&(v.expires===-1||v.expires>Date.now()/1000)&&
        ['.douyin.com','.live.douyin.com','live.douyin.com'].includes(String(v.domain))&&v.path==='/'
    })
    if(!cookies.some(c=>['sessionid','sessionid_ss'].includes(c.name)))return null
    const uid=cookies.find(c=>c.name==='uid_tt')||cookies.find(c=>c.name==='uid_tt_ss')
    // Never create a fresh budget identity from a rotating session token.
    return uid?createHash('sha256').update(`douyin-account:${uid.value}`).digest('hex'):null
  }
}
