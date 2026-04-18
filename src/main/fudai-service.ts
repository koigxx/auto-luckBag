import { ElementHandle, Page } from 'playwright'
import { analyzeWebSocketFrame, FudaiInfo } from './ws-analyzer'
import { store } from './store'

export interface FudaiCallbacks {
  onFudaiDetected: (info: FudaiInfo) => void
  onFudaiGrabbed: (info: FudaiInfo, result: FudaiGrabResult) => void
  onFudaiSkipped: (reason: string) => void
  onFudaiInfoUpdated: (info: Partial<FudaiInfo>) => void
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
  private lastGiftSendAt = 0
  private lastFanBadgeGiftSendAt = 0
  private lastChatSendAt = 0

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
      if (/\/webcast\/gift\/send\//.test(response.url())) {
        this.lastGiftSendAt = Date.now()
        const request = response.request()
        const postData = request.postData() || ''
        const requestText = `${response.url()} ${postData}`
        if (/gift_id=6937\b|gift_id%22%3A6937|点亮粉丝团|粉丝团灯牌|fansClub/i.test(requestText)) {
          this.lastFanBadgeGiftSendAt = Date.now()
        } else {
          this.debugLog(`捕获到非粉丝灯牌礼物发送，已忽略: ${requestText.slice(0, 180)}`)
        }
        return
      }
      if (/\/webcast\/room\/chat\//.test(response.url())) {
        this.lastChatSendAt = Date.now()
        return
      }
      if (!/\/webcast\/lottery\//.test(response.url())) return
      const text = await response.text().catch(() => '')
      if (!text) return
      const info = this.parseLotteryRightInfo(text)
      if (info) {
        this.latestLotteryRight = info
        this.callbacks.onFudaiInfoUpdated({
          requiresFollow: info.requiresFollow,
          requiresFanBadge: info.requiresFanBadge,
          requiresComment: info.requiresComment,
          commentText: info.commentText,
          fanBadgeCost: info.fanBadgeCost,
          remainingSeconds: info.remainingSeconds
        })
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

      const previousLotteryRight = this.latestLotteryRight
      this.latestLotteryRight = null
      const clicked = await this.clickVisibleFudaiIcon()
      if (!clicked) {
        this.latestLotteryRight = previousLotteryRight
        const reason = source === 'websocket' ? '未找到可见福袋入口，等待页面展示' : '检测到的福袋入口不可点击'
        this.callbacks.onFudaiSkipped(reason)
        this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
        return
      }

      await this.waitForLotteryPanelOrRightInfo(6000)
      if (!this.latestLotteryRight && previousLotteryRight && source === 'websocket') this.latestLotteryRight = previousLotteryRight
      if (!this.latestLotteryRight) {
        this.callbacks.onFudaiSkipped('未获取到福袋任务接口，可能点击到普通红包或非福袋入口')
        this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
        return
      }
      if (!this.canWork()) return

      const enrichedInfo = await this.enrichInfoFromPage(info)
      this.callbacks.onFudaiInfoUpdated(enrichedInfo)
      this.callbacks.onLog(
        `准备执行福袋任务：关注=${enrichedInfo.requiresFollow ? '是' : '否'}，粉丝团=${enrichedInfo.requiresFanBadge ? '是' : '否'}，评论=${enrichedInfo.requiresComment ? '是' : '否'}，口令=${enrichedInfo.commentText || '无'}`
      )
      if (enrichedInfo.requiresFollow || enrichedInfo.requiresFanBadge) await this.handleFollowRequirement()
      if (!this.canWork()) return

      if (enrichedInfo.requiresComment) {
        const commentResult = await this.handleCommentRequirement(enrichedInfo.commentText)
        if (!commentResult) return
      }
      if (!this.canWork()) return

      if (enrichedInfo.requiresFanBadge) {
        await this.refreshLotteryPanelAfterTask()
        const badgeResult = await this.handleFanBadgeRequirement(enrichedInfo.fanBadgeCost)
        if (!badgeResult) return
      }
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
      if (false && hasPanelSignal) return
      await this.page.waitForTimeout(400)
    }
  }

  private async refreshLotteryPanelAfterTask(): Promise<void> {
    this.latestLotteryRight = null
    const clicked = await this.clickVisibleFudaiIcon()
    if (!clicked) {
      this.debugLog('评论后未能重新点击福袋入口，继续使用当前弹窗查找粉丝团按钮')
      return
    }
    await this.waitForLotteryPanelOrRightInfo(5000)
  }

  private async clickVisibleFudaiIcon(): Promise<boolean> {
    const handles = await this.page.locator(SELECTORS.fudaiIcon).elementHandles().catch(() => [])
    for (const handle of handles) {
      if (!(await this.isElementVisible(handle))) continue
      if (!(await this.isLikelyFudaiEntry(handle))) continue
      const beforeUrl = this.page.url()
      try {
        await handle.click({ timeout: 3000 })
        await this.page.waitForTimeout(300).catch(() => {})
        if (this.page.url() !== beforeUrl) {
          this.callbacks.onLog('点击福袋入口后页面发生跳转，尝试返回直播间')
          await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {})
          return false
        }
        this.callbacks.onLog('已点击可见福袋入口')
        return true
      } catch (e: any) {
        this.debugLog(`点击福袋入口失败，跳过强制点击: ${e.message}`)
      }
    }
    this.callbacks.onLog('未找到可见福袋入口')
    return false
  }

  private async isLikelyFudaiEntry(handle: ElementHandle<Node>): Promise<boolean> {
    return handle
      .evaluate((node) => {
        if (!(node instanceof Element)) return false
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
        const ownText = normalize(node.textContent || '')
        const attrText = normalize(
          [
            node.getAttribute('aria-label') || '',
            node.getAttribute('alt') || '',
            node.getAttribute('data-e2e') || '',
            node.className ? String(node.className) : ''
          ].join(' ')
        )
        let current: Element | null = node
        const context: string[] = []
        for (let depth = 0; current && depth < 5; depth++) {
          context.push(normalize(current.textContent || ''))
          if (current.id === 'ShortTouchLayout') context.push('ShortTouchLayout')
          current = current.parentElement
        }
        const text = [ownText, attrText, ...context].join(' ')
        const hasFudaiText = /福袋|超级福袋|粉丝福袋|fudai|luck.?bag|lottery/i.test(text)
        const hasFudaiCountdown = /ShortTouchLayout/.test(text) && /\b\d{1,2}:\d{2}\b/.test(text)
        const hasOnlyOtherRedPacket = /红包|red.?packet/i.test(text) && !hasFudaiText
        return (hasFudaiText || hasFudaiCountdown) && !hasOnlyOtherRedPacket
      })
      .catch(() => false)
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

  private async clickVisibleTextAction(options: {
    keywords: string[]
    excludeKeywords?: string[]
    exact: boolean
    requireLotteryContext?: boolean
    maxAreaRatio: number
    logLabel: string
  }): Promise<boolean> {
    const target = await this.page
      .evaluate((opts) => {
        const viewportArea = Math.max(1, window.innerWidth * window.innerHeight)
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
            rect.left < window.innerWidth &&
            (rect.width * rect.height) / viewportArea <= opts.maxAreaRatio
          )
        }
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
        const matches = (text: string) =>
          opts.exact ? opts.keywords.includes(text) : opts.keywords.some((keyword) => text.includes(keyword))
        const excluded = (text: string) => (opts.excludeKeywords || []).some((keyword) => text.includes(keyword))
        const hasLotteryContext = (element: Element) => {
          if (!opts.requireLotteryContext) return true
          let current: Element | null = element
          for (let depth = 0; current && depth < 6; depth++) {
            const text = normalize(current.textContent || '')
            if (/福袋|参与条件|加入粉丝团|点亮灯牌|粉丝团点亮|倒计时|发送评论|口令/.test(text)) return true
            current = current.parentElement
          }
          return false
        }

        const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span, p'))
          .map((element) => {
            const rect = element.getBoundingClientRect()
            const text = normalize(element.textContent || '')
            return { element, rect, text, area: rect.width * rect.height }
          })
          .filter(({ element, text }) => text && matches(text) && !excluded(text) && isVisible(element) && hasLotteryContext(element))
          .sort((a, b) => a.area - b.area)

        if ((window as any).__luckBagDebugCandidates === undefined) {
          ;(window as any).__luckBagDebugCandidates = []
        }
        ;(window as any).__luckBagDebugCandidates = candidates.slice(0, 8).map(({ rect, text, area }) => ({
          text: text.slice(0, 80),
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          area: Math.round(area)
        }))

        const node = candidates[0]?.element
        if (!node) return null
        const rect = node.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: normalize(node.textContent || '') }
      }, options)
      .catch(() => null)

    if (!target) return false
    await this.logDebugCandidates(options.logLabel)
    await this.page.mouse.click(target.x, target.y)
    this.callbacks.onLog(`已点击${options.logLabel}: ${target.text.slice(0, 30)}`)
    return true
  }

  private async clickFanBadgeConfirm(): Promise<boolean> {
    const target = await this.page
      .evaluate(() => {
        const viewportArea = Math.max(1, window.innerWidth * window.innerHeight)
        const keywords = ['确认点亮', '确认加入', '确认开通', '点亮粉丝团', '粉丝团点亮', '加入粉丝团', '开通粉丝团']
        const contextKeywords = /粉丝团|灯牌|点亮粉丝团|粉丝团点亮|加入粉丝团|开通粉丝团/
        const ordinaryGiftText = /小心心|热气球|跑车|比心兔兔|人气票|Thuglife|春日蝶舞|亲吻|闪耀星辰|大啤酒|玫瑰|抖音|QQ|WW|EE/
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
            rect.left < window.innerWidth &&
            (rect.width * rect.height) / viewportArea <= 0.25
          )
        }
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
        const contextText = (element: Element) => {
          let current: Element | null = element
          const parts: string[] = []
          for (let depth = 0; current && depth < 6; depth++) {
            parts.push(normalize(current.textContent || ''))
            current = current.parentElement
          }
          return parts.join(' ')
        }
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span, p'))
          .map((element) => {
            const rect = element.getBoundingClientRect()
            const text = normalize(element.textContent || '')
            const ctx = contextText(element)
            const isOrdinaryGiftCell =
              ordinaryGiftText.test(text) ||
              (/^\d+\s*钻(?:石)?/.test(text) && /赠送|送出/.test(text) && !/粉丝团|灯牌|点亮/.test(text))
            const hasFanBadgeContext = contextKeywords.test(ctx) || contextKeywords.test(text)
            const isActionButton =
              /加入粉丝团\s*[（(]\s*\d+\s*钻(?:石)?\s*[）)]|点亮粉丝团\s*[（(]\s*\d+\s*钻(?:石)?\s*[）)]|确认|确定|支付|开通|点亮/.test(text)
            const isStatusLabel = /未达成|参与条件|倒计时/.test(text) && !isActionButton
            const score =
              (isActionButton ? 30 : 0) +
              (keywords.some((keyword) => text.includes(keyword)) ? 12 : 0) +
              (/确认|确定|支付|点亮|开通/.test(text) ? 6 : 0) +
              (hasFanBadgeContext ? 8 : 0) -
              (isOrdinaryGiftCell ? 100 : 0) -
              (isStatusLabel ? 100 : 0) -
              (text === '加入粉丝团' || text === '点亮灯牌' ? 20 : 0)
            return { element, rect, text, area: rect.width * rect.height, score, hasFanBadgeContext, isOrdinaryGiftCell, isActionButton }
          })
          .filter(({ element, text, score, hasFanBadgeContext, isOrdinaryGiftCell, isActionButton }) =>
            text && score > 0 && hasFanBadgeContext && !isOrdinaryGiftCell && isActionButton && isVisible(element)
          )
          .sort((a, b) => b.score - a.score || a.area - b.area)

        ;(window as any).__luckBagDebugCandidates = candidates.slice(0, 8).map(({ rect, text, area, score }) => ({
          text: text.slice(0, 80),
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          area: Math.round(area),
          score
        }))

        const node = candidates[0]?.element
        if (!node) return null
        const rect = node.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: normalize(node.textContent || '') }
      })
      .catch(() => null)

    if (!target) return false
    await this.logDebugCandidates('确认加入粉丝团')
    await this.page.mouse.click(target.x, target.y)
    this.callbacks.onLog(`已点击确认加入粉丝团: ${target.text.slice(0, 30)}`)
    return true
  }

  private async waitForFanBadgeSatisfied(timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs && this.canWork()) {
      if (this.lastFanBadgeGiftSendAt >= startedAt) return true
      if (this.latestLotteryRight && !this.latestLotteryRight.requiresFanBadge) return true

      const satisfied = await this.page
        .evaluate(() => {
          const text = (document.body.innerText || '').replace(/\s+/g, ' ')
          if (/已加入粉丝团|已点亮粉丝团|粉丝团灯牌.*已达成|点亮粉丝团.*已达成|加入粉丝团.*已达成/.test(text)) return true
          if (/加入粉丝团\s*已达成|点亮灯牌\s*已达成|粉丝团点亮\s*已达成/.test(text)) return true
          return false
        })
        .catch(() => false)
      if (satisfied) return true
      await this.page.waitForTimeout(400)
    }
    return false
  }

  private async handleFollowRequirement(): Promise<void> {
    const clicked = await this.clickVisibleTextAction({
      keywords: ['关注', '去关注'],
      excludeKeywords: ['已关注', '取消关注'],
      exact: false,
      maxAreaRatio: 0.15,
      logLabel: '关注主播'
    })
    if (clicked) {
      await this.randomDelay(500, 900)
      this.callbacks.onLog('已自动关注主播')
      return
    }

    this.callbacks.onLog('未找到可点击关注按钮，可能已经关注或按钮暂未展示')
  }

  private async clickFanBadgeEntry(): Promise<boolean> {
    const beforeUrl = this.page.url()
    const clicked = await this.clickLotteryFanBadgeAction()
    if (clicked) {
      await this.page.waitForTimeout(500).catch(() => {})
      if (this.page.url() !== beforeUrl) {
        this.callbacks.onLog('点击粉丝团入口后页面发生跳转，尝试返回直播间')
        await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {})
        await this.page.waitForTimeout(1000).catch(() => {})
        return false
      }
      this.callbacks.onLog('已点击加入粉丝团/点亮灯牌入口')
      return true
    }

    return false
  }

  private async clickLotteryFanBadgeAction(): Promise<boolean> {
    const target = await this.page
      .evaluate(() => {
        const viewportArea = Math.max(1, window.innerWidth * window.innerHeight)
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
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
            rect.left < window.innerWidth &&
            (rect.width * rect.height) / viewportArea <= 0.35
          )
        }
        const contextText = (element: Element) => {
          let current: Element | null = element
          const parts: string[] = []
          for (let depth = 0; current && depth < 8; depth++) {
            parts.push(normalize(current.textContent || ''))
            current = current.parentElement
          }
          return parts.join(' ')
        }
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span, p'))
          .map((element) => {
            const rect = element.getBoundingClientRect()
            const text = normalize(element.textContent || '')
            const ctx = contextText(element)
            const inLotteryTask = /福袋|参与条件|发送评论|倒计时/.test(ctx)
            const isAction =
              /加入粉丝团\s*[（(]\s*\d+\s*钻(?:石)?\s*[）)]|点亮粉丝团\s*[（(]\s*\d+\s*钻(?:石)?\s*[）)]|加入粉丝团|点亮灯牌|粉丝团点亮/.test(text)
            const isStatusOnly = /未达成|参与条件|发送评论|倒计时/.test(text) && !/[（(]\s*\d+\s*钻(?:石)?\s*[）)]/.test(text)
            const isHeaderCard = rect.top < 170 && /酷炫勋章|专属礼物|进场特效|加会员/.test(ctx)
            const score =
              (/[（(]\s*\d+\s*钻(?:石)?\s*[）)]/.test(text) ? 50 : 0) +
              (/加入粉丝团|点亮粉丝团|点亮灯牌|粉丝团点亮/.test(text) ? 20 : 0) +
              (inLotteryTask ? 20 : 0) +
              (rect.height >= 28 ? 8 : 0) -
              (isStatusOnly ? 80 : 0) -
              (isHeaderCard ? 80 : 0) -
              (text === '加入粉丝团' || text === '点亮灯牌' ? 10 : 0)
            return { element, rect, text, area: rect.width * rect.height, score, isAction, inLotteryTask, isStatusOnly, isHeaderCard }
          })
          .filter(({ element, text, score, isAction, inLotteryTask, isStatusOnly, isHeaderCard }) =>
            text && score > 0 && isAction && inLotteryTask && !isStatusOnly && !isHeaderCard && isVisible(element)
          )
          .sort((a, b) => b.score - a.score || b.area - a.area)

        ;(window as any).__luckBagDebugCandidates = candidates.slice(0, 8).map(({ rect, text, area, score }) => ({
          text: text.slice(0, 80),
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          area: Math.round(area),
          score
        }))

        const node = candidates[0]?.element
        if (!node) return null
        const rect = node.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: normalize(node.textContent || '') }
      })
      .catch(() => null)

    if (!target) {
      await this.logDebugCandidates('加入粉丝团/点亮灯牌')
      return false
    }
    await this.logDebugCandidates('加入粉丝团/点亮灯牌')
    await this.page.mouse.click(target.x, target.y)
    this.callbacks.onLog(`已点击加入粉丝团/点亮灯牌: ${target.text.slice(0, 30)}`)
    return true
  }

  private async handleFanBadgeRequirement(cost: number): Promise<boolean> {
    const config = store.store
    const remaining = config.diamondBudget - config.diamondUsed
    if (remaining < cost) {
      this.callbacks.onFudaiSkipped(`钻石预算不足，剩余=${remaining}，需要=${cost}`)
      return false
    }

    const clickedEntry = await this.clickFanBadgeEntry()
    if (!clickedEntry) {
      this.callbacks.onFudaiSkipped('未找到可点击的加入粉丝团/点亮灯牌入口，已避免点击普通礼物')
      this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
      return false
    }

    await this.randomDelay(600, 1000)
    const confirmed = await this.clickFanBadgeConfirm()
    if (!confirmed) {
      this.callbacks.onFudaiSkipped('未找到明确的粉丝团/灯牌确认按钮，已避免误送普通礼物')
      this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
      return false
    }

    const verified = await this.waitForFanBadgeSatisfied(7000)
    if (!verified) {
      this.callbacks.onFudaiSkipped('加入粉丝团/点亮灯牌后未确认任务完成，停止本次参与')
      this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
      return false
    }

    store.set('diamondUsed', config.diamondUsed + cost)
    this.callbacks.onFanBadgeAdded(cost)
    this.callbacks.onLog(`已确认加入粉丝团/点亮灯牌，花费 ${cost} 钻石`)
    return true
  }

  private async handleCommentRequirement(commentText: string): Promise<boolean> {
    const text = commentText || '福袋'

    const oneClickStartedAt = Date.now()
    const oneClick = await this.clickVisibleTextAction({
      keywords: ['一键发评论', '发评论参与', '评论参与', '发送评论参与', '一键评论'],
      excludeKeywords: ['参与条件', '未达成'],
      exact: false,
      requireLotteryContext: true,
      maxAreaRatio: 0.35,
      logLabel: '一键发评论'
    })
    if (oneClick) {
      const ok = await this.waitForCommentSatisfied(oneClickStartedAt, 7000)
      if (ok) {
        this.callbacks.onLog(`已完成评论任务: ${text}`)
        return true
      }
      this.debugLog('一键发评论后未确认任务完成，尝试手动评论兜底')
    }

    const startedAt = Date.now()
    const inputTarget = await this.findCommentInputTarget()
    if (!inputTarget) {
      this.callbacks.onFudaiSkipped('未找到可用评论输入框')
      this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
      return false
    }

    await this.page.mouse.click(inputTarget.x, inputTarget.y)
    await this.randomDelay(200, 400)
    await this.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {})
    await this.page.keyboard.type(text, { delay: 35 })
    await this.randomDelay(200, 400)
    await this.page.keyboard.press('Enter')
    this.callbacks.onLog(`已发送评论: ${text}`)

    const ok = await this.waitForCommentSatisfied(startedAt, 8000)
    if (!ok) {
      this.callbacks.onFudaiSkipped('评论发送后未确认任务完成，停止本次参与')
      this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
      return false
    }

    this.callbacks.onLog(`已确认评论任务完成: ${text}`)
    return true
  }

  private async findCommentInputTarget(): Promise<{ x: number; y: number; text: string } | null> {
    const target = await this.page
      .evaluate(() => {
        const isVisible = (element: Element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || 1) > 0.05 &&
            rect.width >= 20 &&
            rect.height >= 12 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
          )
        }
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
        const candidates = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]'))
          .filter((element) => isVisible(element))
          .map((element) => {
            const rect = element.getBoundingClientRect()
            const text = normalize(
              [
                element.getAttribute('placeholder') || '',
                element.getAttribute('aria-label') || '',
                element.textContent || ''
              ].join(' ')
            )
            const score =
              (/评论|说点|聊聊|发言|弹幕|输入/.test(text) ? 10 : 0) +
              (rect.top > window.innerHeight * 0.45 ? 4 : 0) +
              (rect.width > 100 ? 2 : 0)
            return { rect, text, score }
          })
          .sort((a, b) => b.score - a.score || b.rect.top - a.rect.top)

        ;(window as any).__luckBagDebugCandidates = candidates.slice(0, 8).map(({ rect, text, score }) => ({
          text: text.slice(0, 80),
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          score
        }))

        const best = candidates[0]
        if (!best) return null
        return {
          x: best.rect.left + Math.min(best.rect.width - 8, Math.max(8, best.rect.width / 2)),
          y: best.rect.top + best.rect.height / 2,
          text: best.text
        }
      })
      .catch(() => null)

    await this.logDebugCandidates('评论输入框')
    return target
  }

  private async waitForCommentSatisfied(startedAt: number, timeoutMs: number): Promise<boolean> {
    while (Date.now() - startedAt < timeoutMs && this.canWork()) {
      if (this.lastChatSendAt >= startedAt) return true
      if (this.latestLotteryRight && !this.latestLotteryRight.requiresComment) return true

      const satisfied = await this.page
        .evaluate(() => {
          const text = (document.body.innerText || '').replace(/\s+/g, ' ')
          if (/发送评论[：:].{0,80}已达成|评论[：:].{0,80}已达成|口令[：:].{0,80}已达成/.test(text)) return true
          if (/已发送评论|评论成功|已参与|等待开奖|参与成功/.test(text)) return true
          return false
        })
        .catch(() => false)
      if (satisfied) return true
      await this.page.waitForTimeout(400)
    }
    return false
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

    const conditions = Array.isArray(lotteryInfo.conditions) ? lotteryInfo.conditions : []
    const conditionText = JSON.stringify(conditions)
    const userCondition = data?.user_condition || {}
    const commentCondition = conditions.find((condition: any) => Number(condition.type) === 3 || /口令|评论|发送/.test(String(condition.description || condition.content || '')))
    const fanBadgeCondition = conditions.find((condition: any) => Number(condition.type) === 8 || /粉丝团|灯牌/.test(String(condition.description || condition.content || '')))
    const followCondition = conditions.find((condition: any) => Number(condition.type) === 1 || /关注/.test(String(condition.description || condition.content || '')))
    if (!followCondition) userCondition.has_follow = true
    if (!commentCondition) userCondition.has_command = true
    if (!fanBadgeCondition || userCondition.is_fansclub_member === true) {
      userCondition.is_fansclub_member = true
      userCondition.fansclub_status_active = true
    }
    if (fanBadgeCondition && Number(fanBadgeCondition.status) !== 1) {
      userCondition.is_fansclub_member = false
      userCondition.fansclub_status_active = false
    }
    const commentText =
      (lotteryInfo.conditions || [])
        .map((condition: any) => String(condition.content || condition.description || ''))
        .map((value: string) => value.match(/(?:发送口令|口令|评论)[：:\s]*([\u4e00-\u9fa5A-Za-z0-9_-]{1,30})/)?.[1] || '')
        .find(Boolean)
    const commandText = this.extractCommandText(commentCondition) || commentText || ''
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
      commentText: commandText,
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

  private extractCommandText(condition: any): string {
    if (!condition) return ''
    const content = String(condition.content || '').trim()
    if (content) return content
    const description = String(condition.description || '').trim()
    const match = description.match(/(?:发送口令|口令|评论)\s*[:：]\s*(.+)$/)
    return (match?.[1] || '').trim()
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

  private debugEnabled(): boolean {
    return Boolean(store.get('debugLogs'))
  }

  private debugLog(message: string): void {
    if (this.debugEnabled()) this.callbacks.onLog(`[debug] ${message}`)
  }

  private async logDebugCandidates(label: string): Promise<void> {
    if (!this.debugEnabled()) return
    const candidates = await this.page
      .evaluate(() => (window as any).__luckBagDebugCandidates || [])
      .catch(() => [])
    this.callbacks.onLog(`[debug] ${label}候选: ${JSON.stringify(candidates).slice(0, 900)}`)
  }

  private async randomDelay(min: number, max: number): Promise<void> {
    const delay = min + Math.floor(Math.random() * (max - min + 1))
    await this.page.waitForTimeout(delay)
  }
}
