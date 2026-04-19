import { Page } from 'playwright'
import { BrowserManager } from './browser-manager'
import { logError, logInfo } from './logger'
import { analyzeWebSocketFrame } from './ws-analyzer'

export interface DiscoveryOptions {
  sourceUrl?: string
  maxRooms?: number
}

export interface DiscoveredRoom {
  url: string
  name: string
  reason: string
  countdownText: string
  remainingSeconds: number | null
}

export type CountdownSource = 'websocket' | 'network' | 'modal' | 'visible-dom' | 'text' | null
export type CountdownConfidence = 'exact' | 'estimated' | 'unknown'

export interface VerifiedFudaiRoom extends DiscoveredRoom {
  verifiedAt: number
  hasFudai: boolean
  score: number
  matchedSignals: string[]
  drawAt: number | null
  countdownSource: CountdownSource
  countdownConfidence: CountdownConfidence
}

export interface VerifyRoomResult {
  room: VerifiedFudaiRoom | null
  riskDetected: boolean
  riskReason: string
  page?: Page
}

export interface VerifyRoomOptions {
  keepPageOnVerified?: boolean
}

interface CountdownEvidence {
  remainingSeconds: number | null
  drawAt: number | null
  source: CountdownSource
  confidence: CountdownConfidence
}

interface SignalSample {
  name: string
  countdownText: string
  remainingSeconds: number | null
  matchedSignals: string[]
  countdownSource: CountdownSource
  countdownConfidence: CountdownConfidence
}

const DEFAULT_SOURCE_URLS = ['https://live.douyin.com']
const DEFAULT_MAX_ROOMS = 20
const VERIFY_DWELL_MIN_MS = 20000
const VERIFY_DWELL_MAX_MS = 32000
const VERIFY_SAMPLE_INTERVAL_MS = 5000
const VERIFY_MAX_REASONABLE_REMAINING_SECONDS = 15 * 60
const FUDAI_ENTRY_SELECTOR = [
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
].join(', ')

const RESERVED_ROOM_KEYS = new Set([
  'webcast',
  'live_communication',
  'search',
  'category',
  'follow',
  'user',
  'download',
  'passport',
  'login',
  'share',
  'favicon'
])

const UUID_ROOM_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class DiscoveryService {
  private browserManager: BrowserManager
  private page: Page | null = null
  private verifyingPages: Set<Page> = new Set()
  private onLog: ((message: string) => void) | null = null

  constructor(browserManager: BrowserManager) {
    this.browserManager = browserManager
  }

  setLogger(onLog: (message: string) => void): void {
    this.onLog = onLog
  }

  async scan(options: DiscoveryOptions = {}): Promise<DiscoveredRoom[]> {
    const sourceUrls = this.getSourceUrls(options.sourceUrl)
    const maxRooms = options.maxRooms || DEFAULT_MAX_ROOMS
    const page = await this.getPage()
    const mergedRooms = new Map<string, DiscoveredRoom>()

    for (const sourceUrl of sourceUrls) {
      const pendingResponses: Promise<void>[] = []
      const responseHandler = (response: any) => {
        const task = this.collectRoomsFromResponse(response)
          .then((rooms) => rooms.forEach((room) => mergedRooms.set(room.url, room)))
          .catch(() => {})
        pendingResponses.push(task)
      }

      this.log(`开始扫描直播入口: ${sourceUrl}`)
      page.on('response', responseHandler)
      await page.bringToFront().catch(() => {})

      try {
        await this.browserManager.getSourceNavQueue().run(
          'discover:source',
          () => page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }),
          (message) => this.log(message)
        )

        const challenge = await this.getChallengeReason(page)
        if (challenge) {
          this.log(`扫描入口时检测到风控页面: ${challenge}`)
          continue
        }

        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
        await this.scrollSourcePage(page)
        await page.waitForTimeout(1000)

        const domRooms = await this.extractRoomsFromDom(page)
        for (const room of domRooms) mergedRooms.set(room.url, room)
      } catch (e: any) {
        this.log(`扫描入口失败: ${e.message}`)
        logError('discover', `scan source failed: ${sourceUrl}`, e)
      } finally {
        page.off('response', responseHandler)
        await Promise.allSettled(pendingResponses)
      }
    }

    const sortedRooms = Array.from(mergedRooms.values())
      .filter((room) => this.isValidRoomUrl(room.url))
      .sort((a, b) => {
        if (a.remainingSeconds === null && b.remainingSeconds === null) return 0
        if (a.remainingSeconds === null) return 1
        if (b.remainingSeconds === null) return -1
        return a.remainingSeconds - b.remainingSeconds
      })
      .slice(0, maxRooms)

    this.log(`扫描完成，发现 ${sortedRooms.length} 个直播间候选`)
    logInfo('discover', `scan complete candidates=${sortedRooms.length}`)
    return sortedRooms
  }

  async verifyRoom(room: DiscoveredRoom, options: VerifyRoomOptions = {}): Promise<VerifyRoomResult> {
    if (!this.isValidRoomUrl(room.url)) {
      this.log(`跳过无效候选地址: ${room.url}`)
      return { room: null, riskDetected: false, riskReason: 'invalid-url' }
    }

    const context = await this.browserManager.getContext()
    let page: Page | null = null
    let shouldClosePage = true

    try {
      page = await context.newPage()
      this.verifyingPages.add(page)
      const matchedSignals = new Set<string>()
      let websocketRemainingSeconds: number | null = null
      const networkCountdowns: CountdownEvidence[] = []

      const responseHandler = (response: any) => {
        void this.collectCountdownFromResponse(response)
          .then((evidence) => {
            if (!evidence) return
            networkCountdowns.push(evidence)
            matchedSignals.add('network')
            matchedSignals.add('countdown')
            matchedSignals.add('text')
            matchedSignals.add('lottery-text')
          })
          .catch(() => {})
      }
      page.on('response', responseHandler)

      page.on('websocket', (ws) => {
        ws.on('framereceived', (frame) => {
          try {
            const info = analyzeWebSocketFrame(frame.payload)
            if (!info) return
            matchedSignals.add('websocket')
            if (info.requiresFollow) matchedSignals.add('requires-follow')
            if (info.requiresFanBadge) matchedSignals.add('requires-fan-badge')
            if (info.requiresComment) matchedSignals.add('requires-comment')
            websocketRemainingSeconds = info.remainingSeconds ?? websocketRemainingSeconds
            if (info.remainingSeconds !== null && info.remainingSeconds !== undefined) {
              matchedSignals.add('countdown')
            }
          } catch {
            // Ignore transient frame parse errors while probing candidates.
          }
        })
      })

      this.log(`验证候选直播间: ${room.name || room.url} <${room.url}>`)
      await this.browserManager.getLiveRoomVerifyNavQueue().run(
        'discover:verify-room',
        () => page!.goto(room.url, { waitUntil: 'domcontentloaded', timeout: 30000 }),
        (message) => this.log(message)
      )

      await page.waitForSelector('body', { timeout: 10000 }).catch(() => {})
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
      const endedBeforeSample = await this.getEndedLiveReason(page)
      if (endedBeforeSample) {
        this.log(`候选直播已结束，跳过验证: ${room.name || room.url}，原因=${endedBeforeSample}`)
        return { room: null, riskDetected: false, riskReason: 'live-ended' }
      }
      await this.simulateLightRead(page)
      const domResult = await this.sampleFudaiSignals(
        page,
        room,
        matchedSignals,
        () => websocketRemainingSeconds,
        () => this.pickBestNetworkCountdown(networkCountdowns)
      )

      const challenge = await this.getChallengeReason(page)
      if (challenge) {
        this.log(`验证直播间时检测到风控页面: ${challenge}`)
        return { room: null, riskDetected: true, riskReason: challenge }
      }
      const endedAfterSample = await this.getEndedLiveReason(page)
      if (endedAfterSample) {
        this.log(`候选直播已结束，跳过验证: ${room.name || room.url}，原因=${endedAfterSample}`)
        return { room: null, riskDetected: false, riskReason: 'live-ended' }
      }

      const countdown = this.pickBestCountdown({
        websocketRemainingSeconds,
        networkCountdown: this.pickBestNetworkCountdown(networkCountdowns),
        domResult,
        fallbackRemainingSeconds: room.remainingSeconds
      })
      const remainingSeconds = countdown.remainingSeconds
      if (this.hasTaskCountdownSignal(matchedSignals, remainingSeconds)) matchedSignals.add('task-countdown')
      if (countdown.source) matchedSignals.add(`countdown-${countdown.source}`)

      const signals = Array.from(matchedSignals)
      const score = this.scoreSignals(signals, remainingSeconds)
      const hasTaskCountdownSignal = this.hasTaskCountdownSignal(matchedSignals, remainingSeconds)
      const hasStrongSignal =
        matchedSignals.has('websocket') ||
        (matchedSignals.has('entry-visible') && matchedSignals.has('countdown')) ||
        (matchedSignals.has('text') && matchedSignals.has('lottery-text')) ||
        hasTaskCountdownSignal

      if ((score >= 6 && hasStrongSignal) || (score >= 4 && hasTaskCountdownSignal)) {
        const verifiedRoom: VerifiedFudaiRoom = {
          ...room,
          name: domResult.name || room.name,
          reason: `${room.reason || 'candidate'}, verified`,
          countdownText: domResult.countdownText || room.countdownText,
          remainingSeconds,
          hasFudai: true,
          score,
          matchedSignals: signals,
          verifiedAt: Date.now(),
          drawAt: countdown.drawAt,
          countdownSource: countdown.source,
          countdownConfidence: countdown.confidence
        }
        if (options.keepPageOnVerified) shouldClosePage = false
        this.log(
          `验证通过: ${verifiedRoom.name}，score=${score}，signals=${signals.join(',') || 'none'}，剩余=${remainingSeconds ?? '未知'}秒，倒计时来源=${countdown.source ?? '未知'}，可信度=${countdown.confidence}`
        )
        return {
          room: verifiedRoom,
          riskDetected: false,
          riskReason: '',
          page: options.keepPageOnVerified && page ? page : undefined
        }
      }

      this.log(`候选未通过福袋验证: ${room.name || room.url}，score=${score}，signals=${signals.join(',') || 'none'}`)
      return { room: null, riskDetected: false, riskReason: '' }
    } catch (e: any) {
      logError('discover', `verify failed: ${room.url}`, e)
      this.log(`验证候选失败: ${room.name || room.url}，${e.message}`)
      return { room: null, riskDetected: false, riskReason: e.message || String(e) }
    } finally {
      if (page) page.removeAllListeners('response')
      if (shouldClosePage && page && !page.isClosed()) await page.close().catch(() => {})
      if (page) this.verifyingPages.delete(page)
    }
  }

  async verifyRooms(rooms: DiscoveredRoom[], limit = 1): Promise<VerifiedFudaiRoom[]> {
    const verifiedRooms: VerifiedFudaiRoom[] = []
    for (const room of rooms.slice(0, limit)) {
      const result = await this.verifyRoom(room)
      if (result.room) verifiedRooms.push(result.room)
      if (result.riskDetected) break
    }
    this.log(`批量验证完成，确认 ${verifiedRooms.length} 个有福袋迹象的直播间`)
    return verifiedRooms
  }

  async close(): Promise<void> {
    for (const page of Array.from(this.verifyingPages)) {
      if (!page.isClosed()) await page.close().catch(() => {})
    }
    this.verifyingPages.clear()
    if (this.page && !this.page.isClosed()) await this.page.close()
    this.page = null
  }

  async closeCurrentPage(): Promise<void> {
    const verifyingPage = Array.from(this.verifyingPages).at(-1)
    if (verifyingPage && !verifyingPage.isClosed()) {
      await verifyingPage.close().catch(() => {})
      this.verifyingPages.delete(verifyingPage)
      return
    }
    if (this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => {})
      this.page = null
    }
  }

  private async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page
    const context = await this.browserManager.getContext()
    this.page = await context.newPage()
    return this.page
  }

  private async extractRoomsFromDom(page: Page): Promise<DiscoveredRoom[]> {
    return page.evaluate(() => {
      type Candidate = {
        url: string
        name: string
        reason: string
        countdownText: string
        remainingSeconds: number | null
      }

      const reservedKeys = new Set([
        'webcast',
        'live_communication',
        'search',
        'category',
        'follow',
        'user',
        'download',
        'passport',
        'login',
        'share',
        'favicon'
      ])

      const parseRemainingSeconds = (text: string): number | null => {
        const normalized = text.replace(/\s+/g, '')
        const hhmmss = normalized.match(/(\d{1,2}):(\d{1,2}):(\d{1,2})/)
        if (hhmmss) return Number(hhmmss[1]) * 3600 + Number(hhmmss[2]) * 60 + Number(hhmmss[3])
        const mmss = normalized.match(/(\d{1,2}):(\d{1,2})/)
        if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2])
        const minSec = normalized.match(/(?:(\d+)分)?(\d+)秒/)
        if (minSec) return Number(minSec[1] || 0) * 60 + Number(minSec[2])
        const minutes = normalized.match(/(\d+)分钟/)
        if (minutes) return Number(minutes[1]) * 60
        return null
      }

      const isValidRoomKey = (key: string): boolean => {
        const normalized = key.trim().replace(/^\/+|\/+$/g, '')
        if (!/^[A-Za-z0-9_-]{5,}$/.test(normalized)) return false
        if (reservedKeys.has(normalized.toLowerCase())) return false
        if (/^[A-Za-z_]+$/.test(normalized)) return false
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) return false
        if (normalized.length === 36 && normalized.split('-').length === 5) return false
        return true
      }

      const normalizeUrl = (href: string): string => {
        try {
          const url = new URL(href, location.origin)
          const roomKey = url.pathname.split('/').filter(Boolean)[0] || ''
          if (!url.hostname.endsWith('live.douyin.com') || !isValidRoomKey(roomKey)) return ''
          url.pathname = `/${roomKey}`
          url.hash = ''
          url.search = ''
          return url.toString()
        } catch {
          return ''
        }
      }

      const candidates = new Map<string, Candidate>()
      const keywords = ['福袋', '开奖', '倒计时', '参与', '口令', '粉丝团']
      const pushCandidate = (href: string, text: string, reasonFallback: string) => {
        const url = normalizeUrl(href)
        if (!url) return
        const cleanText = text.replace(/\s+/g, ' ').trim()
        const matchedKeywords = keywords.filter((keyword) => cleanText.includes(keyword))
        const roomKey = url.match(/live\.douyin\.com\/([A-Za-z0-9_-]+)/)?.[1] || ''
        candidates.set(url, {
          url,
          name: cleanText.slice(0, 40) || `直播间 ${roomKey}`,
          reason: matchedKeywords.length > 0 ? matchedKeywords.join(',') : reasonFallback,
          countdownText: cleanText.slice(0, 120),
          remainingSeconds: parseRemainingSeconds(cleanText)
        })
      }

      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
      for (const anchor of anchors) {
        const container = anchor.closest('[class*="card"], [class*="item"], [class*="room"], [data-e2e]') || anchor
        const text = (container.textContent || anchor.textContent || '').trim()
        pushCandidate(anchor.href, text || anchor.href, 'live-link')
      }

      return Array.from(candidates.values())
    })
  }

  private async evaluateFudaiSignals(page: Page, fallback: DiscoveredRoom): Promise<SignalSample> {
    return page.evaluate(
      ({ fallbackName, fallbackCountdown, fallbackRemaining, selector }) => {
        const parseRemainingSeconds = (text: string): number | null => {
          const normalized = text.replace(/\s+/g, '')
          const hhmmss = normalized.match(/(\d{1,2}):(\d{1,2}):(\d{1,2})/)
          if (hhmmss) return Number(hhmmss[1]) * 3600 + Number(hhmmss[2]) * 60 + Number(hhmmss[3])
          const mmss = normalized.match(/(\d{1,2}):(\d{1,2})/)
          if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2])
          const minSec = normalized.match(/(?:(\d+)分)?(\d+)秒/)
          if (minSec) return Number(minSec[1] || 0) * 60 + Number(minSec[2])
          const minutes = normalized.match(/(\d+)分钟/)
          if (minutes) return Number(minutes[1]) * 60
          return null
        }

        const isVisible = (element: Element | null): boolean => {
          if (!element) return false
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0 && rect.width >= 8 && rect.height >= 8
        }

        const bodyText = document.body.innerText || ''
        const signals: string[] = []
        const visibleEntry = Array.from(document.querySelectorAll(selector)).some(isVisible)
        if (visibleEntry) signals.push('entry-visible')

        const shortTouchCountdownNode = Array.from(
          document.querySelectorAll('#ShortTouchLayout .ycjwPFJI, #ShortTouchLayout [class*="countdown"]')
        ).find((node) => isVisible(node) && parseRemainingSeconds(node.textContent || '') !== null)
        const shortTouchRemaining = shortTouchCountdownNode ? parseRemainingSeconds(shortTouchCountdownNode.textContent || '') : null
        if (shortTouchRemaining !== null) {
          signals.push('entry-visible')
          signals.push('shorttouch-countdown')
        }

        if (/福袋|超级福袋|粉丝福袋|开福袋|抢福袋/.test(bodyText)) signals.push('text')
        if (/开奖|倒计时|等待开奖|参与抽奖|立即参与|已参与/.test(bodyText)) signals.push('lottery-text')
        if (/口令|评论|粉丝团|灯牌|关注主播|加入粉丝团/.test(bodyText)) signals.push('task-text')
        if (/关注/.test(bodyText)) signals.push('requires-follow')
        if (/粉丝团|灯牌/.test(bodyText)) signals.push('requires-fan-badge')
        if (/口令|评论/.test(bodyText)) signals.push('requires-comment')

        const remainingSeconds = shortTouchRemaining ?? parseRemainingSeconds(bodyText) ?? fallbackRemaining
        if (remainingSeconds !== null) signals.push('countdown')

        const title = document.title.replace(/- 抖音直播.*$/, '').trim() || fallbackName || '直播间'
        return {
          name: title.slice(0, 40),
          countdownText: bodyText.replace(/\s+/g, ' ').slice(0, 160) || fallbackCountdown,
          remainingSeconds,
          matchedSignals: signals,
          countdownSource: shortTouchRemaining !== null ? 'visible-dom' : remainingSeconds !== null ? 'text' : null,
          countdownConfidence: remainingSeconds !== null ? 'estimated' : 'unknown'
        }
      },
      {
        fallbackName: fallback.name,
        fallbackCountdown: fallback.countdownText,
        fallbackRemaining: fallback.remainingSeconds,
        selector: FUDAI_ENTRY_SELECTOR
      }
    )
  }

  private async sampleFudaiSignals(
    page: Page,
    fallback: DiscoveredRoom,
    matchedSignals: Set<string>,
    getWebsocketRemainingSeconds: () => number | null,
    getNetworkCountdown: () => CountdownEvidence | null
  ): Promise<SignalSample> {
    const startedAt = Date.now()
    const dwellMs = this.randomBetween(VERIFY_DWELL_MIN_MS, VERIFY_DWELL_MAX_MS)
    let bestResult = await this.evaluateFudaiSignals(page, fallback)
    bestResult.matchedSignals.forEach((signal) => matchedSignals.add(signal))

    while (Date.now() - startedAt < dwellMs) {
      const remainingSeconds =
        getWebsocketRemainingSeconds() ??
        getNetworkCountdown()?.remainingSeconds ??
        bestResult.remainingSeconds ??
        fallback.remainingSeconds
      const score = this.scoreSignals(Array.from(matchedSignals), remainingSeconds)
      const hasTaskCountdownSignal = this.hasTaskCountdownSignal(matchedSignals, remainingSeconds)
      const hasStrongSignal =
        matchedSignals.has('websocket') ||
        (matchedSignals.has('entry-visible') && matchedSignals.has('countdown')) ||
        (matchedSignals.has('text') && matchedSignals.has('lottery-text')) ||
        hasTaskCountdownSignal

      if ((score >= 6 && hasStrongSignal) || (score >= 4 && hasTaskCountdownSignal)) break

      await page.waitForTimeout(Math.min(VERIFY_SAMPLE_INTERVAL_MS, Math.max(1000, dwellMs - (Date.now() - startedAt))))
      await this.simulateLightRead(page)
      const nextResult = await this.evaluateFudaiSignals(page, fallback)
      nextResult.matchedSignals.forEach((signal) => matchedSignals.add(signal))
      bestResult = this.mergeSignalResult(bestResult, nextResult)
    }

    return bestResult
  }

  private mergeSignalResult(current: SignalSample, next: SignalSample): SignalSample {
    return {
      name: next.name || current.name,
      countdownText: next.countdownText.length > current.countdownText.length ? next.countdownText : current.countdownText,
      remainingSeconds: next.remainingSeconds ?? current.remainingSeconds,
      matchedSignals: Array.from(new Set([...current.matchedSignals, ...next.matchedSignals])),
      countdownSource: next.countdownSource || current.countdownSource,
      countdownConfidence:
        this.rankCountdownConfidence(next.countdownConfidence) >= this.rankCountdownConfidence(current.countdownConfidence)
          ? next.countdownConfidence
          : current.countdownConfidence
    }
  }

  private pickBestCountdown(input: {
    websocketRemainingSeconds: number | null
    networkCountdown: CountdownEvidence | null
    domResult: SignalSample
    fallbackRemainingSeconds: number | null
  }): CountdownEvidence {
    if (input.websocketRemainingSeconds !== null) return this.createCountdownEvidence(input.websocketRemainingSeconds, 'websocket', 'exact')
    if (input.networkCountdown?.remainingSeconds !== null && input.networkCountdown?.remainingSeconds !== undefined) return input.networkCountdown
    if (input.domResult.remainingSeconds !== null) {
      return this.createCountdownEvidence(input.domResult.remainingSeconds, input.domResult.countdownSource || 'text', input.domResult.countdownConfidence)
    }
    if (input.fallbackRemainingSeconds !== null) return this.createCountdownEvidence(input.fallbackRemainingSeconds, 'text', 'estimated')
    return { remainingSeconds: null, drawAt: null, source: null, confidence: 'unknown' }
  }

  private pickBestNetworkCountdown(evidenceList: CountdownEvidence[]): CountdownEvidence | null {
    return (
      evidenceList
        .filter((item) => item.remainingSeconds !== null && item.remainingSeconds > 0)
        .sort((a, b) => {
          const confidenceDiff = this.rankCountdownConfidence(b.confidence) - this.rankCountdownConfidence(a.confidence)
          if (confidenceDiff !== 0) return confidenceDiff
          return (a.remainingSeconds || Number.MAX_SAFE_INTEGER) - (b.remainingSeconds || Number.MAX_SAFE_INTEGER)
        })[0] || null
    )
  }

  private createCountdownEvidence(remainingSeconds: number, source: CountdownSource, confidence: CountdownConfidence): CountdownEvidence {
    const normalized = Math.max(0, Math.floor(remainingSeconds))
    return {
      remainingSeconds: normalized,
      drawAt: Date.now() + normalized * 1000,
      source,
      confidence
    }
  }

  private rankCountdownConfidence(confidence: CountdownConfidence): number {
    if (confidence === 'exact') return 3
    if (confidence === 'estimated') return 2
    return 1
  }

  private async collectCountdownFromResponse(response: any): Promise<CountdownEvidence | null> {
    const url = response.url()
    if (!/douyin|webcast|live|amemv|snssdk/i.test(url)) return null
    const contentType = response.headers()['content-type'] || ''
    if (!/json|text|javascript|html/i.test(contentType)) return null

    const text = await response.text().catch(() => '')
    if (!text || text.length > 2_000_000) return null
    const structuredEvidence = this.extractLotteryCountdownFromJsonText(text, url)
    if (structuredEvidence) return structuredEvidence
    return null
  }

  private extractLotteryCountdownFromJsonText(text: string, url: string): CountdownEvidence | null {
    if (!/\/webcast\/lottery\/|lottery_info|lottery_id|count_down|draw_time/i.test(url + text.slice(0, 5000))) return null

    let payload: any
    try {
      payload = JSON.parse(text)
    } catch {
      return null
    }

    const lotteryInfo = this.findLotteryInfo(payload)
    if (!lotteryInfo) return null

    const currentTime = this.normalizeTimestamp(lotteryInfo.current_time ?? payload?.extra?.now)
    const drawTime = this.normalizeTimestamp(lotteryInfo.draw_time ?? lotteryInfo.real_draw_time ?? lotteryInfo.end_time ?? lotteryInfo.expire_time)
    if (drawTime && drawTime > 0) {
      const base = currentTime && currentTime > 0 ? currentTime : Date.now()
      const remainingSeconds = Math.floor((drawTime - base) / 1000)
      if (remainingSeconds > 0 && remainingSeconds <= 24 * 60 * 60) {
        const serverNow = currentTime && currentTime > 0 ? currentTime : Date.now()
        const clientServerOffset = Date.now() - serverNow
        return {
          remainingSeconds,
          drawAt: drawTime + clientServerOffset,
          source: 'network',
          confidence: 'exact'
        }
      }
    }

    const countDown = Number(
      lotteryInfo.count_down ?? lotteryInfo.countdown ?? lotteryInfo.left_time ?? lotteryInfo.remaining_time ?? lotteryInfo.remain_time
    )
    if (Number.isFinite(countDown) && countDown > 0 && countDown <= 24 * 60 * 60) {
      return this.createCountdownEvidence(countDown, 'network', 'exact')
    }

    return null
  }

  private findLotteryInfo(value: any): any | null {
    if (!value || typeof value !== 'object') return null
    if (value.lottery_info && typeof value.lottery_info === 'object') return value.lottery_info
    if (
      ('lottery_id' in value || 'lottery_id_str' in value) &&
      ('count_down' in value || 'draw_time' in value || 'current_time' in value)
    ) {
      return value
    }

    for (const child of Object.values(value)) {
      const found = this.findLotteryInfo(child)
      if (found) return found
    }
    return null
  }

  private normalizeTimestamp(value: any): number | null {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return null
    return numeric > 10_000_000_000 ? numeric : numeric * 1000
  }

  private extractCountdownEvidenceFromText(text: string, source: CountdownSource): CountdownEvidence | null {
    if (!this.hasFudaiNetworkContext(text)) return null

    const now = Date.now()
    const timestampPatterns = [
      /"[^"]*(?:lottery|lucky|luck|redpacket|red_packet|fudai|draw|award)[^"]*(?:draw_time|drawTime|end_time|endTime|expire_time|expireTime|deadline|open_time|openTime|lottery_time|lotteryTime)[^"]*"\s*:\s*"?(\d{10,13})"?/gi,
      /"[^"]*(?:draw_time|drawTime|end_time|endTime|expire_time|expireTime|deadline|open_time|openTime|lottery_time|lotteryTime)[^"]*(?:lottery|lucky|luck|redpacket|red_packet|fudai|draw|award)[^"]*"\s*:\s*"?(\d{10,13})"?/gi
    ]
    for (const pattern of timestampPatterns) {
      const match = pattern.exec(text)
      if (!match) continue
      const raw = Number(match[1])
      const timestamp = raw > 10_000_000_000 ? raw : raw * 1000
      const remainingSeconds = Math.floor((timestamp - now) / 1000)
      if (remainingSeconds > 0 && remainingSeconds <= 24 * 60 * 60) {
        return { remainingSeconds, drawAt: timestamp, source, confidence: 'exact' }
      }
    }

    const secondsPatterns = [
      /"[^"]*(?:lottery|lucky|luck|redpacket|red_packet|fudai|draw|award)[^"]*(?:countdown|count_down|left_time|leftTime|remaining_time|remainingTime|remain_time|remainTime|draw_time|drawTime|end_time|endTime)[^"]*"\s*:\s*"?(\d{1,5})"?/gi,
      /"[^"]*(?:countdown|count_down|left_time|leftTime|remaining_time|remainingTime|remain_time|remainTime|draw_time|drawTime|end_time|endTime)[^"]*(?:lottery|lucky|luck|redpacket|red_packet|fudai|draw|award)[^"]*"\s*:\s*"?(\d{1,5})"?/gi
    ]
    for (const pattern of secondsPatterns) {
      const match = pattern.exec(text)
      if (!match) continue
      const remainingSeconds = Number(match[1])
      if (remainingSeconds > 0 && remainingSeconds <= 24 * 60 * 60) return this.createCountdownEvidence(remainingSeconds, source, 'exact')
    }

    const parsedTextCountdown = this.parseRemainingSeconds(text)
    if (
      this.hasStrongFudaiNetworkContext(text) &&
      parsedTextCountdown !== null &&
      parsedTextCountdown > 0 &&
      parsedTextCountdown <= VERIFY_MAX_REASONABLE_REMAINING_SECONDS
    ) {
      return this.createCountdownEvidence(parsedTextCountdown, source, 'estimated')
    }

    return null
  }

  private hasFudaiNetworkContext(text: string): boolean {
    if (/福袋|超级福袋|粉丝福袋|fudai|luck_bag|lucky_bag|luckybag|lottery/i.test(text)) return true
    const hasDrawContext = /抽奖|开奖|draw|award|prize/i.test(text)
    const hasTaskContext = /口令|评论|粉丝团|灯牌|关注主播|加入粉丝团|participate|follow|fans/i.test(text)
    return hasDrawContext && hasTaskContext
  }

  private hasStrongFudaiNetworkContext(text: string): boolean {
    return /福袋|超级福袋|粉丝福袋|fudai|luck_bag|lucky_bag|luckybag|lottery/i.test(text)
  }

  private scoreSignals(signals: string[], remainingSeconds: number | null): number {
    const set = new Set(signals)
    return (
      (set.has('websocket') ? 6 : 0) +
      (set.has('network') ? 4 : 0) +
      (set.has('entry-visible') ? 4 : 0) +
      (set.has('text') ? 3 : 0) +
      (set.has('lottery-text') ? 3 : 0) +
      (set.has('shorttouch-countdown') ? 2 : 0) +
      (set.has('task-text') ? 1 : 0) +
      (set.has('requires-follow') ? 2 : 0) +
      (set.has('requires-fan-badge') ? 2 : 0) +
      (set.has('requires-comment') ? 2 : 0) +
      (set.has('task-countdown') ? 1 : 0) +
      (remainingSeconds !== null ? 2 : 0)
    )
  }

  private hasTaskCountdownSignal(signals: Set<string>, remainingSeconds: number | null): boolean {
    if (remainingSeconds === null || remainingSeconds > VERIFY_MAX_REASONABLE_REMAINING_SECONDS) return false
    return (
      signals.has('countdown') &&
      (signals.has('task-text') || signals.has('requires-follow') || signals.has('requires-fan-badge') || signals.has('requires-comment'))
    )
  }

  private async scrollSourcePage(page: Page): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 450 + Math.floor(Math.random() * 250))
      await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
    }
  }

  private async simulateLightRead(page: Page): Promise<void> {
    const count = 1 + Math.floor(Math.random() * 2)
    for (let i = 0; i < count; i++) {
      await page.mouse.wheel(0, 160 + Math.floor(Math.random() * 160))
      await page.waitForTimeout(800 + Math.floor(Math.random() * 900))
    }
  }

  private async getChallengeReason(page: Page): Promise<string> {
    try {
      const url = page.url()
      if (/95152\.douyin\.com/.test(url)) return '95152 风控页面'
      const text = await page.evaluate(() => document.body.innerText.slice(0, 3000))
      const match = text.match(/安全验证|滑块|拖动.*验证|环境异常|访问过于频繁|稍后再试|请完成验证|captcha/i)
      return match?.[0] || ''
    } catch {
      return ''
    }
  }

  private async getEndedLiveReason(page: Page): Promise<string> {
    try {
      const url = page.url()
      if (/\/(error|404|notfound)(?:\/|\?|$)/i.test(url)) return '页面不存在'
      const text = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 3000))
      const match = text.match(/直播已结束|主播已下播|直播结束|当前直播已结束|本场直播已结束|主播暂未开播|暂未开播|直播间不存在|房间不存在|内容不存在|页面不存在|该直播已关闭/)
      return match?.[0] || ''
    } catch {
      return ''
    }
  }

  private async collectRoomsFromResponse(response: any): Promise<DiscoveredRoom[]> {
    const url = response.url()
    if (!/douyin|snssdk|amemv|live/.test(url)) return []

    const rooms = this.extractCandidatesFromText(url, 'network-url')
    const contentType = response.headers()['content-type'] || ''
    if (!/json|text|javascript|html/.test(contentType)) return rooms

    const text = await response.text().catch(() => '')
    if (!text || text.length > 2_000_000) return rooms
    return rooms.concat(this.extractCandidatesFromText(text, 'network-response'))
  }

  private extractCandidatesFromText(text: string, reason: string): DiscoveredRoom[] {
    const rooms = new Map<string, DiscoveredRoom>()
    const push = (roomKey: string, name = '') => {
      const cleanKey = roomKey.replace(/\\/g, '').replace(/^\/+|\/+$/g, '')
      if (!this.isValidRoomKey(cleanKey)) return
      const url = `https://live.douyin.com/${cleanKey}`
      rooms.set(url, {
        url,
        name: name || `直播间 ${cleanKey}`,
        reason,
        countdownText: '',
        remainingSeconds: this.parseRemainingSeconds(text)
      })
    }

    const liveUrlMatches = text.match(/https?:\\?\/\\?\/live\.douyin\.com\\?\/[A-Za-z0-9_-]+/g) || []
    for (const rawUrl of liveUrlMatches) {
      const cleanUrl = rawUrl.replace(/\\/g, '')
      const roomKey = cleanUrl.match(/live\.douyin\.com\/([A-Za-z0-9_-]+)/)?.[1]
      if (roomKey) push(roomKey)
    }

    const webRidMatches = text.match(/"web_rid"\s*:\s*"([A-Za-z0-9_-]+)"/g) || []
    for (const match of webRidMatches) {
      const roomKey = match.match(/"web_rid"\s*:\s*"([A-Za-z0-9_-]+)"/)?.[1]
      if (roomKey) push(roomKey)
    }

    return Array.from(rooms.values())
  }

  private parseRemainingSeconds(text: string): number | null {
    const normalized = text.replace(/\s+/g, '')
    const hhmmss = normalized.match(/(\d{1,2}):(\d{1,2}):(\d{1,2})/)
    if (hhmmss) return Number(hhmmss[1]) * 3600 + Number(hhmmss[2]) * 60 + Number(hhmmss[3])
    const mmss = normalized.match(/(\d{1,2}):(\d{1,2})/)
    if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2])
    const minSec = normalized.match(/(?:(\d+)分)?(\d+)秒/)
    if (minSec) return Number(minSec[1] || 0) * 60 + Number(minSec[2])
    const minutes = normalized.match(/(\d+)分钟/)
    if (minutes) return Number(minutes[1]) * 60
    return null
  }

  private getSourceUrls(sourceUrl?: string): string[] {
    if (!sourceUrl?.trim()) return DEFAULT_SOURCE_URLS
    return sourceUrl
      .split(/[\n,，\s]+/)
      .map((url) => url.trim())
      .filter(Boolean)
  }

  private isValidRoomUrl(url: string): boolean {
    try {
      const parsed = new URL(url)
      const roomKey = parsed.pathname.split('/').filter(Boolean)[0] || ''
      return parsed.hostname === 'live.douyin.com' && this.isValidRoomKey(roomKey)
    } catch {
      return false
    }
  }

  private isValidRoomKey(roomKey: string): boolean {
    const normalized = roomKey.trim().replace(/^\/+|\/+$/g, '')
    if (!/^[A-Za-z0-9_-]{5,}$/.test(normalized)) return false
    if (RESERVED_ROOM_KEYS.has(normalized.toLowerCase())) return false
    if (/^[A-Za-z_]+$/.test(normalized)) return false
    if (UUID_ROOM_KEY_PATTERN.test(normalized)) return false
    if (normalized.length === 36 && normalized.split('-').length === 5) return false
    return true
  }

  private randomBetween(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1))
  }

  private log(message: string): void {
    logInfo('discover', message)
    this.onLog?.(message)
  }
}
