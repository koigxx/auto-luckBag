import type { Page } from 'playwright'
import { riskFromText } from './lottery-parser'

// Read visible challenge UI only. Never inspect input values or solve a challenge.
export async function visiblePageRisk(page: Page): Promise<string> {
  let incomplete = false
  for (const frame of page.frames()) {
    try {
    if (frame !== page.mainFrame()) {
      const element = await frame.frameElement()
      try { if (!await element.isVisible()) continue } finally { await element.dispose() }
    }
    const evidence = await frame.evaluate(() => {
      const nodes = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [class*="captcha"], [id*="captcha"], [class*="verify"], [id*="verify"]')]
      if (/验证码|安全验证|访问异常/.test(document.title)) nodes.push(document.body)
      const visible = nodes.filter(el => {
        const r=el.getBoundingClientRect(),s=getComputedStyle(el)
        return r.width>20 && r.height>20 && s.display!=='none' && s.visibility!=='hidden' && +s.opacity>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth
      })
      return { text:visible.map(el=>el.innerText.slice(0,1500)).join('\n'),
        captcha:visible.some(el=>el.id==='captcha_container' && !!el.querySelector('img,canvas,input,[role="slider"]')) }
    })
    const reason = riskFromText(evidence.text)
    if (reason || evidence.captcha) return reason || '检测到可见安全验证'
    } catch { incomplete = true }
  }
  if(incomplete)throw new Error('页面状态尚未读取完整，请稍后检查')
  return ''
}
