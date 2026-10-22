import { BrowserContext,Page } from 'playwright'
import { BrowserManager } from './browser-manager'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { createHash } from 'crypto'
import { repository } from './runtime'
import { store } from './store'

const AUTH_FILE=path.join(app.getPath('userData'),'auth.json')
export class AuthService {
  private isLoggedIn=false
  private page:Page|null=null
  private loggingIn=false
  constructor(private browser:BrowserManager){browser.setStorageStatePath(AUTH_FILE)}
  async login():Promise<boolean> {
    if(this.loggingIn)throw new Error('登录窗口已打开')
    this.loggingIn=true
    const context=await this.browser.getContext()
    try {
      this.page=await context.newPage()
      await this.page.goto('https://live.douyin.com',{waitUntil:'domcontentloaded',timeout:30000})
      const until=Date.now()+5*60000
      while(Date.now()<until&&!this.page.isClosed()) {
        const id=await this.accountId(context)
        // A generic live-stream avatar and CSRF cookie are not evidence of a logged-in viewer.
        const ownAvatar=await this.page.locator('[data-e2e="user-avatar"], [data-e2e="user-info"]').first().isVisible().catch(()=>false)
        if(id&&ownAvatar) {
          repository.bind(id,{spent:store.get('diamondUsed'),stats:{...store.get('runStats')},rooms:store.get('preferredRooms')||[]})
          await context.storageState({path:AUTH_FILE})
          this.isLoggedIn=true
          return true
        }
        await this.page.waitForTimeout(1500)
      }
      return false
    } finally {await this.page?.close().catch(()=>{});this.page=null;this.loggingIn=false}
  }
  getLoginStatus():boolean{return this.isLoggedIn&&!!repository.read().activeAccount}
  async validateSession():Promise<boolean> {
    if(!this.getLoginStatus())return false
    const id=await this.accountId(await this.browser.getContext())
    return !!id&&id===repository.read().activeAccount
  }
  async logout():Promise<void> {
    this.isLoggedIn=false;await this.page?.close().catch(()=>{});repository.unbind()
    if(fs.existsSync(AUTH_FILE))fs.unlinkSync(AUTH_FILE)
    await this.browser.closeContext()
  }
  private async accountId(context:BrowserContext):Promise<string|null> {
    const cookies=(await context.cookies('https://live.douyin.com')).filter(c=>c.value&&(c.expires===-1||c.expires>Date.now()/1000))
    if(!cookies.some(c=>['sessionid','sessionid_ss'].includes(c.name)))return null
    const uid=cookies.find(c=>c.name==='uid_tt')||cookies.find(c=>c.name==='uid_tt_ss')
    // Never create a fresh budget identity from a rotating session token.
    return uid?createHash('sha256').update(`douyin-account:${uid.value}`).digest('hex'):null
  }
}
