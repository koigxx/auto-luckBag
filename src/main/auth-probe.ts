import { visiblePageRisk } from './page-risk'
import type { BrowserContext, Response } from 'playwright'
import { hasOwnProfileEntry } from './auth-dom'

export type ProbeResult = 'connected' | 'expired' | 'unknown'
function isSelfResponse(url: string): boolean {
  const parsed = new URL(url)
  return parsed.protocol === 'https:' && ['www.douyin.com', 'live.douyin.com'].includes(parsed.hostname) &&
    ['/aweme/v1/web/user/profile/self/', '/webcast/user/me/'].includes(parsed.pathname)
}

// Only a response describing the viewer themselves can prove authentication.
// This parser never issues requests: the normal page must request this data.
export function selfResponseResult(url: string, status: number, body: any): ProbeResult {
  const parsed = new URL(url)
  if (!isSelfResponse(url)) return 'unknown'
  if (status === 401) return 'expired'
  if (status !== 200 || !body || typeof body !== 'object') return 'unknown'
  if (body.is_login === false || body.data?.is_login === false) return 'expired'
  const message = body.status_msg ?? body.message ?? body.data?.message
  if (typeof body.status_code === 'number' && body.status_code !== 0 && typeof message === 'string' &&
      /^(?:用户未登录|未登录|登录已过期|登录已失效|not logged in|login required|session expired)[。.!！\s]*$/i.test(message)) return 'expired'
  if (body.status_code !== 0) return 'unknown'
  const user = body.user || body.data?.user || (parsed.pathname === '/webcast/user/me/' ? body.data : null)
  const id = user?.uid ?? user?.id_str ?? user?.id
  return (typeof id === 'string' && /^[1-9]\d*$/.test(id)) ||
    (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ? 'connected' : 'unknown'
}

export async function probeSession(context: BrowserContext, signal: AbortSignal, timeoutMs = 15000, observe?: (event: 'page-ready' | 'page-error' | 'evidence' | 'expired' | 'challenge' | 'closed') => void): Promise<ProbeResult> {
  if (signal.aborted) return 'unknown'
  const page = await context.newPage()
  let result: ProbeResult = 'unknown'
  let finish!: (result: ProbeResult) => void
  const evidence = new Promise<ProbeResult>(resolve => { finish = resolve })
  let closed = false
  const abort = () => { finish('unknown'); void page.close().catch(() => {}) }
  const report = (event: Parameters<NonNullable<typeof observe>>[0]) => { if(!closed && !signal.aborted)observe?.(event) }
  const onClose = () => { report('closed'); closed = true; finish('unknown') }
  const listener = async (response: Response) => {
    try {
      if (!isSelfResponse(response.url())) return
      const verdict = selfResponseResult(response.url(), response.status(), await response.json().catch(() => null))
      if (!closed && !signal.aborted && verdict !== 'unknown') { report(verdict==='connected'?'evidence':'expired'); result = verdict; finish(verdict) }
    } catch { /* Invalid/unrelated responses provide no authentication evidence. */ }
  }
  page.on('response', listener)
  page.once('close', onClose)
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => finish('unknown'), timeoutMs)
  let reading = false
  const domTimer = setInterval(async () => {
    if (closed || signal.aborted || reading) return
    reading = true
    try {
      if(await visiblePageRisk(page).catch(()=>''))report('challenge')
      if (await hasOwnProfileEntry(page) && !closed && !signal.aborted && result !== 'expired') { report('evidence'); finish('connected') }
    } finally { reading = false }
  }, 500)
  try {
    if (signal.aborted) return 'unknown'
    // Public normal page, not a private API call or replay. No login interaction.
    void page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      .then(() => report('page-ready')).catch(() => { report('page-error'); finish(result) })
    return await evidence
  } finally {
    closed = true
    clearTimeout(timer)
    clearInterval(domTimer)
    signal.removeEventListener('abort', abort)
    page.off('response', listener)
    page.off('close', onClose)
    await page.close().catch(() => {})
  }
}
