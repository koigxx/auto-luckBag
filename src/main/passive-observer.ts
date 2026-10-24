import { Page, Request, Response, WebSocket } from 'playwright'
import { Opportunity } from '../shared/policy'
import { parseLottery, parseLotteryPayload, panelIdentity, riskFromText } from './lottery-parser'

export class PassiveObserver {
  latest: Opportunity | null = null
  panelLotteryId: string | null = null
  panelIdentityReason = '尚未观察到弹窗身份响应'
  lastChatSuccess = 0
  lastFanSuccess = 0
  lastFanFailure = 0
  websocketHint = false
  private alive = true
  private frames = new Map<WebSocket, (event: {payload: string | Buffer}) => void>()
  private newestRequestAt=0
  private newestPanelRequestAt=0
  private requestTimes = new WeakMap<Request, number>()
  private paymentObservationUntil = 0
  private paymentObservations = new Map<string, string>()
  beginPaymentObservation(): void {
    this.paymentObservationUntil = Date.now() + 20000
    this.paymentObservations.clear()
  }
  private paymentNote(request: Request, state: string): void {
    if (Date.now() > this.paymentObservationUntil || request.method() === 'GET' || request.method() === 'OPTIONS') return
    // Capture shape only, including unrecognized endpoints, without storing
    // hostnames, IDs, query strings, headers or request/response content.
    const url = new URL(request.url())
    const path = url.pathname.split('/').slice(0, 8).map(part => /^[a-z_]{0,32}$/.test(part) ? part : ':segment').join('/')
    const origin = url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com') ? '本站' : '其他域'
    const key = `${request.method()} ${origin} ${path}`
    this.paymentObservations.delete(key)
    this.paymentObservations.set(key, state)
    if (this.paymentObservations.size > 20) this.paymentObservations.delete(this.paymentObservations.keys().next().value!)
  }
  private request = (request: Request): void => {
    if (!this.alive || this.signal.aborted) return
    this.requestTimes.set(request, Date.now())
    this.paymentNote(request, '已发出，尚无响应')
  }
  // Endpoint paths and processing stages only: never retain query strings,
  // headers, request bodies, response payloads or account credentials here.
  private observations = new Map<string, string>()
  private note(path: string, state: string): void {
    const key = path.replace(/\d{6,}/g, ':id').slice(0, 160)
    this.observations.delete(key)
    this.observations.set(key, state)
    if (this.observations.size > 8) this.observations.delete(this.observations.keys().next().value!)
  }
  identityDiagnostics(): string {
    return [...this.observations, ...this.paymentObservations].map(([path, state]) => `${path}: ${state}`).join('；') || '未记录到福袋请求响应'
  }
  constructor(private page: Page, private signal: AbortSignal, private reportRisk:(reason:string,source:string)=>void, private onOpportunity: (o: Opportunity) => void = () => {}) {
    page.on('response', this.response)
    page.on('request', this.request)
    page.on('requestfailed', this.requestFailed)
    page.on('websocket', this.websocket)
    signal.addEventListener('abort', this.close, {once:true})
    page.once('close', this.close)
  }
  accept(o: Opportunity): void {
    if (!this.alive || this.signal.aborted) return
    if (this.latest?.lotteryId === o.lotteryId && this.latest.observedAt > o.observedAt) return
    if(this.latest?.lotteryId!==o.lotteryId&&this.latest?.drawAt&&o.drawAt&&o.drawAt<this.latest.drawAt)return
    this.latest = o
    this.onOpportunity(o)
  }
  private requestFailed = (request: Request): void => {
    if (!this.alive || this.signal.aborted) return
    this.paymentNote(request, '请求失败')
    const url = new URL(request.url())
    if ((url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com')) && /\/(?:lottery|gift\/send)\//.test(url.pathname))
      this.note(url.pathname, '请求失败，未收到完整响应')
  }
  private response = (response: Response): void => {
    void this.readResponse(response).catch(() => {
      if (!this.alive || this.signal.aborted) return
      const url = new URL(response.url())
      if ((url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com')) && /\/(?:lottery|gift\/send)\//.test(url.pathname))
        this.note(url.pathname, '响应处理异常')
    })
  }
  private async readResponse(response: Response): Promise<void> {
    if (!this.alive || this.signal.aborted) return
    this.paymentNote(response.request(), `HTTP ${response.status()}，仅诊断、不授权付款成功`)
    const url = new URL(response.url())
    if (!(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) return
    const lotteryPath = /\/lottery\//.test(url.pathname)
    const paymentPath = /^\/webcast\/gift\/send\/?$/.test(url.pathname)
    if (!url.pathname.startsWith('/webcast/')) {
      if (lotteryPath) this.note(url.pathname, '路径不在已支持范围内')
      return
    }
    // Both paths are naturally observed user-rights responses. Ordinary
    // /melon/lottery_info/ updates still cannot establish panel identity.
    const isRight = /^\/webcast\/lottery\/(?:right|melon\/check_user_right)\/?$/.test(url.pathname)
    const started = response.request().timing().startTime
    // Cached/unfinished timing may be unavailable (-1). It must not make every
    // rights response silently fail the initial >= 0 ordering check.
    const requestAt = Number.isFinite(started) && started >= 0 ? started : Date.now()
    // Invalidate a newer unusable response too, so an older panel cannot authorize actions.
    if (isRight && requestAt >= this.newestPanelRequestAt) {
      this.newestPanelRequestAt = requestAt
      this.panelLotteryId = null
      this.panelIdentityReason = '已收到弹窗响应，正在读取内容'
    }
    if (lotteryPath || paymentPath) this.note(url.pathname, `HTTP ${response.status()}，正在读取内容`)
    const failed = (reason: string): void => {
      if (lotteryPath || paymentPath) this.note(url.pathname, reason)
      if (isRight && requestAt === this.newestPanelRequestAt) this.panelIdentityReason = reason
    }
    if(response.status()===429){failed('HTTP 429，请求限流');this.reportRisk('服务返回请求限流','response');return}
    let text: string
    try { text = await response.text() } catch { failed('响应内容读取失败'); return }
    if (!this.alive || this.signal.aborted) return
    if (text.length > 2_000_000) { failed('响应内容超过大小限制'); return }
    let json:any; try { json=parseLotteryPayload(text) } catch { failed('响应不是有效的 JSON'); return }
    if (!json || typeof json !== 'object') { failed('响应缺少对象结构'); return }
    const code = Number(json.status_code)
    const success = json.status_code === 0 || json.status_code === '0'
    const error = riskFromText(String(json.status_msg || json.message || json.prompt || ''))
    if (code === 95152 || (code !== 0 && error)) { this.reportRisk(error || `服务返回限制代码 ${code}`, 'response'); return }
    if (paymentPath) {
      const post=response.request().postData()||''
      // A locally observed request event provides the dispatch boundary even
      // when Playwright timing is unavailable. Never substitute response time.
      const started=this.requestTimes.get(response.request()) ?? response.request().timing().startTime
      this.note(url.pathname, !/(?:^|&)gift_id=6937(?:&|$)/.test(post) ? '非已识别灯牌请求，不作为支付回执' :
        !Number.isFinite(started) || started <= 0 || Date.now()-started>=20000 ? '请求时间缺失或回执过期' :
        response.ok() && success ? '灯牌业务成功' :
        json.status_code !== null && json.status_code !== '' && Number.isFinite(code) && code !== 0 ? '灯牌业务失败' : '未获得明确业务结果')
      if (/(?:^|&)gift_id=6937(?:&|$)/.test(post) && Number.isFinite(started) && started > 0 && Date.now() >= started && Date.now()-started<20000) {
        if(response.ok() && success)this.lastFanSuccess=started
        else if(json.status_code !== null && json.status_code !== '' && Number.isFinite(code) && code !== 0)this.lastFanFailure=started
      }
    }
    // Receipt freshness needs the actual request time; observation-time fallback
    // is only for identity ordering and must not confirm an earlier comment.
    if (/\/room\/chat\//.test(url.pathname) && response.ok() && success && Number.isFinite(started) && started > 0)
      this.lastChatSuccess=started
    if (/\/lottery\//.test(url.pathname) || text.includes('"lottery_info"')) {
      let o=parseLottery(text)
      // Rights establish panel identity independently of general lottery updates.
      // A newer info response may finish first; do not discard a valid rights
      // response for that reason or let its older task data replace the latest.
      if (isRight && requestAt >= this.newestPanelRequestAt) {
        this.newestPanelRequestAt = requestAt
        const identity = response.ok()
          ? panelIdentity(json, url, response.request().postData?.() || '')
          : { id: null, reason: '弹窗请求返回 HTTP 错误' }
        this.panelLotteryId = identity.id
        this.panelIdentityReason = identity.reason
        this.note(url.pathname, identity.reason)
        // Some rights payloads omit the ID in lottery_info but include it in the
        // request or envelope. Use it only after checking all identities agree.
        if (o && identity.id && !o.lotteryId) o = { ...o, lotteryId: identity.id }
      }
      if (lotteryPath && !isRight) this.note(url.pathname, o?.lotteryId
        ? '已识别福袋数据，非已支持的弹窗身份接口'
        : '未识别到福袋身份结构')
      if(o?.lotteryId && requestAt>=this.newestRequestAt){
        this.newestRequestAt=requestAt
        const previous = this.latest
        if (previous?.lotteryId === o.lotteryId) {
          if (!o.drawAt) o = { ...o, drawAt: previous.drawAt, confidence: previous.confidence, source: previous.source }
          if (!o.tasksKnown && previous.tasksKnown) o = { ...o,
            tasksKnown: true, cost: previous.cost, membership: previous.membership,
            requiresFollow: previous.requiresFollow, requiresComment: previous.requiresComment,
            requiresShare: previous.requiresShare, commentText: previous.commentText,
            watchSeconds: previous.watchSeconds, unsupported: [...previous.unsupported],
            fanLevelRequired: previous.fanLevelRequired
          }
        }
        this.accept(o)
      }
    }
  }
  private websocket = (ws: WebSocket): void => {
    const handler = ({payload}: {payload: string | Buffer}) => {
      if (!this.alive || this.signal.aborted) return
      if(typeof payload!=='string'||payload.length>200000)return
      const o=parseLottery(payload)
      if(o)this.websocketHint=true
    }
    this.frames.set(ws,handler);ws.on('framereceived',handler)
  }
  async checkPageRisk(): Promise<void> {
    if (!this.alive || this.signal.aborted || this.page.isClosed()) return
    const text = await this.page.evaluate(() => {
      const nodes=[...document.querySelectorAll<HTMLElement>('[role="dialog"], [class*="captcha"], [id*="captcha"], [class*="verify"]')]
      if(/验证码|安全验证|访问异常/.test(document.title))nodes.push(document.body)
      return nodes.filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden'&&r.bottom>0&&r.top<innerHeight}).map(el=>el.innerText.slice(0,1500)).join('\n')
    }).catch(()=>'')
    const reason=riskFromText(text)
    if(reason)this.reportRisk(reason,'visible-challenge')
  }
  close = (): void => {
    this.alive=false
    this.page.off('request',this.request);this.page.off('response',this.response);this.page.off('requestfailed',this.requestFailed);this.page.off('websocket',this.websocket);this.page.off('close',this.close)
    this.signal.removeEventListener('abort',this.close)
    for(const [ws,handler] of this.frames)ws.off('framereceived',handler)
    this.frames.clear()
  }
}
