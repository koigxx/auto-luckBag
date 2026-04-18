import { ElementHandle, Page } from 'playwright'
import { analyzeWebSocketFrame, FudaiInfo } from './ws-analyzer'
import { store } from './store'

export interface FudaiCallbacks {
  onFudaiDetected: (info: FudaiInfo) => void
  onFudaiGrabbed: (info: FudaiInfo, result: FudaiGrabResult) => void
  onFudaiSkipped: (reason: string) => void
  onFanBadgeAdded: (cost: number) => void
  onLog: (message: string) => void
}

export interface FudaiGrabResult {
  participated: boolean
  won: boolean
  prizeType: 'physical' | 'diamond' | 'coupon' | 'unknown' | null
  resultText: string
}

interface LotteryRightInfo {
  requiresFollow: boolean
  requiresFanBadge: boolean
  requiresComment: boolean
  commentText: string
  fanBadgeCost: number
  remainingSeconds: number | null
}

const SELECTORS = {
  fudaiIcon: [
    '[class*="luck-bag"]',
    '[class*="luckbag"]',
    '[class*="red-pocket"]',
    '[class*="redpacket"]',
    '[class*="fudai"]',
    '[class*="lottery"]',
    '[data-e2e*="luck"]',
    '[data-e2e*="lottery"]',
    '#ShortTouchLayout [class*="ShortTouchContainer"]',
    '#ShortTouchLayout .ycjwPFJI',
    '[aria-label*="福袋"]',
    'img[alt*="福袋"]'
  ].join(', '),
  commentInput: 'textarea, input[type="text"], [contenteditable="true"]'
}

const HANDLE_THROTTLE_MS = 15_000
const FAILURE_COOLDOWN_MS = 20_000
const DEFAULT_AFTER_PARTICIPATE_WAIT_MS = 90_000
const AFTER_DRAW_BUFFER_MS = 20_000

export class FudaiService {
  private page: Page
  private roomId: string
  private callbacks: FudaiCallbacks
  private isMonitoring = false
  private domCheckInterval: NodeJS.Timeout | null = null
  private lastHandleAt = 0
  private failureCooldownUntil = 0
  private participatedCooldownUntil = 0
  private handling = false
  private latestLotteryRight: LotteryRightInfo | null = null

  constructor(page: Page, roomId: string, callbacks: FudaiCallbacks) {
    this.page = page
    this.roomId = roomId
    this.callbacks = callbacks
  }

  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) return
    this.isMonitoring = true
    this.setupWebSocketListener()
    this.setupLotteryResponseListener()
    await this.setupDOMMonitor()
    this.callbacks.onLog('开始监控福袋')
  }

  stopMonitoring(): void {
    this.isMonitoring = false
    this.handling = false
    if (this.domCheckInterval) {
      clearInterval(this.domCheckInterval)
      this.domCheckInterval = null
    }
    this.callbacks.onLog('停止监控福袋')
  }

  private setupWebSocketListener(): void {
    this.page.on('websocket', (ws) => {
      if (!this.isMonitoring) return
      this.callbacks.onLog(`WebSocket 连接: ${ws.url().substring(0, 100)}...`)
      ws.on('framereceived', async (frame) => {
        if (!this.canWork()) return
        const fudaiInfo = analyzeWebSocketFrame(frame.payload)
        if (fudaiInfo) await this.handleFudai(fudaiInfo, 'websocket')
      })
    })
  }

  private setupLotteryResponseListener(): void {
    this.page.on('response', async (response) => {
      if (!this.canWork()) return
      if (!/\/webcast\/lottery\//.test(response.url())) return
      const text = await response.text().catch(() => '')
      if (!text) return
      const info = this.parseLotteryRightInfo(text)
      if (info) {
        this.latestLotteryRight = info
        this.callbacks.onLog(
          `已获取福袋任务信息：关注=${info.requiresFollow ? '是' : '否'}，粉丝团=${info.requiresFanBadge ? '是' : '否'}，评论=${info.requiresComment ? '是' : '否'}，剩余=${info.remainingSeconds ?? '未知'}秒`
        )
      }
    })
  }

  private async setupDOMMonitor(): Promise<void> {
    const callbackName = `__notifyFudaiDetected_${this.roomId}`
    await this.page.exposeFunction(callbackName, async () => {
      if (!this.canWork()) return
      const domInfo = await this.getVisibleDomFudaiInfo()
      if (!domInfo.visible) return
      await this.handleFudai(this.createDomFudaiInfo(domInfo.remainingSeconds, 'DOM 检测到可见福袋入口'), 'dom')
    })

    await this.page.evaluate(
      ({ selector, cb }) => {
        const win = window as any
        if (win.__fudaiObserverInstalled) return
        win.__fudaiObserverInstalled = true

        const isVisible = (element: Element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || 1) > 0.05 &&
            rect.width >= 8 &&
            rect.height >= 8 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
          )
        }

        let lastNotifyAt = 0
        const hasVisibleEntry = () => Array.from(document.querySelectorAll(selector)).some(isVisible)
        const notify = () => {
          const now = Date.now()
          if (now - lastNotifyAt < 5000) return
          lastNotifyAt = now
          win[cb]?.()
        }

        const observer = new MutationObserver(() => {
          if (hasVisibleEntry()) notify()
        })
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'aria-label', 'alt']
        })
        if (hasVisibleEntry()) notify()
      },
      { selector: SELECTORS.fudaiIcon, cb: callbackName }
    )

    this.domCheckInterval = setInterval(async () => {
      if (!this.canWork()) return
      try {
        const domInfo = await this.getVisibleDomFudaiInfo()
        if (domInfo.visible) {
          await this.handleFudai(this.createDomFudaiInfo(domInfo.remainingSeconds, 'DOM 轮询检测到可见福袋入口'), 'dom')
        }
      } catch {
        // Page may be navigating or closing.
      }
    }, 3000)
  }

  private async handleFudai(info: FudaiInfo, source: 'websocket' | 'dom'): Promise<void> {
    const now = Date.now()
    if (!this.canWork() || this.handling) return
    if (now < this.participatedCooldownUntil) return
    if (now < this.failureCooldownUntil) return
    if (now - this.lastHandleAt < HANDLE_THROTTLE_MS) return

    this.handling = true
    this.lastHandleAt = now
    try {
      this.callbacks.onFudaiDetected(info)

      const config = store.store
      if (!this.isTypeAllowed(info.type, config.fudaiTypes)) {
        this.callbacks.onFudaiSkipped(`福袋类型 ${info.type} 未启用`)
        return
      }

      const clicked = await this.clickVisibleFudaiIcon()
      if (!clicked) {
        const reason = source === 'websocket' ? '未找到可见福袋入口，等待页面展示' : '检测到的福袋入口不可点击'
        this.callbacks.onFudaiSkipped(reason)
        this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
        return
      }

      await this.waitForLotteryPanelOrRightInfo(6000)
      if (!this.canWork()) return

      const enrichedInfo = await this.enrichInfoFromPage(info)
      if (enrichedInfo.requiresFollow) await this.handleFollowRequirement()
      if (!this.canWork()) return

      if (enrichedInfo.requiresFanBadge) {
        const badgeResult = await this.handleFanBadgeRequirement(enrichedInfo.fanBadgeCost)
        if (!badgeResult) return
      }
      if (!this.canWork()) return

      if (enrichedInfo.requiresComment) await this.handleCommentRequirement(enrichedInfo.commentText)
      if (!this.canWork()) return

      await this.clickParticipate(enrichedInfo)
    } finally {
      this.handling = false
    }
  }

  private createDomFudaiInfo(remainingSeconds: number | null, description: string): FudaiInfo {
    return {
      type: 'all',
      requiresFollow: false,
      requiresFanBadge: false,
      requiresComment: false,
      commentText: '',
      fanBadgeCost: 1,
      description,
      remainingSeconds
    }
  }

  private isTypeAllowed(type: FudaiInfo['type'], fudaiTypes: any): boolean {
    if (fudaiTypes.all) return true
    return fudaiTypes[type] === true
  }

  private async enrichInfoFromPage(info: FudaiInfo): Promise<FudaiInfo> {
    const domInfo = await this.getVisibleDomFudaiInfo()
    const rightInfo = this.latestLotteryRight
    const pageInfo = await this.page.evaluate(() => {
      const bodyText = document.body.innerText || ''
      const dialogText =
        Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="popup"], [class*="panel"]'))
          .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .sort((a, b) => b.length - a.length)[0] || bodyText.slice(0, 6000)
      const comment = dialogText.match(/(?:口令|评论|发送)[：:\s"'“”]*([\u4e00-\u9fa5A-Za-z0-9_-]{1,30})/)?.[1] || ''
      const cost = Number(dialogText.match(/(\d{1,3})\s*(?:钻石|抖币)/)?.[1] || 1)
      return { text: dialogText, comment, cost }
    })

    return {
      ...info,
      requiresFollow: info.requiresFollow || Boolean(rightInfo?.requiresFollow) || /关注/.test(pageInfo.text),
      requiresFanBadge: info.requiresFanBadge || Boolean(rightInfo?.requiresFanBadge) || /粉丝团|灯牌|加入粉丝/.test(pageInfo.text),
      requiresComment: info.requiresComment || Boolean(rightInfo?.requiresComment) || /口令|评论|发送指定/.test(pageInfo.text),
      commentText: info.commentText || rightInfo?.commentText || pageInfo.comment,
      fanBadgeCost: Math.max(1, info.fanBadgeCost || rightInfo?.fanBadgeCost || pageInfo.cost || 1),
      remainingSeconds: info.remainingSeconds ?? rightInfo?.remainingSeconds ?? domInfo.remainingSeconds
    }
  }

  private async waitForLotteryPanelOrRightInfo(timeoutMs: number): Promise<void> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs && this.canWork()) {
      if (this.latestLotteryRight) return
      const hasPanelSignal = await this.page
        .evaluate(() => /立即参与|参与|已参与|口令|评论|关注|粉丝团|灯牌|等待开奖/.test(document.body.innerText || ''))
        .catch(() => false)
      if (hasPanelSignal) return
      await this.page.waitForTimeout(400)
    }
  }

  private async clickVisibleFudaiIcon(): Promise<boolean> {
    const handles = await this.page.locator(SELECTORS.fudaiIcon).elementHandles().catch(() => [])
    for (const handle of handles) {
      if (!(await this.isElementVisible(handle))) continue
      try {
        await handle.click({ timeout: 3000 })
        this.callbacks.onLog('已点击可见福袋入口')
        return true
      } catch (e: any) {
        try {
          await handle.click({ timeout: 1000, force: true })
          this.callbacks.onLog('已强制点击可见福袋入口')
          return true
        } catch (forceError: any) {
          this.callbacks.onLog(`点击可见福袋入口失败: ${forceError.message || e.message}`)
        }
      }
    }
    this.callbacks.onLog('未找到可见福袋入口')
    return false
  }

  private async hasVisibleFudaiEntry(): Promise<boolean> {
    return (await this.getVisibleDomFudaiInfo()).visible
  }

  private async isElementVisible(handle: ElementHandle<Node>): Promise<boolean> {
    return handle
      .evaluate((node) => {
        if (!(node instanceof Element)) return false
        const style = window.getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0.05 &&
          rect.width >= 8 &&
          rect.height >= 8 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth
        )
      })
      .catch(() => false)
  }

  private async handleFollowRequirement(): Promise<void> {
    const buttons = this.page.locator('button, [role="button"], div').filter({ hasText: /^(关注|去关注)$/ })
    const count = await buttons.count().catch(() => 0)
    if (count === 0) return
    for (let i = 0; i < Math.min(count, 3); i++) {
      const button = buttons.nth(i)
      if (!(await button.isVisible().catch(() => false))) continue
      await button.click({ timeout: 3000 }).catch((e) => {
        this.callbacks.onLog(`关注操作失败: ${e.message}`)
      })
      await this.randomDelay(300, 700)
      this.callbacks.onLog('已自动关注主播')
      return
    }
  }

  private async handleFanBadgeRequirement(cost: number): Promise<boolean> {
    const config = store.store
    const remaining = config.diamondBudget - config.diamondUsed
    if (remaining < cost) {
      this.callbacks.onFudaiSkipped(`钻石预算不足，剩余 ${remaining}，需要 ${cost}`)
      return false
    }

    const joinButton = this.page
      .locator('button, [role="button"], div')
      .filter({ hasText: /加入粉丝团|点亮灯牌|加灯牌|去点亮|开通粉丝团/ })
      .first()
    if ((await joinButton.count().catch(() => 0)) === 0 || !(await joinButton.isVisible().catch(() => false))) {
      this.callbacks.onLog('未找到加入粉丝团按钮，可能已经满足灯牌要求')
      return true
    }

    await joinButton.click({ timeout: 3000 }).catch((e) => {
      this.callbacks.onLog(`加入粉丝团点击失败: ${e.message}`)
    })
    await this.randomDelay(600, 1000)

    const confirmButton = this.page.locator('button, [role="button"], div').filter({ hasText: /确认|确定|支付|加入|开通/ }).first()
    if ((await confirmButton.count().catch(() => 0)) > 0 && (await confirmButton.isVisible().catch(() => false))) {
      await confirmButton.click({ timeout: 3000 }).catch(() => {})
    }

    store.set('diamondUsed', config.diamondUsed + cost)
    this.callbacks.onFanBadgeAdded(cost)
    return true
  }

  private async handleCommentRequirement(commentText: string): Promise<void> {
    const text = commentText || '福袋'
    const input = this.page.locator(SELECTORS.commentInput).first()
    if ((await input.count().catch(() => 0)) === 0) {
      this.callbacks.onLog('未找到评论输入框')
      return
    }

    await input.click({ timeout: 3000 }).catch(() => {})
    await this.randomDelay(200, 400)
    await input.fill(text).catch(async () => {
      await this.page.keyboard.type(text, { delay: 40 })
    })

    const sendButton = this.page.locator('button, [role="button"], div').filter({ hasText: /发送|评论/ }).first()
    if ((await sendButton.count().catch(() => 0)) > 0 && (await sendButton.isVisible().catch(() => false))) {
      await sendButton.click({ timeout: 3000 }).catch(() => this.page.keyboard.press('Enter'))
    } else {
      await this.page.keyboard.press('Enter')
    }
    this.callbacks.onLog(`已发送评论: ${text}`)
    await this.randomDelay(500, 900)
  }

  private async clickParticipate(info: FudaiInfo): Promise<void> {
    const participateButton = await this.waitForParticipateButton(9000)
    if (!participateButton) {
      const text = await this.page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 240)).catch(() => '')
      this.callbacks.onFudaiSkipped(`未找到参与按钮，页面文本: ${text}`)
      this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
      return
    }

    let clicked = false
    await participateButton
      .click({ timeout: 3000 })
      .then(() => {
        clicked = true
      })
      .catch((e) => {
        this.callbacks.onLog(`参与操作失败: ${e.message}`)
      })

    if (!clicked) {
      this.callbacks.onFudaiSkipped('参与按钮点击失败')
      this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
      return
    }

    this.callbacks.onLog('已点击参与按钮')
    await this.randomDelay(1200, 1800)

    const result = await this.checkParticipateResult()
    if (result.participated) {
      const waitMs =
        typeof info.remainingSeconds === 'number' && info.remainingSeconds > 0
          ? info.remainingSeconds * 1000 + AFTER_DRAW_BUFFER_MS
          : DEFAULT_AFTER_PARTICIPATE_WAIT_MS
      this.participatedCooldownUntil = Date.now() + waitMs
      this.callbacks.onLog(`已参与福袋，等待开奖约 ${Math.ceil(waitMs / 1000)} 秒`)
      this.callbacks.onFudaiGrabbed(info, result)
    } else {
      this.callbacks.onFudaiSkipped(result.resultText || '未识别到参与成功')
      this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
    }
  }

  private async waitForParticipateButton(timeoutMs: number) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs && this.canWork()) {
      const button = this.page
        .locator('button, [role="button"], div')
        .filter({ hasText: /立即参与|参与抽奖|参与|报名|抢福袋|等待开奖|已参与/ })
        .first()
      if ((await button.count().catch(() => 0)) > 0 && (await button.isVisible().catch(() => false))) {
        return button
      }
      await this.page.waitForTimeout(400)
    }
    return null
  }

  private async checkParticipateResult(): Promise<FudaiGrabResult> {
    const resultText = await this.page.evaluate(() => document.body.innerText.slice(0, 6000)).catch(() => '')
    const compactText = resultText.replace(/\s+/g, ' ')
    const participated = /参与成功|已参与|报名成功|等待开奖|成功参与/.test(compactText)
    const won = /中奖|恭喜|获得|已中|抽中/.test(compactText)
    const hasCoupon = /优惠券|券|coupon/i.test(compactText)
    const hasDiamond = /钻石|抖币|diamond/i.test(compactText)
    const hasPhysical = /实物|填写地址|收货地址|奖品|包邮/.test(compactText)

    let prizeType: FudaiGrabResult['prizeType'] = null
    if (won && hasCoupon) prizeType = 'coupon'
    else if (won && hasDiamond) prizeType = 'diamond'
    else if (won && hasPhysical) prizeType = 'physical'
    else if (won) prizeType = 'unknown'

    return {
      participated,
      won,
      prizeType,
      resultText: compactText.slice(0, 180)
    }
  }

  private parseLotteryRightInfo(text: string): LotteryRightInfo | null {
    let payload: any
    try {
      payload = JSON.parse(text)
    } catch {
      return null
    }
    const data = payload?.data || payload
    const lotteryInfo = data?.lottery_info
    if (!lotteryInfo) return null

    const conditionText = JSON.stringify(lotteryInfo.conditions || [])
    const userCondition = data?.user_condition || {}
    const commentText =
      (lotteryInfo.conditions || [])
        .map((condition: any) => String(condition.content || condition.description || ''))
        .map((value: string) => value.match(/(?:发送口令|口令|评论)[：:\s]*([\u4e00-\u9fa5A-Za-z0-9_-]{1,30})/)?.[1] || '')
        .find(Boolean) || ''
    const currentTime = this.normalizeTimestamp(lotteryInfo.current_time ?? payload?.extra?.now)
    const drawTime = this.normalizeTimestamp(lotteryInfo.draw_time)
    const remainingFromDraw =
      drawTime && currentTime && drawTime > currentTime ? Math.floor((drawTime - currentTime) / 1000) : null
    const countDown = Number(lotteryInfo.count_down)

    return {
      requiresFollow: userCondition.has_follow === false || /关注/.test(conditionText),
      requiresFanBadge:
        userCondition.is_fansclub_member === false &&
        (/粉丝团|灯牌|fans|club/i.test(conditionText) || userCondition.fansclub_status_active === false),
      requiresComment: userCondition.has_command === false || /口令|评论|发送/.test(conditionText),
      commentText,
      fanBadgeCost: Math.max(1, Number(conditionText.match(/(\d{1,3})\s*(?:钻石|抖币)/)?.[1] || 1)),
      remainingSeconds:
        remainingFromDraw !== null && remainingFromDraw > 0
          ? remainingFromDraw
          : Number.isFinite(countDown) && countDown > 0
            ? countDown
            : null
    }
  }

  private normalizeTimestamp(value: any): number | null {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return null
    return numeric > 10_000_000_000 ? numeric : numeric * 1000
  }

  private async getVisibleDomFudaiInfo(): Promise<{ visible: boolean; remainingSeconds: number | null }> {
    return this.page
      .evaluate((selector) => {
        const parseRemainingSeconds = (text: string): number | null => {
          const normalized = text.replace(/\s+/g, '')
          const hhmmss = normalized.match(/(\d{1,2}):(\d{1,2}):(\d{1,2})/)
          if (hhmmss) return Number(hhmmss[1]) * 3600 + Number(hhmmss[2]) * 60 + Number(hhmmss[3])
          const mmss = normalized.match(/(\d{1,2}):(\d{1,2})/)
          if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2])
          const minSec = normalized.match(/(?:(\d+)分钟)?(\d+)秒/)
          if (minSec) return Number(minSec[1] || 0) * 60 + Number(minSec[2])
          const minutes = normalized.match(/(\d+)分钟/)
          if (minutes) return Number(minutes[1]) * 60
          return null
        }

        const isVisible = (element: Element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || 1) > 0.05 &&
            rect.width >= 8 &&
            rect.height >= 8 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
          )
        }

        const countdownNodes = Array.from(
          document.querySelectorAll('#ShortTouchLayout .ycjwPFJI, #ShortTouchLayout [class*="countdown"]')
        )
        for (const node of countdownNodes) {
          if (!isVisible(node)) continue
          const remainingSeconds = parseRemainingSeconds(node.textContent || '')
          if (remainingSeconds !== null) return { visible: true, remainingSeconds }
        }

        return {
          visible: Array.from(document.querySelectorAll(selector)).some(isVisible),
          remainingSeconds: null
        }
      }, SELECTORS.fudaiIcon)
      .catch(() => ({ visible: false, remainingSeconds: null }))
  }

  private canWork(): boolean {
    return this.isMonitoring && !this.page.isClosed()
  }

  private async randomDelay(min: number, max: number): Promise<void> {
    const delay = min + Math.floor(Math.random() * (max - min + 1))
    await this.page.waitForTimeout(delay)
  }
}
