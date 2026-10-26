import { roomDisplayName, discoveryRoomName, usableRoomName } from '../shared/record-presentation'
import { Page, Response } from 'playwright'
import { BrowserManager } from './browser-manager'
import { Opportunity, normalizeRoomUrl, SOURCE_TO_FIRST_ROOM_SECONDS, VERIFICATION_MAX_SECONDS, RETURN_VERIFICATION_MAX_SECONDS } from '../shared/policy'
import { PassiveObserver } from './passive-observer'
import { LotteryDom, visibleOpportunity } from './lottery-dom'
import { execution, repository, assertActive, onHalt, perform, reportRisk } from './runtime'
import { delay } from './execution-gate'
import { supplementVisibleTask } from './lottery-parser'

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
export interface VerifiedFudaiRoom extends DiscoveredRoom {
  verifiedAt: number
  hasFudai: boolean
  score: number
  matchedSignals: string[]
  drawAt: number | null
  countdownSource: 'network' | 'visible-dom' | 'unknown'
  countdownConfidence: 'exact' | 'estimated' | 'unknown'
  opportunity: Opportunity
}
export interface VerifyRoomResult {
  room: VerifiedFudaiRoom | null
  riskDetected: boolean
  riskReason: string
  page?: Page
  observer?: PassiveObserver
}
export interface ScanResult {
  rooms: DiscoveredRoom[]
  riskDetected: boolean
  riskReason: string
}
export interface VerifyRoomOptions {
  keepPageOnVerified?: boolean
  minDwellMs?: number
  reserved?: boolean
}
export class DiscoveryService {
  private pages = new Set<Page>()
  private firstVerificationAt = 0
  private onLog: (text: string) => void = () => {}
  constructor(private browser: BrowserManager) {
    onHalt(() => this.close())
  }
  setLogger(fn: (text: string) => void): void {
    this.onLog = fn
  }
  async scan(options: DiscoveryOptions = {}): Promise<ScanResult> {
    const signal = execution.signal
    assertActive(signal, true)
    const source = options.sourceUrl || 'https://live.douyin.com'
    const parsed = new URL(source)
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'live.douyin.com' ||
      !['/', '/category', '/follow'].includes(parsed.pathname)
    )
      throw new Error('只支持抖音直播首页、分类页或关注页')
    const page = await this.browser.newManagedPage(signal)
    this.pages.add(page)
    const observer = new PassiveObserver(page, signal, reportRisk),
      rooms = new Map<string, DiscoveredRoom>()
    const collect = (url: string, name = '') => {
      try {
        const normalized = normalizeRoomUrl(url),
          old = rooms.get(normalized),
          label = usableRoomName(discoveryRoomName(name))
        rooms.set(normalized, {
          url: normalized,
          name: label && label !== '直播中' ? label : old?.name || normalized,
          reason: '入口发现',
          countdownText: '',
          remainingSeconds: null
        })
      } catch {}
    }
    const response = (r: Response) => {
      void (async () => {
        if (!/\/webcast\//.test(r.url())) return
        const text = await r.text().catch(() => '')
        if (signal.aborted || text.length > 2_000_000) return
        // Links are hints only. No countdown, fan status or reward is inferred here.
        for (const match of text.matchAll(/https?:\/\/live\.douyin\.com\/[A-Za-z0-9_-]+/g)) collect(match[0])
      })().catch(() => {})
    }
    page.on('response', response)
    try {
      await this.browser.navigate(page, source, false, signal)
      await delay(3000, signal)
      await observer.checkPageRisk()
      assertActive(signal, true)
      const links = await page
        .locator('a[href]')
        .evaluateAll((nodes) =>
          nodes.map((el) => ({ url: (el as HTMLAnchorElement).href, name: (el as HTMLElement).innerText }))
        )
      for (const link of links) collect(link.url, link.name)
      const found = [...rooms.values()].slice(0, Math.min(50, Math.max(1, options.maxRooms || 20)))
      for (const room of found) repository.room(room.url, room.name, 'discovery')
      this.firstVerificationAt = Date.now() + SOURCE_TO_FIRST_ROOM_SECONDS * 1000
      this.onLog(`入口发现 ${found.length} 个房间，等待逐个验证`)
      if (found.length) this.onLog(`首页发现后等待 ${SOURCE_TO_FIRST_ROOM_SECONDS} 秒再验证首房；后续房间按导航间隔执行`)
      return { rooms: found, riskDetected: false, riskReason: '' }
    } finally {
      page.off('response', response)
      observer.close()
      this.pages.delete(page)
      await page.close().catch(() => {})
    }
  }
  async verifyRoom(room: DiscoveredRoom, options: VerifyRoomOptions = {}): Promise<VerifyRoomResult> {
    const url = normalizeRoomUrl(room.url),
      signal = execution.signal
    assertActive(signal, true)
    if (this.firstVerificationAt > Date.now()) await delay(this.firstVerificationAt - Date.now(), signal)
    assertActive(signal, true)
    this.firstVerificationAt = 0
    const profile = repository.room(url, room.name),
      fresh = profile.visits.length === 0
    // Only discovery-owned names have a card envelope; preserve user-entered names.
    const savedName = usableRoomName(profile.source === 'discovery' ? discoveryRoomName(profile.name) : profile.name)
    const preferredName = savedName || usableRoomName(room.name)
    if (preferredName) {
      room = { ...room, name: preferredName }
      if (profile.name !== preferredName) repository.updateRoom(url, { name: preferredName })
    }
    const page = await this.browser.newManagedPage(signal)
    this.pages.add(page)
    const observer = new PassiveObserver(page, signal, reportRisk, (o) => repository.observe(url, o)),
      dom = new LotteryDom(page, signal, perform)
    const verificationRequestedAt = Date.now()
    let keep = false,
      navigated = false
    try {
      await this.browser.navigate(page, url, fresh, signal)
      navigated = true
      const title = usableRoomName(await page.title().catch(() => '')).slice(0, 80)
      if (
        title &&
        !preferredName
      ) {
        room = { ...room, name: title }
        repository.updateRoom(url, { name: title })
      }
      this.onLog(`验证 ${roomDisplayName(room.name, url)}`)
      const started = Date.now(),
        dwell = Math.max(options.minDwellMs || 0, (options.reserved ? RETURN_VERIFICATION_MAX_SECONDS : VERIFICATION_MAX_SECONDS) * 1000)
      let opened = false,
        visible: Opportunity | null = null
      while (Date.now() - started < dwell) {
        assertActive(signal, true)
        await observer.checkPageRisk()
        const entry = await dom.entry()
        if (entry.seconds !== null) visible = visibleOpportunity(entry.seconds)
        // Opening a visible bag loads its normal task response. No tasks are performed while verifying.
        if (entry.visible && !opened) {
          opened = await dom.open()
        }
        // Evidence, not a mandatory dwell, decides readiness. Return visits have
        // a smaller observation ceiling, but never bypass identity/task checks.
        const latest = observer.latest
        if (Date.now() - started >= Math.max(3000, options.minDwellMs || 0) &&
            latest?.lotteryId && latest.drawAt && latest.tasksKnown &&
            latest.source === 'network' && latest.confidence === 'exact' &&
            observer.panelLotteryId === latest.lotteryId && await dom.panelText()) break
        await delay(500, signal)
      }
      assertActive(signal, true)
      let opportunity = observer.latest || visible
      if (opportunity && visible && !opportunity.drawAt)
        opportunity = {
          ...opportunity,
          drawAt: (visible as Opportunity).drawAt,
          source: 'visible-dom',
          confidence: 'estimated'
        }
      if (opportunity) opportunity = supplementVisibleTask(opportunity, await dom.panelText(),
        !!opportunity.lotteryId && observer.panelLotteryId === opportunity.lotteryId)
      if (opportunity) observer.accept(opportunity)
      const found = !!opportunity?.drawAt
      repository.visit(url, found, opportunity || undefined)
      if (!opportunity || !opportunity.drawAt) {
        const reason = '本次观察未获得可靠福袋倒计时，已进入复验冷却'
        repository.decision({ url, action: 'skip', reason, score: null, probability: null })
        this.onLog(`跳过 ${roomDisplayName(room.name, url)}：${reason}`)
        return { room: null, riskDetected: false, riskReason: reason }
      }
      // Measure actual navigation dispatch through successful identity/task verification;
      // time spent waiting for the global navigation gate is not loading time.
      const navigationAt = repository.account().navigations.filter(n => n.url === url && n.at >= verificationRequestedAt).at(-1)?.at
      if (navigationAt !== undefined && opportunity.tasksKnown && observer.panelLotteryId === opportunity.lotteryId && await dom.panelText())
        repository.recordVerificationTiming(url, (Date.now() - navigationAt) / 1000)
      const verified: VerifiedFudaiRoom = {
        ...room,
        url,
        verifiedAt: Date.now(),
        hasFudai: true,
        score: 0,
        matchedSignals: [opportunity.source],
        remainingSeconds: Math.max(0, Math.ceil((opportunity.drawAt - Date.now()) / 1000)),
        drawAt: opportunity.drawAt,
        countdownSource: opportunity.source,
        countdownConfidence: opportunity.confidence,
        opportunity
      }
      keep = !!options.keepPageOnVerified
      return {
        room: verified,
        riskDetected: false,
        riskReason: '',
        page: keep ? page : undefined,
        observer: keep ? observer : undefined
      }
    } catch (error) {
      await observer.checkPageRisk()
      if (!signal.aborted) {
        if (navigated) repository.visit(url, false)
        const reason = `验证异常：${error instanceof Error ? error.message : String(error)}`
        repository.decision({ url, action: 'skip', reason, score: null, probability: null })
        this.onLog(`跳过 ${roomDisplayName(room.name, url)}：${reason}`)
      }
      throw error
    } finally {
      this.pages.delete(page)
      if (!keep) {
        observer.close()
        await page.close().catch(() => {})
      }
    }
  }
  async close(): Promise<void> {
    this.firstVerificationAt = 0
    await Promise.allSettled([...this.pages].map((p) => p.close()))
    this.pages.clear()
  }
}
