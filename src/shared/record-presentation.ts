import type { Payment, RoundRecord } from './policy'

// Use persisted ownership, never timestamps: results can arrive after a run ends.
export function inRun(record: { runId?: string }, scope: string): boolean {
  return !scope || (scope === 'unassigned' ? !record.runId : record.runId === scope)
}

export function recordTotals(rounds: RoundRecord[], payments: Payment[]) {
  const confirmed = rounds.filter(r => r.confirmedAt != null)
  return {
    confirmed: confirmed.length,
    won: confirmed.filter(r => r.result === 'won').length,
    lost: confirmed.filter(r => r.result === 'lost').length,
    unknown: rounds.filter(r => r.result === 'unknown').length,
    pending: rounds.filter(r => r.result === 'pending').length,
    spent: payments.filter(p => p.state === 'confirmed').reduce((sum, p) => sum + p.cost, 0),
    reserved: payments.filter(p => ['reserved', 'submitted', 'unresolved'].includes(p.state)).reduce((sum, p) => sum + p.cost, 0)
  }
}

// Called only for discovery anchor text, whose card layout includes title/host/viewers.
export function discoveryRoomName(text: string): string {
  const clean=text.replace(/\s+/g,' ').trim()
  const card=clean.match(/^.+?\s+@\s*(.+?)\s+\d+(?:\.\d+)?[万亿]?[+＋]?$/u)
  return (card?.[1]?.trim() || clean).slice(0,80)
}

export function usableRoomName(name: string | undefined): string {
  const clean=(name || '').replace(/\s+/g,' ').trim().replace(/\s+-\s+抖音直播$/, '')
  if (!clean || ['直播中','直播间','点击进入直播间','进入直播间','点击进入','抖音直播'].includes(clean) ||
      /^https?:\/\//i.test(clean) || /^抖音直播电脑版[_｜|].*抖音直播网页版入口/.test(clean)) return ''
  return clean
}

export function roomDisplayName(name: string | undefined, url: string, english = false): string {
  let clean = usableRoomName(name)
  // Only strip the known discovery-card envelope, not arbitrary @ or digits in nicknames.
  const card = clean?.match(/^你的关注\s+.+?\s+@\s*(.+?)\s+\d+(?:\.\d+)?[万亿]?[+＋]?$/u)
  if (card) clean = card[1].trim()
  if (clean && !['直播中', '直播间', '点击进入直播间', '进入直播间', '点击进入'].includes(clean) && !/^https?:\/\//i.test(clean)) return clean
  if (!url) return english ? 'System' : '系统'
  try {
    const id = new URL(url).pathname.split('/').filter(Boolean).pop()
    if (id && /^\d+$/.test(id)) return `${english ? 'Room' : '直播间'} ${id}`
  } catch { /* Historical malformed URLs remain available in details. */ }
  return english ? 'Unnamed room' : '未记录名称的直播间'
}
