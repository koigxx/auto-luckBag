import type { BrowserContext, Page } from 'playwright'
import { visiblePageRisk } from './page-risk'

// This page has no task observer, execution gate or automatic input handlers.
export class ManualReviewBrowser {
  constructor(private context:()=>Promise<BrowserContext>) {}
  private manualPage: Page | null = null
  private manualAccount = ''
  private openingManual: Promise<void> | null = null
  private pendingAccount = ''
  private manualTarget = ''
  async openManualReview(url: string, account: string): Promise<void> {
    if (this.openingManual) {
      if(this.pendingAccount!==account)throw new Error('账号已变化，请等待浏览器处理窗口关闭')
      return this.openingManual
    }
    this.pendingAccount=account
    this.openingManual = (async () => {
      if (this.manualPage && !this.manualPage.isClosed() && this.manualAccount===account) {
        if(this.manualTarget!==url){await this.manualPage.goto(url,{waitUntil:'domcontentloaded',timeout:30000});this.manualTarget=url}
        await this.manualPage.bringToFront(); return
      }
      await this.manualPage?.close().catch(()=>{})
      const context=await this.context()
      this.manualPage=await context.newPage()
      this.manualAccount=account
      await this.manualPage.goto(url,{waitUntil:'domcontentloaded',timeout:30000})
      this.manualTarget=url
      await this.manualPage.bringToFront()
    })().finally(()=>{this.openingManual=null})
    return this.openingManual
  }
  async checkManualReview(account: string, reopenUrl?: string): Promise<void> {
    if (this.manualAccount && this.manualAccount !== account)
      throw new Error('账号已变化，请重新前往浏览器处理，并保持处理页面打开')
    if ((!this.manualPage || this.manualPage.isClosed()) && reopenUrl) {
      await this.openManualReview(reopenUrl, account)
      // A new page is not evidence that the user completed the old challenge.
      throw new Error('处理页面已重新打开。请在浏览器中确认验证已完成，保持页面打开，再点击“已处理，检查并完成”；当前待办仍保留。')
    }
    if (!this.manualPage || this.manualPage.isClosed() || this.manualAccount!==account)
      throw new Error('请先前往浏览器处理，并保持处理页面打开')
    const url=new URL(this.manualPage.url())
    if(url.protocol!=='https:' || !(url.hostname==='douyin.com'||url.hostname.endsWith('.douyin.com')))
      throw new Error('请在抖音页面完成处理')
    if(await visiblePageRisk(this.manualPage))throw new Error('页面仍显示验证或异常，请完成后再检查')
  }
  async closeManualReview():Promise<void> {
    await this.openingManual?.catch(()=>{})
    await this.manualPage?.close().catch(()=>{})
    this.manualPage=null;this.manualAccount='';this.manualTarget=''
  }
}
