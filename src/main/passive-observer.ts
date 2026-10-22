import { Page, Response, WebSocket } from 'playwright'
import { Opportunity } from '../shared/policy'
import { parseLottery, riskFromText } from './lottery-parser'

export class PassiveObserver {
  latest: Opportunity | null = null
  panelLotteryId: string | null = null
  lastChatSuccess = 0
  lastFanSuccess = 0
  lastFanFailure = 0
  websocketHint = false
  private alive = true
  private frames = new Map<WebSocket, (event: {payload: string | Buffer}) => void>()
  private newestRequestAt=0
  constructor(private page: Page, private signal: AbortSignal, private reportRisk:(reason:string,source:string)=>void, private onOpportunity: (o: Opportunity) => void = () => {}) {
    page.on('response', this.response)
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
  private response = (response: Response): void => { void this.readResponse(response).catch(() => {}) }
  private async readResponse(response: Response): Promise<void> {
    if (!this.alive || this.signal.aborted) return
    const url = new URL(response.url())
    if (!(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com')) || !url.pathname.startsWith('/webcast/')) return
    if(response.status()===429){this.reportRisk('服务返回请求限流','response');return}
    const text = await response.text().catch(() => '')
    if (!this.alive || this.signal.aborted || text.length > 2_000_000) return
    let json:any; try { json=JSON.parse(text) } catch { return }
    const code = Number(json.status_code)
    const error = riskFromText(String(json.status_msg || json.message || json.prompt || ''))
    if (code === 95152 || (code !== 0 && error)) { this.reportRisk(error || `服务返回限制代码 ${code}`, 'response'); return }
    if (/\/gift\/send\//.test(url.pathname)) {
      const post=response.request().postData()||'', started=response.request().timing().startTime
      if (/(?:^|&)gift_id=6937(?:&|$)/.test(post) && Date.now()-started<20000) {
        if(json.status_code!==undefined&&code===0)this.lastFanSuccess=started
        else if(json.status_code!==undefined)this.lastFanFailure=started
      }
    }
    if (/\/room\/chat\//.test(url.pathname) && json.status_code!==undefined && code===0) this.lastChatSuccess=response.request().timing().startTime
    if (/\/lottery\//.test(url.pathname) || text.includes('"lottery_info"')) {
      const o=parseLottery(text)
      const requestAt=response.request().timing().startTime
      if(o&&requestAt>=this.newestRequestAt){
        this.newestRequestAt=requestAt
        if(/\/lottery\/right\//.test(url.pathname))this.panelLotteryId=o.lotteryId||null
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
    this.page.off('response',this.response);this.page.off('websocket',this.websocket);this.page.off('close',this.close)
    this.signal.removeEventListener('abort',this.close)
    for(const [ws,handler] of this.frames)ws.off('framereceived',handler)
    this.frames.clear()
  }
}
