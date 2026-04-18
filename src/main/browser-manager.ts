import { chromium, Browser, BrowserContext } from 'playwright'
import fs from 'fs'
import { MinIntervalQueue } from './min-interval-queue'

export class BrowserManager {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private storageStatePath: string | null = null
  private sourceNavQueue = new MinIntervalQueue(15000, 25000)
  private liveRoomVerifyNavQueue = new MinIntervalQueue(45000, 70000)
  private liveRoomEnterNavQueue = new MinIntervalQueue(4000, 9000)

  setStorageStatePath(path: string): void {
    this.storageStatePath = path
  }

  getSourceNavQueue(): MinIntervalQueue {
    return this.sourceNavQueue
  }

  getLiveRoomVerifyNavQueue(): MinIntervalQueue {
    return this.liveRoomVerifyNavQueue
  }

  getLiveRoomEnterNavQueue(): MinIntervalQueue {
    return this.liveRoomEnterNavQueue
  }

  async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--window-size=1440,900']
      })
    }
    return this.browser
  }

  async getContext(): Promise<BrowserContext> {
    if (!this.context) {
      const browser = await this.getBrowser()
      this.context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
        storageState:
          this.storageStatePath && fs.existsSync(this.storageStatePath)
            ? this.storageStatePath
            : undefined
      })
    }
    return this.context
  }

  async closeContext(): Promise<void> {
    if (this.context) {
      await this.context.close()
      this.context = null
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close()
      this.context = null
    }
    if (this.browser) {
      await this.browser.close()
      this.browser = null
    }
  }
}
