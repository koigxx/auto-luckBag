import { Page, ElementHandle } from 'playwright'
import { Opportunity } from '../shared/policy'

export const MODAL_SELECTOR =
  '[role="dialog"], [class*="Modal"], [class*="modal"], [class*="dialog"], [class*="Lottery"], [class*="lottery"], [class*="fudai"]'

export class LotteryDom {
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
  async panel(): Promise<ElementHandle<HTMLElement> | null> {
    const handle = await this.page.evaluateHandle((selector) => {
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
          return (
            visible(el) &&
            /福袋|开奖/.test(t) &&
            /参与|粉丝团|关注|口令|中奖|未抽中|看播|观看|恭喜(?:你|您)|我的奖品/.test(t) &&
            t.length < 2000
          )
        })
        .sort(
          (a, b) =>
            a.getBoundingClientRect().width * a.getBoundingClientRect().height -
            b.getBoundingClientRect().width * b.getBoundingClientRect().height
        )
      return roots[0] || null
    }, MODAL_SELECTOR)
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
    if (await this.panelText()) return true
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
          return true
        }
      }
      return false
    } finally {
      await Promise.all(targets.map((t) => t.dispose()))
    }
  }
  async action(pattern: RegExp): Promise<boolean> {
    const panel = await this.panel()
    if (!panel) return false
    const targets = await panel.$$('button, [role="button"], a, div, span')
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
          await this.perform(this.signal, () => el.click({ timeout: 4000 }))
          return true
        }
      }
      return false
    } finally {
      await Promise.all(targets.map((t) => t.dispose()))
      await panel.dispose()
    }
  }
  async comment(command: string): Promise<boolean> {
    if (!command || command.length > 100) return false
    if (
      await this.action(/^(?:发送口令|一键发送|一键评论|发表评论|发送评论|评论参与|评论并参与|一键评论参与)$/)
    )
      return true
    const input = this.page
      .locator(
        'textarea[placeholder*="说点"], input[placeholder*="说点"], [contenteditable="true"][data-placeholder*="说点"]'
      )
      .first()
    if (!(await input.isVisible())) return false
    await this.perform(this.signal, () => input.fill(command, { timeout: 3000 }))
    await this.perform(this.signal, () => input.press('Enter', { timeout: 3000 }))
    return true
  }
  async paymentConfirmation(cost: number): Promise<boolean> {
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
              await this.perform(this.signal, () => b.click({ timeout: 3000 }))
              return true
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
