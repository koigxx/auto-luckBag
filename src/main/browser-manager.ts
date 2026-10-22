import { chromium, Browser, BrowserContext, Page } from 'playwright'
import fs from 'fs'
import { execution, assertActive, perform, onHalt } from './runtime'
import { checkSignal } from './execution-gate'

export class BrowserManager {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private creating: Promise<BrowserContext> | null = null
  private storageStatePath: string | null = null
  private pages = new Set<Page>()
  constructor() { onHalt(() => this.closeManagedPages()) }
  setStorageStatePath(path: string): void { this.storageStatePath = path }
  async getBrowser(): Promise<Browser> {
    if (!this.browser?.isConnected()) this.browser = await chromium.launch({ headless: false,
      ...(fs.existsSync(chromium.executablePath())?{}:{channel:'msedge'}), args: ['--window-size=1440,900'] })
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
    await perform(signal, () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }), { url, fresh })
  }
  async closeManagedPages(): Promise<void> { await Promise.allSettled([...this.pages].map(p => p.close())); this.pages.clear() }
  async closeContext(): Promise<void> {
    await this.creating?.catch(() => {})
    await this.context?.close().catch(() => {})
    this.context = null
  }
  async close(): Promise<void> { await this.closeContext(); await this.browser?.close().catch(() => {}); this.browser = null }
}
