import { Opportunity, Policy, RoomProfile, RoundRecord, RETURN_PREPARATION_SECONDS } from '../shared/policy'

export interface Evaluation {
  feasible: boolean
  reason: string
  probability: number | null
  score: number
  utility: number
  mode: 'estimate' | 'fallback'
  leadSeconds: number
  startAt: number
  endAt: number
}
export function taskLead(
  o: Opportunity,
  p: Policy,
  records: RoundRecord[] = [],
  alreadyOpen = false
): number {
  const samples = records
    .map((r) => r.taskSeconds)
    .filter((n): n is number => n !== null && n >= 0)
    .sort((a, b) => a - b)
  const learned = samples.length >= 10 ? samples[Math.floor((samples.length - 1) * 0.9)] : 0
  return Math.ceil(
    Math.max(
      learned,
      10 +
        (o.requiresComment ? 8 : 0) +
        (o.requiresFollow ? 5 : 0) +
        (o.membership === 'needs-payment' ? 12 : 0) +
        (o.watchSeconds || 0)
    ) + 5 + (alreadyOpen ? 0 : RETURN_PREPARATION_SECONDS)
  )
}
export function projectedParticipants(o: Opportunity, r?: RoomProfile): number | null {
  if (o.participantCount === null) return null
  const observations = (r?.observations || []).filter(
    (x) => x.lotteryId === o.lotteryId && x.participants !== null && x.at <= o.observedAt
  )
  if (observations.length < 3) return o.participantCount
  const first = observations[0],
    last = observations.at(-1)!,
    seconds = (last.at - first.at) / 1000
  if (seconds < 20 || last.participants! < first.participants!) return o.participantCount
  const rate = (last.participants! - first.participants!) / seconds
  return Math.max(
    o.participantCount,
    o.participantCount + (rate * Math.max(0, (o.drawAt || o.observedAt) - o.observedAt)) / 1000
  )
}
export function evaluate(
  o: Opportunity,
  p: Policy,
  now: number,
  room?: RoomProfile,
  records: RoundRecord[] = [],
  alreadyOpen = false
): Evaluation {
  const leadSeconds = taskLead(o, p, records, alreadyOpen),
    startAt = (o.drawAt || 0) - leadSeconds * 1000,
    endAt = (o.drawAt || 0) + 25000
  const reject = (reason: string): Evaluation => ({
    feasible: false,
    reason,
    probability: null,
    score: 0,
    utility: 0,
    mode: 'fallback',
    leadSeconds,
    startAt,
    endAt
  })
  if (room?.blocked) return reject('房间已屏蔽')
  if (!o.lotteryId) return reject('缺少福袋身份，等待复验')
  if (!o.drawAt || !(o.source === 'visible-dom' || (o.source === 'network' && o.confidence === 'exact')))
    return reject('缺少可靠倒计时')
  if (!o.tasksKnown) return reject('任务条件尚未确认，进入低频复验')
  if (o.requiresShare) return reject('不支持分享任务')
  if (o.unsupported.length) return reject(o.unsupported.join('；'))
  if (o.watchSeconds === null) return reject('看播条件未知')
  if (o.cost === null || o.membership === 'unknown') return reject('费用或当前粉丝资格未知')
  if (o.requiresComment && !o.commentText) return reject('评论口令尚未识别')
  if (o.drawAt - now < leadSeconds * 1000) return reject('剩余时间不足以完成任务')
  if (p.objective === 'physical' && o.prizeType !== 'physical') return reject('未确认实物奖品')
  if (p.objective === 'diamond' && o.prizeType !== 'diamond') return reject('未确认钻石奖品')
  const n = projectedParticipants(o, room),
    k = o.winnerCount
  const probability = n !== null && k !== null && n >= k && n > 0 ? Math.min(1, k / n) : null
  const attempts = records.filter((r) => r.submittedAt),
    confirmed = attempts.filter((r) => r.confirmedAt).length
  const q = attempts.length >= 10 ? (confirmed + 2) / (attempts.length + 4) : 0.75
  const minutes = Math.max(1, (o.drawAt - now + 25000) / 60000)
  let reward = probability,
    mode: Evaluation['mode'] = probability === null ? 'fallback' : 'estimate'
  if (p.objective === 'diamond') {
    const each = o.diamondPerWinner ?? (o.totalDiamonds !== null && k !== null ? o.totalDiamonds / k : null)
    if (each === null || probability === null) {
      reward = null
      mode = 'fallback'
    } else reward = probability * each
  }
  const utility = reward === null ? q : q * reward - (p.objective === 'diamond' ? o.cost || 0 : 0)
  const score = utility / minutes
  if (mode === 'estimate' && p.objective === 'diamond' && score <= 0)
    return reject('预计钻石净收益不足以覆盖费用')
  return {
    feasible: true,
    reason: mode === 'estimate' ? '假设同资格等概率，按机会/时间估算' : '样本不足，按任务可完成性与时间排序',
    probability,
    score,
    utility,
    mode,
    leadSeconds,
    startAt,
    endAt
  }
}
export function conflicts(
  a: Pick<Evaluation, 'startAt' | 'endAt'>,
  b: Pick<Evaluation, 'startAt' | 'endAt'>
): boolean {
  return a.startAt < b.endAt && b.startAt < a.endAt
}
/** Exhaustive interval scheduling is cheap for a pool of at most five. */
export function bestSchedule<T extends { evaluation: Evaluation }>(items: T[], limit = 5, navigationGapSeconds = 0): T[] {
  const values = items.slice(0, 6).filter((x) => x.evaluation.feasible)
  let best: T[] = [],
    bestScore = -Infinity
  for (let mask = 1; mask < 1 << values.length; mask++) {
    const chosen = values.filter((_, i) => mask & (1 << i)).sort((a,b) => a.evaluation.startAt-b.evaluation.startAt)
    if (
      chosen.length > limit ||
      chosen.some((a, i) => chosen.slice(i + 1).some((b) => conflicts(a.evaluation, b.evaluation))) ||
      chosen.some((a,i) => i > 0 && a.evaluation.startAt - chosen[i-1].evaluation.startAt < navigationGapSeconds * 1000)
    )
      continue
    const score = chosen.reduce((s, x) => s + x.evaluation.utility, 0)
    if (score > bestScore) {
      bestScore = score
      best = chosen
    }
  }
  return best.sort((a, b) => a.evaluation.startAt - b.evaluation.startAt)
}
export function rankHistory(
  rooms: RoomProfile[],
  now: number,
  p: Policy,
  random: () => number
): RoomProfile[] {
  const scored = rooms
    .filter((r) => !r.blocked && r.nextEligibleCheckAt <= now)
    .map((r) => {
      const recent = r.visits.filter((v) => v.at > now - 14 * 86400_000),
        localHour = new Date(now).getUTCHours()
      const same = recent.filter((v) => new Date(v.at).getUTCHours() === localHour)
      const data = same.length >= 10 ? same : recent
      const availability =
        data.length >= 5 ? (data.filter((v) => v.found).length + 2) / (data.length + 4) : 0.5
      const eligible = r.membership === 'satisfied' && now - r.membershipAt < 3600_000
      const score =
        availability + (r.favorite ? 0.4 : 0) + (eligible ? 0.3 : 0) - Math.min(0.3, r.failures * 0.05)
      return { r, score, tie: random() }
    })
  return scored
    .sort((a, b) => (Math.abs(a.score - b.score) < 0.05 ? a.tie - b.tie : b.score - a.score))
    .map((x) => x.r)
}
