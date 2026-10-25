import { chromium, Browser, BrowserContext, Page, BrowserContextOptions } from 'playwright'
import fs from 'fs'
import { execution, assertActive, perform, onHalt } from './runtime'
import { checkSignal } from './execution-gate'
import { ROOM_NAVIGATION_TIMEOUT_SECONDS } from '../shared/policy'
import { ManualReviewBrowser } from './manual-review-browser'

export class BrowserManager {
  private closing=false
  private disconnected:()=>void=()=>{}
  setDisconnected(fn:()=>void):void {this.disconnected=fn}
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private creating: Promise<BrowserContext> | null = null
  private storageStatePath: string | null = null
  private pages = new Set<Page>()
  private manualReview = new ManualReviewBrowser(()=>this.getContext())
  openManualReview(url:string,account:string):Promise<void>{return this.manualReview.openManualReview(url,account)}
  checkManualReview(account:string):Promise<void>{return this.manualReview.checkManualReview(account)}
  closeManualReview():Promise<void>{return this.manualReview.closeManualReview()}
  constructor() { onHalt(() => this.closeManagedPages()) }
  setStorageStatePath(path: string): void { this.storageStatePath = path }
  getExistingContext(): BrowserContext | null { return this.context }
  async createBackgroundContext(storageState: BrowserContextOptions['storageState']): Promise<{context: BrowserContext; close: () => Promise<void>}> {
    const browser = await chromium.launch({ headless: true,
      ...(fs.existsSync(chromium.executablePath()) ? {} : {channel: 'msedge'}) })
    try {
      const context = await browser.newContext({ storageState, locale: 'zh-CN', viewport: {width:1440,height:900} })
      return { context, close: () => browser.close() }
    } catch (error) { await browser.close(); throw error }
  }
  async getBrowser(): Promise<Browser> {
    if (!this.browser?.isConnected()) {
      this.browser = await chromium.launch({ headless: false,
      ...(fs.existsSync(chromium.executablePath())?{}:{channel:'msedge'}), args: ['--window-size=1440,900'] })
      this.browser.on('disconnected',()=>{this.context=null;this.browser=null;if(!this.closing)this.disconnected()})
    }
    return this.browser
  }
  async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context
    if (!this.creating) this.creating = (async () => {
      const browser = await this.getBrowser()
      return this.context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN',
        storageState: this.storageStatePath && fs.existsSync(this.storageStatePath) ? this.storageStatePath : undefined })
    })().finally(() => { this.creating = null })
    return this.creating
  }
  async newManagedPage(signal = execution.signal): Promise<Page> {
    assertActive(signal, true)
    const context = await this.getContext()
    assertActive(signal, true)
    const page = await context.newPage()
    if (signal.aborted) { await page.close(); checkSignal(signal) }
    this.pages.add(page)
    const close = () => { void page.close().catch(() => {}) }
    signal.addEventListener('abort', close, { once: true })
    page.once('close', () => { this.pages.delete(page); signal.removeEventListener('abort', close) })
    return page
  }
  async navigate(page: Page, url: string, fresh: boolean, signal: AbortSignal): Promise<void> {
    await perform(signal, () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: ROOM_NAVIGATION_TIMEOUT_SECONDS * 1000 }), { url, fresh })
  }
  async closeManagedPages(): Promise<void> { await Promise.allSettled([...this.pages].map(p => p.close())); this.pages.clear() }
  async closeContext(): Promise<void> {
    this.closing=true
    await this.closeManualReview()
    await this.creating?.catch(() => {})
    await this.context?.close().catch(() => {})
    this.context = null
    this.closing=false
  }
  async close(): Promise<void> { await this.closeContext(); this.closing=true;await this.browser?.close().catch(() => {}); this.browser = null;this.closing=false }
}
