import type { Page } from 'playwright'

export const LIVE_LOGIN_REQUIRED = '当前直播间未登录，已停止自动运行；请打开浏览器重新确认登录后手动启动'

// Match the chat composer's login control, not a message mentioning login.
export async function hasLiveLoginPrompt(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (location.protocol !== 'https:' || location.hostname !== 'live.douyin.com') return false
    return [...document.querySelectorAll<HTMLElement>('span,a,button,[role="button"]')].some(control => {
      if (control.textContent?.trim() !== '登录') return false
      const row = control.parentElement
      if (!row || row.textContent?.replace(/\s/g,'') !== '需先登录，才能开始聊天') return false
      const rect = row.getBoundingClientRect(), r = control.getBoundingClientRect()
      if (rect.width < 80 || rect.height < 12 || rect.top < innerHeight / 2 || rect.left < innerWidth / 2 ||
          rect.right > innerWidth + 2 || rect.bottom > innerHeight + 2 || r.width < 10 || r.height < 10) return false
      if (!control.matches('a,button,[role="button"]') && getComputedStyle(control).cursor !== 'pointer') return false
      for (let node:Element|null=control;node;node=node.parentElement) {
        const style=getComputedStyle(node)
        if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0||node.getAttribute('aria-hidden')==='true')return false
      }
      const top = document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)
      return !!top && (control.contains(top)||top.contains(control))
    })
  })
}

// Verified in the application's signed-in browser on 2026-11-06. The rendered
// link has no enter_method query, despite the component passing one to ALink.
// Scope to the actual header and live-avatar component: self links alone also
// exist in the signed-out navigation and personal menu.
export async function hasOwnProfileEntry(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (location.protocol !== 'https:' || !['live.douyin.com', 'www.douyin.com'].includes(location.hostname)) return false
    const visible = (element: Element): boolean => {
      const r = element.getBoundingClientRect()
      if (r.width < 16 || r.height < 16 || r.top < 0 || r.bottom > Math.min(160, innerHeight) ||
          r.left < innerWidth / 2 || r.right > innerWidth) return false
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 ||
            node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('inert')) return false
      }
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!top && (element.contains(top) || top.contains(element))
    }
    return [...document.querySelectorAll<HTMLAnchorElement>('#douyin-header-menuCt a[href]')].some(link => {
      let url: URL
      try { url = new URL(link.href, location.href) } catch { return false }
      if (url.protocol !== 'https:' || url.hostname !== 'www.douyin.com' || url.pathname !== '/user/self' || !visible(link)) return false
      return [...link.querySelectorAll('[data-e2e="live-avatar"] img')].some(img => !!img.getAttribute('src') && visible(img))
    })
  }).catch(() => false)
}
