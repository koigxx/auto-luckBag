import { Page, ElementHandle } from 'playwright'
import { Opportunity } from '../shared/policy'

export const MODAL_SELECTOR =
  '#short_touch_land_lottery_land_userMain, #short_touch_land_lottery_land_result, #lottery_close_cotainer, [role="dialog"], [class*="Modal"], [class*="modal"], [class*="dialog"], [class*="Lottery"], [class*="lottery"], [class*="fudai"]'

const RESULT_ROOT = '#short_touch_land_lottery_land_result'
const KNOWN_ROOTS = '#short_touch_land_lottery_land_userMain, #short_touch_land_lottery_land_result'

// Bounded action wording, not a substring search across task rows/containers.
// Support small CTA variants without mistaking paid/share actions for comments.
const COMMENT_ACTION = /^(?:点击|立即)?(?:发送口令|一键发送|一键评论|发表评论|发送评论|评论参与|评论并参与|一键评论参与|去发表评论|一键发评论|一键发表评论|发评论参与|发送评论参与|发评论参与福袋|一键发评论参与福袋)(?:并参与|参与福袋|参与抽奖|参与)?(?:[（(](?:自动发送|自动评论|发送口令)[）)])?[>›»]?$/

export class LotteryDom {
  lastOpenResult = '尚未尝试打开弹窗'
  constructor(
    public page: Page,
    private signal: AbortSignal,
    private perform: <T>(signal: AbortSignal, task: () => Promise<T>) => Promise<T>
  ) {}
  async watch(changed: () => void): Promise<void> {
    const name = `__luckbagChanged_${Math.random().toString(36).slice(2)}`
    await this.page.exposeFunction(name, () => {
      if (!this.signal.aborted) changed()
    })
    const install = (callback: string) => {
      const win = window as any
      if (win.__luckbagObserver) win.__luckbagObserver.disconnect()
      let last = 0
      const observer = new MutationObserver(() => {
        if (Date.now() - last < 1000) return
        const visible = [
          ...document.querySelectorAll('#ShortTouchLayout .ycjwPFJI,[aria-label*="福袋"],img[alt*="福袋"]')
        ].some((el) => {
          const r = el.getBoundingClientRect(),
            s = getComputedStyle(el)
          return (
            s.display !== 'none' &&
            s.visibility !== 'hidden' &&
            +s.opacity > 0.05 &&
            r.width >= 8 &&
            r.height >= 8 &&
            r.top >= 0 &&
            r.left >= 0 &&
            r.bottom <= innerHeight &&
            r.right <= innerWidth
          )
        })
        if (visible) {
          last = Date.now()
          void win[callback]?.()
        }
      })
      const attach = () => {
        if (document.documentElement)
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'aria-label']
          })
      }
      if (document.documentElement) attach()
      else document.addEventListener('DOMContentLoaded', attach, { once: true })
      win.__luckbagObserver = observer
    }
    await this.page.addInitScript(install, name)
    await this.page.evaluate(install, name)
  }
  async panel(kind: 'any' | 'task' = 'any'): Promise<ElementHandle<HTMLElement> | null> {
    const handle = await this.page.evaluateHandle(({selector, known, result, kind}) => {
      if (kind === 'task' && [...document.querySelectorAll(result)].some(el => {
        const r=el.getBoundingClientRect(),s=getComputedStyle(el)
        return s.display!=='none' && s.visibility!=='hidden' && +s.opacity>0.05 && r.width>0 && r.height>0
      })) return null
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el)
        return (
          s.display !== 'none' &&
          s.visibility !== 'hidden' &&
          +s.opacity > 0.05 &&
          r.width >= 120 &&
          r.height >= 80 &&
          r.top >= 0 &&
          r.left >= 0 &&
          r.bottom <= innerHeight + 2 &&
          r.right <= innerWidth + 2 &&
          r.width * r.height < innerWidth * innerHeight * 0.8
        )
      }
      const roots = [...document.querySelectorAll<HTMLElement>(selector)]
        .filter((el) => {
          const t = el.innerText || ''
          const owner = el.closest(known)
          if (kind === 'task' && el.closest(result)) return false
          return (
            visible(el) &&
            (!!owner || /福袋|开奖/.test(t)) &&
            /参与|等待开奖|粉丝团|关注|口令|中奖|未抽中|看播|观看|恭喜|我的奖品|很遗憾|获得|下次|好运/.test(t) &&
            t.length < 2000
          )
        })
        .sort(
          (a, b) => {
            // Prefer the known complete modal over a smaller nested task card.
            const priority = (el: Element) => el.closest(result) ? 0 : el.matches(known) ? 1 : 2
            return priority(a) - priority(b) ||
              (a.contains(b) ? -1 : b.contains(a) ? 1 :
                a.getBoundingClientRect().width * a.getBoundingClientRect().height -
                b.getBoundingClientRect().width * b.getBoundingClientRect().height)
          }
        )
      return roots[0] || null
    }, {selector:MODAL_SELECTOR, known:KNOWN_ROOTS, result:RESULT_ROOT, kind})
    const el = handle.asElement() as ElementHandle<HTMLElement> | null
    if (!el) await handle.dispose()
    return el
  }
  async panelText(): Promise<string> {
    const p = await this.panel()
    if (!p) return ''
    try {
      return await p.innerText()
    } finally {
      await p.dispose()
    }
  }
  async panelDiagnostics(): Promise<string> {
    // Structural evidence only: never log page text, comments, account data or HTML.
    return this.page.evaluate(({selector, known}) => JSON.stringify({
      viewport: [innerWidth, innerHeight],
      roots: [...document.querySelectorAll<HTMLElement>(selector)].slice(0, 12).map(el => {
        const r=el.getBoundingClientRect(), s=getComputedStyle(el), t=el.innerText || ''
        return {known:el.matches(known), tag:el.tagName,
          rect:[r.x,r.y,r.width,r.height].map(Math.round),
          shown:s.display!=='none' && s.visibility!=='hidden' && +s.opacity>0.05,
          length:t.length, heading:/福袋|开奖/.test(t),
          confirmation:/参与成功|报名成功|等待开奖|成功参与|已参与/.test(t),
          children:el.children.length}
      })
    }), {selector:MODAL_SELECTOR, known:KNOWN_ROOTS})
  }
  async panelSnapshot(): Promise<{text:string; resultPanel:boolean; lotteryId:string|null}> {
    const p = await this.panel()
    if (!p) return {text:'', resultPanel:false, lotteryId:null}
    try {
      return await p.evaluate((el, resultRoot) => {
        const root = el.closest(resultRoot) || el
        const idNode = root.matches('[data-lottery-id],[data-lottery-id-str]') ? root :
          root.querySelector('[data-lottery-id],[data-lottery-id-str]')
        return {text:el.innerText, resultPanel:!!el.closest(resultRoot),
          lotteryId:idNode?.getAttribute('data-lottery-id-str') || idNode?.getAttribute('data-lottery-id') || null}
      }, RESULT_ROOT)
    } finally { await p.dispose() }
  }
  private async hasOverlay(): Promise<boolean> {
    return this.page.evaluate(selector => [...document.querySelectorAll(selector)].some(el => {
      const r=el.getBoundingClientRect(), s=getComputedStyle(el)
      return s.display!=='none' && s.visibility!=='hidden' && +s.opacity>0.05 && r.width>0 && r.height>0
    }), KNOWN_ROOTS)
  }
  async entry(): Promise<{ seconds: number | null; visible: boolean }> {
    return this.page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>(
        '#ShortTouchLayout .ycjwPFJI, #ShortTouchLayout [class*="ShortTouchContainer"], [aria-label*="福袋"], img[alt*="福袋"]'
      )) {
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el)
        if (
          s.display === 'none' ||
          s.visibility === 'hidden' ||
          +s.opacity <= 0.05 ||
          r.width < 8 ||
          r.height < 8 ||
          r.top < 0 ||
          r.left < 0 ||
          r.bottom > innerHeight ||
          r.right > innerWidth
        )
          continue
        const m = (el.innerText || '').match(/\b(\d{1,2}):([0-5]\d)\b/)
        if (m) return { visible: true, seconds: +m[1] * 60 + +m[2] }
        if (/福袋/.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('alt') || ''}`))
          return { visible: true, seconds: null }
      }
      return { visible: false, seconds: null }
    })
  }
  async open(): Promise<boolean> {
    if (await this.panelText()) { this.lastOpenResult = '弹窗已打开，复用当前页面'; return true }
    if (await this.hasOverlay()) {
      this.lastOpenResult = '福袋弹层仍存在，等待内容或关闭，不点击遮挡后的入口'
      return false
    }
    const targets = await this.page.$$('#ShortTouchLayout .ycjwPFJI, [aria-label*="福袋"], img[alt*="福袋"]')
    try {
      for (const el of targets) {
        const valid = await el.evaluate((e) => {
          const r = e.getBoundingClientRect(),
            s = getComputedStyle(e),
            t = (e as HTMLElement).innerText || ''
          return (
            s.display !== 'none' &&
            s.visibility !== 'hidden' &&
            +s.opacity > 0.05 &&
            r.width >= 8 &&
            r.height >= 8 &&
            r.top >= 0 &&
            r.left >= 0 &&
            r.bottom <= innerHeight &&
            r.right <= innerWidth &&
            (/\d{1,2}:[0-5]\d/.test(t) ||
              /福袋/.test(`${e.getAttribute('aria-label')} ${e.getAttribute('alt')}`))
          )
        })
        if (valid) {
          await this.perform(this.signal, () => el.click({ timeout: 4000 }))
          this.lastOpenResult = '已点击福袋入口，等待弹窗及身份响应'
          return true
        }
      }
      this.lastOpenResult = '没有找到可见的福袋入口'
      return false
    } finally {
      await Promise.all(targets.map((t) => t.dispose()))
    }
  }
  async reopen(): Promise<boolean> {
    const panel = await this.panel()
    if (!panel) return this.open()
    const bounds = await panel.boundingBox()
    await panel.dispose()
    if (await this.panelText()) {
      // Only use a small, explicitly labelled
      // close control inside/adjacent to this panel; never click an opaque container.
      if (!bounds) { this.lastOpenResult = '未取得弹窗边界，无法安全重开'; return false }
      const controls = await this.page.$$('button, [role="button"], [aria-label], [title], div, span, svg, img')
      try {
        for (const control of controls) {
          const isClose = (el: Element, box: {x: number; y: number; width: number; height: number}) => {
            const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || (el as HTMLElement).innerText || ''
            const marker = [el.id, el.getAttribute('class'), el.getAttribute('data-icon')].join(' ')
            const acknowledge = label.trim() === '知道了' &&
              !!el.closest('#short_touch_land_lottery_land_result')
            // Graphic close controls often have no text. Require an explicit
            // close marker as well as a small control beside this lottery panel.
            const explicit = acknowledge || /^(?:关闭|关闭福袋|关闭弹窗|×|✕|✖)$/.test(label.trim()) ||
              (!label.trim() && /close/i.test(marker))
            const r = el.getBoundingClientRect(), s = getComputedStyle(el)
            return explicit &&
              (el.matches('button,[role="button"]') || s.cursor === 'pointer') &&
              !el.querySelector('button,[role="button"]') &&
              !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true' &&
              s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.05 &&
              r.width >= 12 && r.width <= (acknowledge ? 320 : 64) && r.height >= 12 && r.height <= 64 &&
              r.left >= box.x && r.right <= box.x + box.width &&
              r.top >= box.y && r.bottom <= box.y + box.height + 80 &&
              r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth
          }
          const close = await control.evaluate(isClose, bounds)
          if (!close) continue
          await this.perform(this.signal, async () => {
            if (!await control.evaluate(isClose, bounds)) return
            await control.click({ timeout: 3000 })
          })
          break
        }
      } finally { await Promise.all(controls.map(el => el.dispose())) }
    }
    if (await this.panelText()) {
      this.lastOpenResult = '弹窗未关闭，未重新点击入口（没有可识别的关闭控件）'
      return false
    }
    return this.open()
  }
  async hasAction(pattern: RegExp): Promise<boolean> {
    return this.action(pattern, false)
  }
  async action(pattern: RegExp, click = true, onDispatch: () => void = () => {}): Promise<boolean> {
    const panel = await this.panel('task')
    if (!panel) return false
    const targets = await panel.$$('button, [role="button"], a, div, span, p')
    try {
      for (const el of targets) {
        const text = (await el.innerText()).replace(/\s+/g, '').trim()
        if (!pattern.test(text)) continue
        const valid = await el.evaluate((e) => {
          const r = e.getBoundingClientRect(),
            s = getComputedStyle(e)
          return (
            (e.matches('button,[role="button"],a') || s.cursor === 'pointer') &&
            !e.querySelector('button,[role="button"],a') &&
            !e.hasAttribute('disabled') &&
            e.getAttribute('aria-disabled') !== 'true' &&
            s.display !== 'none' &&
            s.visibility !== 'hidden' &&
            +s.opacity > 0.05 &&
            r.width >= 25 &&
            r.height >= 16 &&
            r.width < 550 &&
            r.height < 100 &&
            r.top >= 0 &&
            r.left >= 0 &&
            r.bottom <= innerHeight &&
            r.right <= innerWidth
          )
        })
        if (valid) {
          if (!click) return true
          return await this.perform(this.signal, async () => {
            // The gate can wait long enough for the same node to become a different action.
            if (!pattern.test((await el.innerText()).replace(/\s+/g, '').trim())) return false
            if (!(await el.isVisible()) || !(await el.isEnabled()) ||
                await el.getAttribute('aria-disabled') === 'true') return false
            onDispatch()
            await el.click({ timeout: 4000 })
            return true
          })
        }
      }
      return false
    } finally {
      await Promise.all(targets.map((t) => t.dispose()))
      await panel.dispose()
    }
  }
  async comment(command: string, onDispatch: () => void = () => {}): Promise<boolean> {
    if (!command || command.length > 100) return false
    return this.action(COMMENT_ACTION, true, onDispatch)
  }
  async hasCommentAction(): Promise<boolean> {
    return this.action(COMMENT_ACTION, false)
  }
  async paymentConfirmation(cost: number, mayDispatch: () => boolean = () => true): Promise<boolean> {
    const dialogs = await this.page.$$(MODAL_SELECTOR)
    try {
      for (const el of dialogs) {
        if (!(await el.isVisible())) continue
        const text = (await el.innerText()).replace(/\s+/g, '')
        if (
          !/粉丝团|灯牌/.test(text) ||
          !new RegExp(`(?:^|[^0-9])${String(cost).replace('.', '\\.')}钻(?:石)?`).test(text) ||
          text.length > 350
        )
          continue
        const buttons = await el.$$('button, [role="button"]')
        try {
          for (const b of buttons)
            if (/^(?:确认|确认加入|确认支付|确认点亮)$/.test((await b.innerText()).trim())) {
              return await this.perform(this.signal, async () => {
                const current = (await el.innerText()).replace(/\s+/g, '')
                if (!/粉丝团|灯牌/.test(current) ||
                    !new RegExp(`(?:^|[^0-9])${String(cost).replace('.', '\\.')}钻(?:石)?`).test(current) ||
                    current.length > 350 ||
                    !/^(?:确认|确认加入|确认支付|确认点亮)$/.test((await b.innerText()).trim()) ||
                    !mayDispatch()) return false
                await b.click({ timeout: 3000 })
                return true
              })
            }
        } finally {
          await Promise.all(buttons.map((b) => b.dispose()))
        }
      }
      return false
    } finally {
      await Promise.all(dialogs.map((d) => d.dispose()))
    }
  }
}

export function visibleOpportunity(seconds: number, now = Date.now()): Opportunity {
  return {
    lotteryId: '',
    drawAt: now + seconds * 1000,
    source: 'visible-dom',
    observedAt: now,
    confidence: 'estimated',
    prizeType: 'all',
    winnerCount: null,
    participantCount: null,
    totalDiamonds: null,
    diamondPerWinner: null,
    cost: null,
    membership: 'unknown',
    requiresFollow: false,
    requiresComment: false,
    requiresShare: false,
    commentText: '',
    watchSeconds: null,
    unsupported: [],
    tasksKnown: false
  }
}
