import { Opportunity } from '../shared/policy'

const positive = (n: unknown): number | null =>
  Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null
const timestamp = (n: unknown): number | null => {
  const v = positive(n)
  return v === null ? null : v > 1e10 ? v : v * 1000
}
export function findLottery(value: unknown, depth = 0): any | null {
  if (!value || typeof value !== 'object' || depth > 8) return null
  const v = value as any
  if (v.lottery_info && typeof v.lottery_info === 'object') return v.lottery_info
  if ((v.lottery_id || v.lottery_id_str) && ('draw_time' in v || 'count_down' in v)) return v
  for (const child of Object.values(v)) {
    const found = findLottery(child, depth + 1)
    if (found) return found
  }
  return null
}
export function parseLottery(text: string, now = Date.now()): Opportunity | null {
  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (payload.status_code !== undefined && Number(payload.status_code) !== 0) return null
  const info = findLottery(payload)
  if (!info) return null
  const id = String(info.lottery_id_str || info.lottery_id || '')
  const serverNow = timestamp(info.current_time ?? payload.extra?.now)
  const draw = timestamp(info.draw_time ?? info.real_draw_time)
  const countdown = positive(info.count_down)
  const drawAt =
    draw !== null
      ? draw + (serverNow !== null ? now - serverNow : 0)
      : countdown !== null
        ? now + countdown * 1000
        : null
  const conditions = Array.isArray(info.conditions) ? info.conditions : null
  const user = payload.data?.user_condition || payload.user_condition || {}
  const o: Opportunity = {
    lotteryId: id,
    drawAt,
    source: 'network',
    observedAt: now,
    confidence: drawAt ? 'exact' : 'unknown',
    prizeType: 'all',
    winnerCount: positive(info.winner_count),
    participantCount: positive(info.participant_count),
    totalDiamonds: positive(info.total_diamond_count),
    diamondPerWinner: positive(info.diamond_per_winner),
    cost: null,
    membership: 'unknown',
    requiresFollow: false,
    requiresComment: false,
    requiresShare: false,
    commentText: '',
    watchSeconds: null,
    unsupported: [],
    tasksKnown: conditions !== null,
    memberKnown: typeof user.is_fansclub_member === 'boolean' ? user.is_fansclub_member : null
  }
  const prize = String(info.prize_name || info.title || '')
  if (/优惠券|购物券/.test(prize)) o.prizeType = 'coupon'
  else if (/钻石|抖币/.test(prize)) o.prizeType = 'diamond'
  else if (/实物|收货|奖品/.test(prize)) o.prizeType = 'physical'
  if (!conditions) return o
  o.cost = 0
  o.membership = 'satisfied'
  o.watchSeconds = 0
  for (const c of conditions) {
    const description = String(c.description || c.content || '')
    const completed = Number(c.status) === 1
    // This is the explicit submit step, not an extra qualification or proof of success.
    // Match only the observed label; unknown tasks must continue to fail closed.
    if (description.replace(/\s+/g, '') === '手动参与') continue
    if (/分享|转发/.test(description) || Number(c.type) === 4) {
      o.requiresShare = true
      continue
    }
    if (/粉丝团|灯牌/.test(description) || Number(c.type) === 8) {
      if (
        completed ||
        (c.status === undefined && user.is_fansclub_member === true && user.fansclub_status_active === true)
      )
        continue
      o.membership = 'needs-payment'
      o.cost = positive(description.match(/(\d+)\s*(?:钻石|钻)/)?.[1])
      if (/等级|[≥＞>]|\d+级/.test(description)) o.unsupported.push('粉丝团等级条件尚未满足')
    } else if (/关注/.test(description) || Number(c.type) === 1) {
      o.requiresFollow = !completed && user.has_follow !== true
    } else if (/评论|口令|发送/.test(description) || Number(c.type) === 3) {
      o.requiresComment = !completed && user.has_command !== true
      const content = String(c.content || '')
      const separateContent =
        c.description &&
        content !== description &&
        !/^(?:发送口令|发表评论|发送评论|评论参与)$/.test(content.trim())
          ? content
          : ''
      o.commentText = String(
        c.command ||
          c.keyword ||
          commentCommand(description) ||
          commentCommand(content) ||
          separateContent ||
          ''
      ).trim()
    } else if (/观看|看播|停留/.test(description)) {
      if (!completed) {
        const remain = positive(c.remaining_seconds)
        o.watchSeconds = remain
        if (remain === null) o.unsupported.push('看播剩余时间未知')
      }
    } else if (!completed) o.unsupported.push(description || `未识别条件 ${c.type}`)
  }
  return o
}
function commentCommand(text: string): string {
  // Do not send task instructions such as “发表评论” as if they were the command.
  const quoted = text.match(/(?:发送|评论|口令)[^\n“「"]{0,8}[“「"]([^”」"\n]{1,100})[”」"]/)?.[1]
  const labelled = text.match(/(?:发送口令|口令|评论内容|评论)[：:]\s*([^，。！!\n]{1,100})/)?.[1]
  return (quoted || labelled || '').trim()
}
export function parseOwnResult(text: string) {
  const compact = text.replace(/\s+/g, ' ')
  const participated = /参与成功|报名成功|等待开奖|成功参与|已成功参与|已参与/.test(compact)
  const won = /你已中奖|您已中奖|恭喜(?:你|您).{0,20}(?:中奖|获得|抽中)|我的奖品/.test(compact)
  const lost = /很遗憾.{0,12}(?:未中奖|没有中奖)|本次未中奖|未抽中/.test(compact)
  const prizeType = won
    ? /优惠券|购物券/.test(compact)
      ? 'coupon'
      : /钻石|抖币/.test(compact)
        ? 'diamond'
        : /实物|收货地址|填写地址/.test(compact)
          ? 'physical'
          : 'unknown'
    : null
  const amount =
    prizeType === 'diamond'
      ? Number(compact.match(/(?:获得|抽中|中奖)[^，。!！]{0,40}?(\d{1,6})\s*(?:钻石|钻)/)?.[1] || 0)
      : 0
  return {
    participated: participated || won || lost,
    won,
    lost,
    prizeType,
    diamondAmount: amount,
    resultText: won ? '本人中奖结果已确认' : lost ? '本轮未中奖' : participated ? '参与已确认' : '结果未知'
  } as const
}
export function supplementVisibleTask(o: Opportunity, text: string): Opportunity {
  const next = { ...o, unsupported: [...o.unsupported] }
  if (next.requiresComment && !next.commentText) next.commentText = commentCommand(text)
  if (next.membership === 'needs-payment' && next.cost === null) {
    const m = text.replace(/\s+/g, '').match(/(?:加入粉丝团|点亮粉丝团|点亮灯牌)[（(](\d+)(?:钻石|钻)[）)]/)
    if (m) next.cost = Number(m[1])
  }
  return next
}
export function riskFromText(text: string): string {
  return (
    text.match(
      /请完成安全验证|请完成验证|拖动滑块.{0,12}验证|访问过于频繁|操作过于频繁|账号.{0,8}(?:被限制|已封禁)|支付.{0,8}(?:受限|异常)|当前环境异常|安全验证/i
    )?.[0] || ''
  )
}
