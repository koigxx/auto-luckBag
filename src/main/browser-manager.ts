import { chromium, Browser, BrowserContext, Page, BrowserContextOptions } from 'playwright'
import fs from 'fs'
import { execution, assertActive, perform, onHalt } from './runtime'
import { checkSignal } from './execution-gate'
import { ROOM_NAVIGATION_TIMEOUT_SECONDS } from '../shared/policy'
import { ManualReviewBrowser } from './manual-review-browser'
import { DEFAULT_BACKGROUND_RUN } from '../shared/run-options'

export class BrowserManager {
  private background = DEFAULT_BACKGROUND_RUN
  private carriedState: BrowserContextOptions['storageState'] | undefined
  private lifecycle: Promise<unknown> = Promise.resolve()
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.lifecycle.then(operation)
    this.lifecycle = pending.catch(() => {})
    return pending
  }
  // Call only after task shutdown or before a run starts. Browser modes are
  // launch-time settings; preserve the latest state before replacing a process.
  async setBackgroundMode(background: boolean, current: () => boolean = () => true): Promise<void> {
    if (!current()) throw new Error('启动已取消')
    await this.closeManualReview()
    return this.serial(async () => {
      if (!current()) throw new Error('启动已取消')
      if (this.background === background) { await this.ensureContext(); return }
      if (this.pages.size) throw new Error('请先停止所有工作页面再切换运行模式')
      await this.creating
      const state = this.context ? await this.context.storageState() : this.carriedState
      if (!current()) throw new Error('启动已取消')
      this.carriedState = state
      this.closing = true
      try {
        await this.browser?.close()
        this.browser = null; this.context = null
        this.background = background
        if (current()) await this.ensureContext()
      } finally { this.closing = false }
      if (!current()) throw new Error('启动已取消')
    })
  }
  private closing=false
  private disconnected:()=>void=()=>{}
  setDisconnected(fn:()=>void):void {this.disconnected=fn}
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private creating: Promise<BrowserContext> | null = null
  private storageStatePath: string | null = null
  private pages = new Set<Page>()
  private manualReview = new ManualReviewBrowser(()=>this.getContext())
  async openManualReview(url:string,account:string):Promise<void>{
    if(this.background)await this.setBackgroundMode(false)
    return this.manualReview.openManualReview(url,account)
  }
  async checkManualReview(account:string,reopenUrl?:string):Promise<void>{
    if(this.background)await this.setBackgroundMode(false)
    return this.manualReview.checkManualReview(account,reopenUrl)
  }
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
  private async getBrowser(): Promise<Browser> {
    if (!this.browser?.isConnected()) {
      this.browser = await chromium.launch({ headless: this.background,
      ...(fs.existsSync(chromium.executablePath())?(this.background?{channel:'chromium'}:{}):{channel:'msedge'}), args: ['--window-size=1440,900'] })
      const launched=this.browser
      launched.on('disconnected',()=>{if(this.browser!==launched)return;this.context=null;this.browser=null;if(!this.closing)this.disconnected()})
    }
    return this.browser
  }
  getContext(): Promise<BrowserContext> { return this.serial(() => this.ensureContext()) }
  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context
    if (!this.creating) this.creating = (async () => {
      const browser = await this.getBrowser()
      this.context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN',
        storageState: this.carriedState ?? (this.storageStatePath && fs.existsSync(this.storageStatePath) ? this.storageStatePath : undefined) })
      this.carriedState = undefined
      return this.context
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
    await this.closeManualReview()
    await this.serial(async () => {
      this.closing = true
      try {
        await this.context?.close()
        this.context = null
        this.carriedState = undefined
        this.pages.clear()
      } finally { this.closing = false }
    })
  }
  async close(): Promise<void> {
    await this.closeContext()
    await this.serial(async () => {
      this.closing = true
      try { await this.browser?.close(); this.browser = null }
      finally { this.closing = false }
    })
  }
}
