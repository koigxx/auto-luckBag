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

export function roomDisplayName(name: string | undefined, url: string, english = false): string {
  let clean = name?.replace(/\s+/g, ' ').trim()
  // Only strip the known discovery-card envelope, not arbitrary @ or digits in nicknames.
  const card = clean?.match(/^你的关注\s+.+?\s+@\s*(.+?)\s+\d+(?:\.\d+)?[万亿]?$/u)
  if (card) clean = card[1].trim()
  if (clean && !['直播中', '直播间', '点击进入直播间', '进入直播间', '点击进入'].includes(clean) && !/^https?:\/\//i.test(clean)) return clean
  if (!url) return english ? 'System' : '系统'
  try {
    const id = new URL(url).pathname.split('/').filter(Boolean).pop()
    if (id && /^\d+$/.test(id)) return `${english ? 'Room' : '直播间'} ${id}`
  } catch { /* Historical malformed URLs remain available in details. */ }
  return english ? 'Unnamed room' : '未记录名称的直播间'
}
