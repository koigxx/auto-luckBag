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
  diamondAmount: number
  resultText: string
}

interface LotteryRightInfo {
  lotteryId: string
  requiresFollow: boolean
  requiresFanBadge: boolean
  requiresComment: boolean
  requiresShare: boolean
  commentText: string
  fanBadgeCost: number
  remainingSeconds: number | null
  drawAt: number | null
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
const AFTER_DRAW_BUFFER_MS = 5_000

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
  private reportedParticipationKeys = new Set<string>()

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

  async finalizeParticipationIfDetected(): Promise<FudaiGrabResult | null> {
    const result = await this.checkParticipateResult()
    if (result.participated) {
      const remainingSeconds = this.latestLotteryRight?.remainingSeconds ?? 1
      const drawAt =
        this.latestLotteryRight?.drawAt ??
        (typeof remainingSeconds === 'number' && remainingSeconds > 0 ? Date.now() + remainingSeconds * 1000 : Date.now() + 1000)
      this.handleParticipated(
        {
          type: 'all',
          requiresFollow: false,
          requiresFanBadge: false,
          requiresComment: false,
          requiresShare: false,
          commentText: '',
          fanBadgeCost: 1,
          description: '关闭前确认已参与',
          remainingSeconds,
          drawAt
        },
        result
      )
      return result
    }
    return result.won || result.resultText ? result : null
  }

  async getLatestResultSnapshot(): Promise<FudaiGrabResult> {
    return this.checkParticipateResult()
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
          requiresShare: info.requiresShare,
          commentText: info.commentText,
          fanBadgeCost: info.fanBadgeCost,
          remainingSeconds: info.remainingSeconds,
          drawAt: info.drawAt
        })
        this.callbacks.onLog(
          `已获取福袋任务信息：关注=${info.requiresFollow ? '是' : '否'}，粉丝团=${info.requiresFanBadge ? '是' : '否'}，评论=${info.requiresComment ? '是' : '否'}，分享=${info.requiresShare ? '是' : '否'}，剩余=${info.remainingSeconds ?? '未知'}秒`
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
      this.debugLog(`开始处理福袋: source=${source}, type=${info.type}, remaining=${info.remainingSeconds ?? 'unknown'}, comment=${info.requiresComment ? 'yes' : 'no'}, fanBadge=${info.requiresFanBadge ? 'yes' : 'no'}`)
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
        await this.debugLotteryContext('点击福袋后未获取任务接口')
        this.callbacks.onFudaiSkipped('未获取到福袋任务接口，可能点击到普通红包或非福袋入口')
        this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
        return
      }
      if (!this.canWork()) return

      const enrichedInfo = await this.enrichInfoFromPage(info)
      this.callbacks.onFudaiInfoUpdated(enrichedInfo)
      this.callbacks.onLog(
        `准备执行福袋任务：关注=${enrichedInfo.requiresFollow ? '是' : '否'}，粉丝团=${enrichedInfo.requiresFanBadge ? '是' : '否'}，评论=${enrichedInfo.requiresComment ? '是' : '否'}，分享=${enrichedInfo.requiresShare ? '是' : '否'}，口令=${enrichedInfo.commentText || '无'}`
      )
      if (enrichedInfo.requiresShare) {
        this.callbacks.onFudaiSkipped('福袋要求分享直播间，暂不支持，已跳过')
        this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
        return
      }
      if (enrichedInfo.requiresFollow && !enrichedInfo.requiresFanBadge) await this.handleFollowRequirement()
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
      requiresShare: false,
      commentText: '',
      fanBadgeCost: 1,
      description,
      remainingSeconds,
      drawAt: remainingSeconds !== null ? Date.now() + remainingSeconds * 1000 : null
    }
  }

  private isTypeAllowed(type: FudaiInfo['type'], fudaiTypes: any): boolean {
    if (fudaiTypes.all) return true
    if (type === 'all') return Boolean(fudaiTypes.physical || fudaiTypes.diamond)
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
      requiresShare:
        info.requiresShare ||
        Boolean(rightInfo?.requiresShare) ||
        /参与条件.{0,120}分享|分享直播间.{0,80}(?:未达成|参与)|分享.{0,40}(?:未达成|任务)/.test(pageInfo.text),
      commentText: info.commentText || rightInfo?.commentText || pageInfo.comment,
      fanBadgeCost: Math.max(1, info.fanBadgeCost || rightInfo?.fanBadgeCost || pageInfo.cost || 1),
      remainingSeconds: info.remainingSeconds ?? rightInfo?.remainingSeconds ?? domInfo.remainingSeconds,
      drawAt:
        info.drawAt ??
        rightInfo?.drawAt ??
        (domInfo.remainingSeconds !== null ? Date.now() + domInfo.remainingSeconds * 1000 : null)
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
    const startedAt = Date.now()
    while (Date.now() - startedAt < 3000 && this.canWork()) {
      if (await this.hasLotteryFanBadgeAction()) {
        this.debugLog('评论后当前福袋弹窗已出现粉丝团按钮，直接继续执行')
        return
      }
      await this.page.waitForTimeout(300).catch(() => {})
    }

    this.latestLotteryRight = null
    const clicked = await this.clickVisibleFudaiIcon()
    if (!clicked) {
      this.debugLog('评论后未能重新点击福袋入口，继续使用当前弹窗查找粉丝团按钮')
      return
    }
    await this.waitForLotteryPanelOrRightInfo(5000)
  }

  private async hasLotteryFanBadgeAction(): Promise<boolean> {
    return this.page
      .evaluate(() => {
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
            rect.left < window.innerWidth
          )
        }
        const hasLotteryContext = (element: Element) => {
          let current: Element | null = element
          for (let depth = 0; current && depth < 8; depth++) {
            const text = normalize(current.textContent || '')
            if (/福袋|参与条件|发送评论|倒计时/.test(text)) return true
            current = current.parentElement
          }
          return false
        }

        return Array.from(document.querySelectorAll('button, [role="button"], div, span, p')).some((element) => {
          const text = normalize(element.textContent || '')
          const isAction =
            text.length <= 40 &&
            /(?:加入粉丝团|点亮粉丝团|点亮灯牌|粉丝团点亮)\s*[（(]\s*\d+\s*钻(?:石)?\s*[）)]/.test(text)
          return isAction && isVisible(element) && hasLotteryContext(element)
        })
      })
      .catch(() => false)
  }

  private async clickVisibleFudaiIcon(): Promise<boolean> {
    if (await this.clickShortTouchFudaiEntry()) return true

    const handles = await this.page.locator(SELECTORS.fudaiIcon).elementHandles().catch(() => [])
    const candidates: Array<{ handle: ElementHandle<Node>; score: number }> = []
    const debugCandidates: Array<{ text: string; x: number; y: number; w: number; h: number; score: number }> = []
    for (const handle of handles) {
      if (!(await this.isElementVisible(handle))) continue
      const score = await this.scoreFudaiEntry(handle)
      if (score <= 0) continue
      candidates.push({ handle, score })
      if (this.debugEnabled()) {
        const debug = await this.describeElementForDebug(handle, score)
        if (debug) debugCandidates.push(debug)
      }
    }

    candidates.sort((a, b) => b.score - a.score)
    this.debugLog(`通用福袋入口候选数量: ${candidates.length}/${handles.length}`)
    if (this.debugEnabled()) {
      this.callbacks.onLog(`[debug] 通用福袋入口候选: ${JSON.stringify(debugCandidates.sort((a, b) => b.score - a.score).slice(0, 8)).slice(0, 900)}`)
    }

    for (const { handle } of candidates) {
      const beforeUrl = this.page.url()
      try {
        const clickPoint = await this.getFudaiEntryClickPoint(handle)
        if (!clickPoint) {
          this.debugLog('通用福袋入口候选无法计算安全点击点，跳过')
          continue
        }
        this.debugLog(`尝试点击通用福袋入口: x=${Math.round(clickPoint.x)}, y=${Math.round(clickPoint.y)}`)
        await this.page.mouse.click(clickPoint.x, clickPoint.y)
        await this.page.waitForTimeout(300).catch(() => {})
        if (this.page.url() !== beforeUrl) {
          this.callbacks.onLog('点击福袋入口后页面发生跳转，尝试返回直播间')
          await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {})
          continue
        }
        if (await this.waitForLotteryClickResult(2200)) {
          this.callbacks.onLog('已点击可见福袋入口')
          return true
        }
        this.debugLog('点击入口后未出现福袋接口或福袋面板，可能是普通红包，继续尝试下一个入口')
        await this.dismissCurrentOverlay()
      } catch (e: any) {
        this.debugLog(`点击福袋入口失败，跳过强制点击: ${e.message}`)
      }
    }
    this.callbacks.onLog('未找到可见福袋入口')
    return false
  }

  private async clickShortTouchFudaiEntry(): Promise<boolean> {
    const beforeUrl = this.page.url()
    const point = await this.page
      .evaluate(() => {
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
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
            (rect.width * rect.height) / viewportArea <= 0.12
          )
        }
        const attrText = (element: Element) =>
          normalize(
            [
              element.id || '',
              String(element.className || ''),
              element.getAttribute('data-extra') || '',
              element.getAttribute('data-short-touch-landing') || '',
              element.getAttribute('data-e2e') || '',
              element.getAttribute('aria-label') || '',
              element.getAttribute('alt') || ''
            ].join(' ')
          )
        const elementText = (element: Element) =>
          normalize([attrText(element), element.textContent || ''].join(' '))
        const isCloseLike = (element: Element) => /close|lottery_close|关闭|取消/i.test(attrText(element))
        const hasCountdown = (text: string) => /\b\d{1,2}:\d{2}\b/.test(text)
        const hasFudaiSignal = (text: string) =>
          /福袋|超级福袋|粉丝福袋|fudai|luck.?bag|lucky.?bag|short_touch_land_lottery|lottery_land/i.test(text)
        const hasOtherPacketSignal = (text: string) => /红包|red.?packet/i.test(text) && !/福袋|fudai|luck.?bag/i.test(text)
        const subtreeText = (element: Element) => normalize([attrText(element), element.textContent || ''].join(' '))
        const ancestorText = (element: Element, maxDepth = 5) => {
          const parts: string[] = []
          let current: Element | null = element
          for (let depth = 0; current && depth < maxDepth; depth++) {
            parts.push(subtreeText(current))
            if (current.id === 'ShortTouchLayout') break
            current = current.parentElement
          }
          return parts.join(' ')
        }
        const findClickableShortTouchCard = (element: Element) => {
          let best: Element | null = null
          let current: Element | null = element
          for (let depth = 0; current && depth < 5; depth++) {
            if (current.id === 'ShortTouchLayout') break
            if (!isVisible(current) || isCloseLike(current)) {
              current = current.parentElement
              continue
            }
            const rect = current.getBoundingClientRect()
            const text = subtreeText(current)
            if (hasOtherPacketSignal(text)) {
              current = current.parentElement
              continue
            }
            if (rect.width <= 430 && rect.height <= 190) best = current
            current = current.parentElement
          }
          return best
        }

        const roots = Array.from(
          document.querySelectorAll(
            [
              '#ShortTouchLayout [data-short-touch-landing]',
              '#ShortTouchLayout [id*="lottery"]',
              '#ShortTouchLayout [class*="ShortTouchContainer"]',
              '#ShortTouchLayout .ycjwPFJI',
              '#ShortTouchLayout [class*="countdown"]'
            ].join(', ')
          )
        )
        const candidates: Array<{ element: Element; score: number; area: number }> = []

        for (const root of roots) {
          if (!isVisible(root) || isCloseLike(root)) continue
          const context = ancestorText(root)
          const explicitFudai = hasFudaiSignal(context)
          const countdown = hasCountdown(context)
          const otherPacket = hasOtherPacketSignal(context)
          if (!countdown || otherPacket) continue

          const card = findClickableShortTouchCard(root)
          if (!card) continue
          const rect = card.getBoundingClientRect()
          const attr = attrText(card)
          const text = subtreeText(card)
          const score =
            (/short_touch_land_lottery|lottery_land/i.test(attr) ? 180 : 0) +
            (explicitFudai ? 130 : 0) +
            (/福袋|fudai|luck.?bag|lucky.?bag/i.test(text) ? 80 : 0) +
            (countdown ? 70 : 0) +
            (root.classList.contains('ycjwPFJI') ? 35 : 0) -
            (!explicitFudai ? 25 : 0) -
            (rect.width > 280 || rect.height > 130 ? 20 : 0)
          candidates.push({ element: card, score, area: rect.width * rect.height })
        }

        const best = candidates.sort((a, b) => b.score - a.score || a.area - b.area)[0]
        ;(window as any).__luckBagDebugCandidates = candidates.slice(0, 8).map(({ element, score, area }) => {
          const rect = element.getBoundingClientRect()
          return {
            text: subtreeText(element).slice(0, 100),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            area: Math.round(area),
            score
          }
        })
        if (!best) return null
        const rect = best.element.getBoundingClientRect()
        return {
          x: Math.min(window.innerWidth - 2, Math.max(2, rect.left + rect.width / 2)),
          y: Math.min(window.innerHeight - 2, Math.max(2, rect.top + rect.height / 2))
        }
      })
      .catch(() => null)

    await this.logDebugCandidates('ShortTouch福袋入口')
    if (!point) return false
    try {
      this.debugLog(`尝试点击 ShortTouch 福袋入口: x=${Math.round(point.x)}, y=${Math.round(point.y)}`)
      await this.page.mouse.click(point.x, point.y)
      await this.page.waitForTimeout(300).catch(() => {})
      if (this.page.url() !== beforeUrl) {
        this.callbacks.onLog('点击福袋入口后页面发生跳转，尝试返回直播间')
        await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {})
        return false
      }
      if (await this.waitForLotteryClickResult(2200)) {
        this.callbacks.onLog('已点击 ShortTouch 福袋入口')
        return true
      }
      this.debugLog('ShortTouch 入口点击后未确认福袋接口或福袋面板，交给后续入口候选继续尝试')
    } catch (e: any) {
      this.debugLog(`ShortTouch 福袋入口点击失败: ${e.message}`)
    }
    return false
  }

  private async isLikelyFudaiEntry(handle: ElementHandle<Node>): Promise<boolean> {
    return (await this.scoreFudaiEntry(handle)) > 0
  }

  private async getFudaiEntryClickPoint(handle: ElementHandle<Node>): Promise<{ x: number; y: number } | null> {
    return handle
      .evaluate((node) => {
        if (!(node instanceof Element)) return null
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
            (rect.width * rect.height) / viewportArea <= 0.12
          )
        }
        const attrText = (element: Element) =>
          normalize(
            [
              element.id || '',
              String(element.className || ''),
              element.getAttribute('data-extra') || '',
              element.getAttribute('data-short-touch-landing') || '',
              element.getAttribute('data-e2e') || '',
              element.getAttribute('aria-label') || '',
              element.getAttribute('alt') || ''
            ].join(' ')
          )
        const contextText = (element: Element) => {
          const parts: string[] = []
          let current: Element | null = element
          for (let depth = 0; current && depth < 5; depth++) {
            parts.push(attrText(current))
            parts.push(normalize(current.textContent || ''))
            if (current.id === 'ShortTouchLayout') parts.push('ShortTouchLayout')
            current = current.parentElement
          }
          return parts.join(' ')
        }

        const candidates: Array<{ element: Element; score: number; area: number }> = []
        let current: Element | null = node
        for (let depth = 0; current && depth < 5; depth++) {
          if (isVisible(current)) {
            const rect = current.getBoundingClientRect()
            const own = `${attrText(current)} ${normalize(current.textContent || '')}`
            const ctx = `${own} ${contextText(current)}`
            if (!/close|lottery_close|关闭|取消/i.test(own)) {
              const explicitFudai = /福袋|超级福袋|粉丝福袋|fudai|luck.?bag/i.test(ctx)
              const shortTouchLottery = /ShortTouchLayout/.test(ctx) && /short_touch_land_lottery|lottery_land|luck.?bag|fudai/i.test(ctx)
              const shortTouchCountdown = /ShortTouchLayout/.test(ctx) && /\b\d{1,2}:\d{2}\b/.test(ctx)
              const otherPacket = /红包|red.?packet/i.test(ctx) && !explicitFudai
              const genericLottery = /\blottery\b/i.test(ctx) && !explicitFudai && !shortTouchLottery
              const largeContainer = rect.width > 420 || rect.height > 180
              if (!otherPacket && !genericLottery && !largeContainer && (explicitFudai || shortTouchLottery || shortTouchCountdown)) {
                const score =
                  (shortTouchLottery ? 160 : 0) +
                  (explicitFudai ? 90 : 0) +
                  (shortTouchCountdown ? 30 : 0) +
                  (/福袋|fudai|luck.?bag/i.test(own) ? 40 : 0) -
                  (/红包|red.?packet/i.test(ctx) ? 80 : 0)
                if (score > 0) candidates.push({ element: current, score, area: rect.width * rect.height })
              }
            }
          }
          current = current.parentElement
        }

        const best = candidates.sort((a, b) => b.score - a.score || a.area - b.area)[0]
        if (!best) return null
        const rect = best.element.getBoundingClientRect()
        return {
          x: Math.min(window.innerWidth - 2, Math.max(2, rect.left + rect.width / 2)),
          y: Math.min(window.innerHeight - 2, Math.max(2, rect.top + rect.height / 2))
        }
      })
      .catch(() => null)
  }

  private async scoreFudaiEntry(handle: ElementHandle<Node>): Promise<number> {
    return handle
      .evaluate((node) => {
        if (!(node instanceof Element)) return 0
        const viewportArea = Math.max(1, window.innerWidth * window.innerHeight)
        const rect = node.getBoundingClientRect()
        if (rect.width > 520 || rect.height > 220 || (rect.width * rect.height) / viewportArea > 0.14) return 0
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
        const idClass = `${node.id || ''} ${String(node.className || '')}`
        if (/close|lottery_close|关闭|取消/i.test(idClass)) return 0
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
          context.push(
            normalize(
              [
                current.id || '',
                String(current.className || ''),
                current.getAttribute('data-extra') || '',
                current.getAttribute('data-short-touch-landing') || '',
                current.getAttribute('data-e2e') || '',
                current.getAttribute('aria-label') || ''
              ].join(' ')
            )
          )
          if (current.id === 'ShortTouchLayout') context.push('ShortTouchLayout')
          current = current.parentElement
        }
        const text = [ownText, attrText, ...context].join(' ')
        const hasExplicitFudaiText = /福袋|超级福袋|粉丝福袋|fudai|luck.?bag/i.test(text)
        const hasOnlyGenericLotteryText = /\blottery\b/i.test(text) && !hasExplicitFudaiText
        const hasFudaiCountdown = /ShortTouchLayout/.test(text) && /\b\d{1,2}:\d{2}\b/.test(text)
        const hasShortTouchLotteryLand = /short_touch_land_lottery|lottery_land|luck.?bag|fudai/i.test(text)
        const hasLotteryTaskPanel =
          /福袋/.test(text) && /参与条件|发送评论|加入粉丝团|点亮粉丝团|参与福袋|已参与|等待开奖/.test(text)
        const hasOnlyOtherRedPacket = /红包|red.?packet/i.test(text) && !hasExplicitFudaiText
        if (hasOnlyOtherRedPacket || (hasOnlyGenericLotteryText && !hasShortTouchLotteryLand)) return 0
        let score = 0
        if (/ShortTouchLayout/.test(text)) score += 80
        if (hasShortTouchLotteryLand) score += 90
        if (hasFudaiCountdown) score += 60
        if (hasExplicitFudaiText) score += 40
        if (/福袋/.test(ownText) || /福袋/.test(attrText)) score += 30
        if (hasLotteryTaskPanel) score += 20
        if (/红包|red.?packet/i.test(text)) score -= 80
        return score
      })
      .catch(() => 0)
  }

  private async waitForLotteryClickResult(timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs && this.canWork()) {
      if (this.latestLotteryRight) {
        this.debugLog('点击入口后已捕获福袋任务接口')
        return true
      }
      const hasPanel = await this.hasLotteryPanelSignal()
      if (hasPanel) {
        this.debugLog('点击入口后已检测到福袋面板信号')
        return true
      }
      await this.page.waitForTimeout(250).catch(() => {})
    }
    this.debugLog(`点击入口后 ${timeoutMs}ms 内未捕获福袋接口或面板`)
    return false
  }

  private async hasLotteryPanelSignal(): Promise<boolean> {
    return this.page
      .evaluate(() => {
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
        const visibleText = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="popup"], [class*="panel"], [data-extra*="short_touch"]'))
          .map((node) => normalize(node.textContent || ''))
          .filter(Boolean)
          .join(' ')
        return /福袋/.test(visibleText) && /参与条件|倒计时|开奖|参与福袋|发送评论|加入粉丝团|点亮粉丝团|已参与|等待开奖/.test(visibleText)
      })
      .catch(() => false)
  }

  private async dismissCurrentOverlay(): Promise<void> {
    await this.page.keyboard.press('Escape').catch(() => {})
    await this.page
      .evaluate(() => {
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
          .map((element) => {
            const rect = element.getBoundingClientRect()
            const text = normalize(element.textContent || '')
            const aria = normalize(element.getAttribute('aria-label') || '')
            const visible =
              rect.width >= 8 &&
              rect.height >= 8 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < window.innerHeight &&
              rect.left < window.innerWidth &&
              window.getComputedStyle(element).visibility !== 'hidden'
            const isClose =
              /关闭|收起|取消|×|x/i.test(text) ||
              /关闭|close/i.test(aria) ||
              /lottery_close|close/i.test(String(element.id || '') + ' ' + String(element.className || ''))
            return { element, rect, visible, isClose }
          })
          .filter((item) => item.visible && item.isClose)
          .sort((a, b) => a.rect.top - b.rect.top)
        const target = candidates[0]?.element as HTMLElement | undefined
        target?.click()
      })
      .catch(() => {})
    await this.page.waitForTimeout(200).catch(() => {})
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

    if (!target) {
      await this.logDebugCandidates(options.logLabel)
      this.debugLog(`未找到${options.logLabel}按钮`)
      return false
    }
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
        const ordinaryGiftText = /小心心|热气球|跑车|比心兔兔|人气票|Thuglife|春日蝶舞|亲吻|闪耀星辰|大啤酒|玫瑰|抖音|QQ|WW|EE|送点亮粉丝团|送粉丝团灯牌|送出了|送出|x\s*1|×\s*1/
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
            const precisePaidAction = /^(?:加入粉丝团|点亮粉丝团|点亮灯牌|粉丝团点亮)\s*[（(]\s*\d+\s*钻(?:石)?\s*[）)]$/.test(text)
            const shortPaidAction =
              text.length <= 40 &&
              /(?:加入粉丝团|点亮粉丝团|点亮灯牌|粉丝团点亮)\s*[（(]\s*\d+\s*钻(?:石)?\s*[）)]/.test(text)
            const explicitConfirm = /^(?:确认点亮|确认加入|确认开通|确定|支付|开通粉丝团|点亮粉丝团)$/.test(text)
            const isOrdinaryGiftCell =
              ordinaryGiftText.test(text) ||
              (/^\d+\s*钻(?:石)?/.test(text) && /赠送|送出/.test(text) && !/粉丝团|灯牌|点亮/.test(text))
            const hasFanBadgeContext = contextKeywords.test(ctx) || contextKeywords.test(text)
            const isActionButton = precisePaidAction || shortPaidAction || explicitConfirm
            const isStatusLabel = /未达成|参与条件|倒计时/.test(text) && !isActionButton
            const isUnsafeFeed = rect.left < 150 || /在线观众|贡献用户|加入了直播间|为主播加了|送粉丝团灯牌|送点亮粉丝团/.test(ctx)
            const isLargeContainer = text.length > 60 || rect.width > 380 || rect.height > 90
            const score =
              (precisePaidAction ? 120 : 0) +
              (shortPaidAction ? 90 : 0) +
              (explicitConfirm ? 35 : 0) +
              (keywords.some((keyword) => text.includes(keyword)) ? 12 : 0) +
              (hasFanBadgeContext ? 8 : 0) -
              (isOrdinaryGiftCell ? 100 : 0) -
              (isStatusLabel ? 100 : 0) -
              (isUnsafeFeed ? 120 : 0) -
              (isLargeContainer ? 80 : 0)
            return { element, rect, text, area: rect.width * rect.height, score, hasFanBadgeContext, isOrdinaryGiftCell, isActionButton, isUnsafeFeed, isLargeContainer }
          })
          .filter(({ element, text, score, hasFanBadgeContext, isOrdinaryGiftCell, isActionButton, isUnsafeFeed, isLargeContainer }) =>
            text &&
            score > 0 &&
            hasFanBadgeContext &&
            !isOrdinaryGiftCell &&
            !isUnsafeFeed &&
            !isLargeContainer &&
            isActionButton &&
            isVisible(element)
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
    const clicked = await this.clickPreciseFollowButton()
    if (clicked) {
      await this.randomDelay(500, 900)
      this.callbacks.onLog('已自动关注主播')
      return
    }

    this.callbacks.onLog('未找到可点击关注按钮，可能已经关注或按钮暂未展示')
  }

  private async clickPreciseFollowButton(): Promise<boolean> {
    const target = await this.page
      .evaluate(() => {
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
        const isVisible = (element: Element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || 1) > 0.05 &&
            rect.width >= 20 &&
            rect.height >= 14 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
          )
        }
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span, p'))
          .map((element) => {
            const rect = element.getBoundingClientRect()
            const text = normalize(element.textContent || '')
            const exactFollow = /^(关注|去关注|关注\s*G|关注G)$/.test(text)
            const tinyFollow = /关注/.test(text) && text.length <= 8
            const unsafeContainer = /本场点赞|\+加粉丝团|加会员|小时榜|人气榜|退出直播间|粉丝团|酷炫勋章|专属礼物|进场特效/.test(text)
            const score =
              (exactFollow ? 100 : 0) +
              (tinyFollow ? 30 : 0) +
              (rect.width <= 100 && rect.height <= 40 ? 20 : 0) -
              (unsafeContainer ? 200 : 0) -
              (text.length > 12 ? 80 : 0)
            return { element, rect, text, area: rect.width * rect.height, score }
          })
          .filter(({ element, text, rect, score }) =>
            text &&
            score > 0 &&
            /关注/.test(text) &&
            !/已关注|取消关注/.test(text) &&
            rect.width <= 120 &&
            rect.height <= 48 &&
            isVisible(element)
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

    await this.logDebugCandidates('关注主播')
    if (!target) return false
    await this.page.mouse.click(target.x, target.y)
    this.callbacks.onLog(`已点击关注主播: ${target.text.slice(0, 30)}`)
    return true
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
            const precisePaidAction = /^(?:加入粉丝团|点亮粉丝团|点亮灯牌|粉丝团点亮)\s*[（(]\s*\d+\s*钻(?:石)?\s*[）)]$/.test(text)
            const shortPaidAction =
              text.length <= 40 &&
              /(?:加入粉丝团|点亮粉丝团|点亮灯牌|粉丝团点亮)\s*[（(]\s*\d+\s*钻(?:石)?\s*[）)]/.test(text)
            const shortGenericAction =
              text.length <= 40 &&
              /^(?:去)?(?:加入粉丝团|点亮粉丝团|点亮灯牌|粉丝团点亮|开通粉丝团)(?:并参与|参与)?$/.test(text)
            const isAction = precisePaidAction || shortPaidAction || shortGenericAction
            const isStatusOnly = /未达成|参与条件|发送评论|倒计时/.test(text) && !/[（(]\s*\d+\s*钻(?:石)?\s*[）)]/.test(text)
            const isHeaderCard = rect.top < 170 && /酷炫勋章|专属礼物|进场特效|加会员/.test(ctx)
            const isLargeContainer = text.length > 60 || rect.width > 360 || rect.height > 80
            const isMiddleDialogAction = rect.left >= 120 && rect.top >= 180 && rect.top <= window.innerHeight - 80
            const score =
              (precisePaidAction ? 120 : 0) +
              (shortPaidAction ? 90 : 0) +
              (shortGenericAction ? 55 : 0) +
              (inLotteryTask ? 20 : 0) +
              (isMiddleDialogAction ? 12 : 0) +
              (rect.height >= 28 ? 8 : 0) -
              (isStatusOnly ? 80 : 0) -
              (isHeaderCard ? 80 : 0) -
              (isLargeContainer ? 120 : 0)
            return { element, rect, text, area: rect.width * rect.height, score, isAction, inLotteryTask, isStatusOnly, isHeaderCard, isLargeContainer, isMiddleDialogAction }
          })
          .filter(({ element, text, score, isAction, inLotteryTask, isStatusOnly, isHeaderCard, isLargeContainer, isMiddleDialogAction }) =>
            text &&
            score > 0 &&
            isAction &&
            (inLotteryTask || isMiddleDialogAction) &&
            !isStatusOnly &&
            !isHeaderCard &&
            !isLargeContainer &&
            isVisible(element)
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
    const stats = store.get('runStats')
    const effectiveBudget = config.diamondBudget + (config.allowDiamondProfit ? stats.diamondWonAmount || 0 : 0)
    const remaining = effectiveBudget - config.diamondUsed
    if (remaining < cost) {
      this.callbacks.onFudaiSkipped(`钻石预算不足，剩余=${remaining}，需要=${cost}`)
      return false
    }

    const clickedEntry = await this.clickFanBadgeEntry()
    if (!clickedEntry) {
      if (await this.hasParticipateButton()) {
        this.debugLog('未找到粉丝团按钮，但已出现参与福袋按钮，继续参与流程')
        return true
      }
      this.callbacks.onFudaiSkipped('未找到可点击的加入粉丝团/点亮灯牌入口，已避免点击普通礼物')
      this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
      return false
    }

    await this.randomDelay(600, 1000)
    if (await this.waitForFanBadgeSatisfied(2500)) {
      store.set('diamondUsed', config.diamondUsed + cost)
      this.callbacks.onFanBadgeAdded(cost)
      this.callbacks.onLog(`已确认加入粉丝团/点亮灯牌，花费 ${cost} 钻石`)
      return true
    }

    const confirmed = await this.clickFanBadgeConfirm()
    if (!confirmed) {
      if (await this.hasParticipateButton()) {
        this.debugLog('未找到粉丝团确认按钮，但已出现参与福袋按钮，继续参与流程')
        return true
      }
      this.callbacks.onFudaiSkipped('未找到明确的粉丝团/灯牌确认按钮，已避免误送普通礼物')
      this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
      return false
    }

    const verified = await this.waitForFanBadgeSatisfied(7000)
    if (!verified) {
      if (await this.hasParticipateButton()) {
        this.debugLog('粉丝团任务未明确确认，但已出现参与福袋按钮，继续参与流程')
        store.set('diamondUsed', config.diamondUsed + cost)
        this.callbacks.onFanBadgeAdded(cost)
        return true
      }
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
      keywords: ['去发表评论', '一键发评论', '发评论参与', '评论参与', '发送评论参与', '一键评论', '发评论参与福袋', '一键发评论参与福袋'],
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
      this.callbacks.onFudaiSkipped('福袋弹窗评论按钮点击后未确认任务完成，停止本次参与，避免直接向直播间发送评论')
      this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
      return false
    }

    this.callbacks.onFudaiSkipped('未找到福袋弹窗内的一键评论按钮，已跳过，避免先向直播间输入评论')
    this.failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
    return false
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
    const existingResult = await this.checkParticipateResult()
    if (existingResult.participated) {
      this.handleParticipated(info, existingResult)
      return
    }

    const participateButton = await this.waitForParticipateButton(9000)
    if (!participateButton) {
      const result = await this.checkParticipateResult()
      if (result.participated) {
        this.handleParticipated(info, result)
        return
      }
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
    const result = await this.waitForParticipateResult(9000)
    if (result.participated) {
      this.handleParticipated(info, result)
    } else {
      this.handleParticipated(info, {
        ...result,
        participated: true,
        resultText: result.resultText || '已点击参与按钮，未捕获确认文本'
      })
    }
  }

  private handleParticipated(info: FudaiInfo, result: FudaiGrabResult): void {
    const effectiveRemaining =
      this.latestLotteryRight?.remainingSeconds ??
      (typeof info.drawAt === 'number' && info.drawAt > Date.now()
        ? Math.ceil((info.drawAt - Date.now()) / 1000)
        : info.remainingSeconds)
    const effectiveDrawAt =
      this.latestLotteryRight?.drawAt ??
      info.drawAt ??
      (typeof effectiveRemaining === 'number' && effectiveRemaining > 0 ? Date.now() + effectiveRemaining * 1000 : null)
    const effectiveInfo: FudaiInfo = {
      ...info,
      remainingSeconds: effectiveRemaining,
      drawAt: effectiveDrawAt
    }
    const participationKey = this.getParticipationKey(info)
    const waitMs =
      typeof effectiveInfo.remainingSeconds === 'number' && effectiveInfo.remainingSeconds > 0
        ? effectiveInfo.remainingSeconds * 1000 + AFTER_DRAW_BUFFER_MS
        : DEFAULT_AFTER_PARTICIPATE_WAIT_MS
    this.participatedCooldownUntil = Date.now() + waitMs
    if (this.reportedParticipationKeys.has(participationKey)) return
    this.reportedParticipationKeys.add(participationKey)
    this.callbacks.onLog(`已参与福袋，等待开奖约 ${Math.ceil(waitMs / 1000)} 秒`)
    this.callbacks.onFudaiGrabbed(effectiveInfo, result)
  }

  private getParticipationKey(info: FudaiInfo): string {
    if (this.latestLotteryRight?.lotteryId) return this.latestLotteryRight.lotteryId
    if (typeof info.drawAt === 'number' && info.drawAt > 0) return `drawAt:${Math.round(info.drawAt / 1000)}`
    return `fallback:${info.commentText || ''}:${info.remainingSeconds ?? 'unknown'}`
  }

  private async waitForParticipateButton(timeoutMs: number) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs && this.canWork()) {
      const target = await this.findParticipateButtonTarget()
      if (target) return target
      await this.page.waitForTimeout(400)
    }
    return null
  }

  private async hasParticipateButton(): Promise<boolean> {
    return Boolean(await this.findParticipateButtonTarget())
  }

  private async findParticipateButtonTarget(): Promise<{ click: (options?: { timeout?: number }) => Promise<void> } | null> {
    const target = await this.page
      .evaluate(() => {
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
        const isVisible = (element: Element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || 1) > 0.05 &&
            rect.width >= 40 &&
            rect.height >= 20 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
          )
        }
        const hasLotteryContext = (element: Element) => {
          let current: Element | null = element
          for (let depth = 0; current && depth < 8; depth++) {
            const text = normalize(current.textContent || '')
            if (/福袋|参与条件|倒计时|开奖|中奖|钻/.test(text)) return true
            current = current.parentElement
          }
          return false
        }

        const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span, p'))
          .map((element) => {
            const rect = element.getBoundingClientRect()
            const text = normalize(element.textContent || '')
            const exactAction = /^(参与福袋|立即参与|参与抽奖|抢福袋|报名)$/.test(text)
            const shortAction = text.length <= 20 && /参与福袋|立即参与|参与抽奖|抢福袋|报名/.test(text)
            const isAction = exactAction || shortAction
            const statusOnly = /已参与|等待开奖|参与成功|已成功参与/.test(text)
            const largeContainer = text.length > 60 || rect.width > 380 || rect.height > 90
            const score =
              (exactAction ? 100 : 0) +
              (shortAction ? 60 : 0) +
              (hasLotteryContext(element) ? 15 : 0) +
              (rect.height >= 32 ? 5 : 0) -
              (statusOnly ? 150 : 0) -
              (largeContainer ? 120 : 0)
            return { rect, text, area: rect.width * rect.height, score, element, isAction }
          })
          .filter(({ element, text, score, isAction }) => text && isAction && score > 0 && isVisible(element))
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

        const best = candidates[0]
        if (!best) return null
        return {
          x: best.rect.left + best.rect.width / 2,
          y: best.rect.top + best.rect.height / 2,
          text: best.text
        }
      })
      .catch(() => null)

    await this.logDebugCandidates('参与按钮')
    if (!target) return null
    return {
      click: async () => {
        await this.page.mouse.click(target.x, target.y)
      }
    }
  }

  private async checkParticipateResult(): Promise<FudaiGrabResult> {
    const resultText = await this.page.evaluate(() => document.body.innerText.slice(0, 6000)).catch(() => '')
    const compactText = resultText.replace(/\s+/g, ' ')
    const participated =
      /参与成功|报名成功|等待开奖|成功参与|已成功参与/.test(compactText) ||
      /(?:福袋|抽奖).{0,120}已参与|已参与.{0,120}(?:福袋|开奖|等待)/.test(compactText)
    const won = /恭喜.{0,30}(?:中奖|获得|抽中)|你已中奖|您已中奖|中奖成功|获得奖品/.test(compactText)
    const hasCoupon = /优惠券|券|coupon/i.test(compactText)
    const hasDiamond = /钻石|抖币|diamond/i.test(compactText)
    const hasPhysical = /实物|填写地址|收货地址|奖品|包邮/.test(compactText)

    let prizeType: FudaiGrabResult['prizeType'] = null
    if (won && hasCoupon) prizeType = 'coupon'
    else if (won && hasDiamond) prizeType = 'diamond'
    else if (won && hasPhysical) prizeType = 'physical'
    else if (won) prizeType = 'unknown'
    const diamondAmount =
      prizeType === 'diamond'
        ? Number(
            compactText.match(/(?:恭喜|中奖|抽中|获得|中了)[^。！!，,]{0,80}?(\d{1,5})\s*(?:钻石|钻|抖币)/)?.[1] ||
              compactText.match(/(?:获得|奖品[：:]?)\s*(\d{1,5})\s*(?:钻石|钻|抖币)/)?.[1] ||
              0
          )
        : 0

    return {
      participated,
      won,
      prizeType,
      diamondAmount,
      resultText: compactText.slice(0, 180)
    }
  }

  private async waitForParticipateResult(timeoutMs: number): Promise<FudaiGrabResult> {
    const startedAt = Date.now()
    let lastResult: FudaiGrabResult = {
      participated: false,
      won: false,
      prizeType: null,
      diamondAmount: 0,
      resultText: ''
    }

    while (Date.now() - startedAt < timeoutMs && this.canWork()) {
      lastResult = await this.checkParticipateResult()
      if (lastResult.participated) return lastResult
      await this.page.waitForTimeout(500).catch(() => {})
    }

    return lastResult
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
    const shareCondition = conditions.find((condition: any) => Number(condition.type) === 4 || /分享/.test(String(condition.description || condition.content || '')))
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
    const baseTime = currentTime ?? Date.now()
    const clientServerOffset = Date.now() - baseTime
    const remainingFromDraw =
      drawTime && drawTime > baseTime ? Math.floor((drawTime - baseTime) / 1000) : null
    const countDown = Number(lotteryInfo.count_down)
    const remainingFromCountDown = Number.isFinite(countDown) && countDown > 0 ? Math.floor(countDown) : null
    const remainingSeconds =
      remainingFromDraw !== null && remainingFromDraw > 0 ? remainingFromDraw : remainingFromCountDown
    const drawAt =
      drawTime && drawTime > baseTime
        ? drawTime + clientServerOffset
        : remainingFromCountDown !== null
          ? Date.now() + remainingFromCountDown * 1000
          : null

    return {
      lotteryId: String(lotteryInfo.lottery_id_str || lotteryInfo.lottery_id || ''),
      requiresFollow: userCondition.has_follow === false || /关注/.test(conditionText),
      requiresFanBadge:
        userCondition.is_fansclub_member === false &&
        (/粉丝团|灯牌|fans|club/i.test(conditionText) || userCondition.fansclub_status_active === false),
      requiresComment: userCondition.has_command === false || /口令|评论|发送/.test(conditionText),
      requiresShare: Boolean(shareCondition) || /分享/.test(conditionText),
      commentText: commandText,
      fanBadgeCost: Math.max(1, Number(conditionText.match(/(\d{1,3})\s*(?:钻石|抖币)/)?.[1] || 1)),
      remainingSeconds,
      drawAt
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

  private async describeElementForDebug(
    handle: ElementHandle<Node>,
    score: number
  ): Promise<{ text: string; x: number; y: number; w: number; h: number; score: number } | null> {
    if (!this.debugEnabled()) return null
    return handle
      .evaluate(
        (node, entryScore) => {
          if (!(node instanceof Element)) return null
          const rect = node.getBoundingClientRect()
          const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
          const attrText = [
            node.id || '',
            String(node.className || ''),
            node.getAttribute('data-extra') || '',
            node.getAttribute('data-short-touch-landing') || '',
            node.getAttribute('data-e2e') || '',
            node.getAttribute('aria-label') || '',
            node.getAttribute('alt') || ''
          ].join(' ')
          return {
            text: normalize(`${attrText} ${node.textContent || ''}`).slice(0, 100),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            score: entryScore
          }
        },
        score
      )
      .catch(() => null)
  }

  private async debugLotteryContext(label: string): Promise<void> {
    if (!this.debugEnabled()) return
    const context = await this.page
      .evaluate(() => {
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
        const text = normalize(document.body.innerText || '')
        const panels = Array.from(
          document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="popup"], [class*="panel"], [data-extra*="short_touch"], #ShortTouchLayout')
        )
          .map((node) => normalize(node.textContent || ''))
          .filter(Boolean)
          .sort((a, b) => b.length - a.length)
          .slice(0, 3)
        return {
          hasFudaiText: /福袋/.test(text),
          hasRedPacketText: /红包|red.?packet/i.test(text),
          hasLotteryTaskText: /参与条件|发送评论|加入粉丝团|点亮粉丝团|参与福袋|已参与|等待开奖/.test(text),
          hasCountdownText: /\b\d{1,2}:\d{2}\b/.test(text),
          panels: panels.map((value) => value.slice(0, 220))
        }
      })
      .catch((e: any) => ({ error: e?.message || String(e) }))
    this.callbacks.onLog(`[debug] ${label}页面上下文: ${JSON.stringify(context).slice(0, 900)}`)
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
