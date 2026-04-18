import { BrowserContext } from 'playwright'
import { BrowserManager } from './browser-manager'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { logError } from './logger'

const AUTH_FILE = path.join(app.getPath('userData'), 'auth.json')

export class AuthService {
  private browserManager: BrowserManager
  private isLoggedIn = false

  constructor(browserManager: BrowserManager) {
    this.browserManager = browserManager
    this.browserManager.setStorageStatePath(AUTH_FILE)
  }

  async login(): Promise<boolean> {
    const context = await this.browserManager.getContext()

    if (this.hasSavedAuth()) {
      const page = await context.newPage()
      await page.goto('https://live.douyin.com', { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

      const isValid = await this.checkLoginStatus(page)
      await page.close()
      if (isValid) {
        this.isLoggedIn = true
        return true
      }
    }

    const page = await context.newPage()
    await page.goto('https://live.douyin.com', { waitUntil: 'domcontentloaded' })
    this.isLoggedIn = await this.waitForLogin(page)

    if (this.isLoggedIn) {
      await this.saveAuth(context)
    }

    return this.isLoggedIn
  }

  getLoginStatus(): boolean {
    return this.isLoggedIn
  }

  async logout(): Promise<void> {
    this.isLoggedIn = false
    if (fs.existsSync(AUTH_FILE)) {
      fs.unlinkSync(AUTH_FILE)
    }
    await this.browserManager.closeContext()
  }

  private async waitForLogin(page: any): Promise<boolean> {
    const timeout = 5 * 60 * 1000
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      if (await this.checkLoginStatus(page)) return true
      await page.waitForTimeout(2000)
    }
    return false
  }

  private async checkLoginStatus(page: any): Promise<boolean> {
    try {
      const loginIndicator = await page.$(
        '.user-card, .avatar-icon, [data-e2e="user-avatar"], [class*="avatar"]'
      )
      if (loginIndicator) return true

      const cookies = await page.context().cookies()
      return cookies.some(
        (cookie: { name: string }) =>
          cookie.name === 'sessionid' || cookie.name === 'passport_csrf_token'
      )
    } catch {
      return false
    }
  }

  private async saveAuth(context: BrowserContext): Promise<void> {
    try {
      const state = await context.storageState()
      fs.writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2))
    } catch (e) {
      logError('auth', '保存登录状态失败', e)
    }
  }

  private hasSavedAuth(): boolean {
    return fs.existsSync(AUTH_FILE)
  }
}
