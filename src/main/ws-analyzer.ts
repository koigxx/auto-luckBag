export interface FudaiInfo {
  type: 'all' | 'physical' | 'diamond' | 'other'
  requiresFollow: boolean
  requiresFanBadge: boolean
  requiresComment: boolean
  commentText: string
  fanBadgeCost: number
  description: string
  remainingSeconds?: number | null
  raw?: unknown
}

const FUDAI_METHODS = [
  'WebcastLuckBagMessage',
  'WebcastLotteryEvent',
  'WebcastRedPocketMessage'
]

const TYPE_KEYWORDS: Array<[RegExp, FudaiInfo['type']]> = [
  [/实物|奖品|收货地址|包邮/, 'physical'],
  [/钻石|抖币|diamond|coin/i, 'diamond'],
  [/优惠券|券|coupon/i, 'other']
]

export function analyzeWebSocketFrame(payload: string | Buffer): FudaiInfo | null {
  try {
    const payloadText = typeof payload === 'string' ? payload : payload.toString('utf-8')
    try {
      const json = JSON.parse(payloadText)
      return parseJsonMessage(json)
    } catch {
      return parseTextMessage(payloadText)
    }
  } catch {
    return null
  }
}

function parseJsonMessage(json: any): FudaiInfo | null {
  if (!json) return null
  const method = String(json.method || json.type || '')
  const methodMatched = FUDAI_METHODS.some((name) => method.includes(name))
  const data = json.data || json.payload || json.message || json
  const text = JSON.stringify(data)

  if (!methodMatched && !hasFudaiSignal(text)) return null
  return extractFudaiInfo(data, method || 'json')
}

function parseTextMessage(text: string): FudaiInfo | null {
  if (!hasFudaiSignal(text)) return null

  return {
    type: detectType(text),
    requiresFollow: /关注|follow/i.test(text),
    requiresFanBadge: /粉丝团|灯牌|fan.?badge|club/i.test(text),
    requiresComment: /评论|口令|comment|keyword/i.test(text),
    commentText: extractCommentText(text),
    fanBadgeCost: extractFanBadgeCost(text),
    remainingSeconds: parseRemainingSeconds(text),
    description: text.replace(/\s+/g, ' ').slice(0, 160)
  }
}

function extractFudaiInfo(data: any, method: string): FudaiInfo {
  const text = JSON.stringify(data)
  const description = String(
    data?.description || data?.title || data?.content || data?.text || method || '福袋'
  )
  const conditions = data?.conditions || data?.requirements || data?.condition || {}
  const fanBadgeCost =
    Number(conditions.fan_badge_cost || conditions.diamond_cost || data?.fan_badge_cost) || 1

  return {
    type: detectType(`${description} ${text}`),
    requiresFollow: Boolean(conditions.require_follow || data?.require_follow || /关注|follow/i.test(text)),
    requiresFanBadge: Boolean(
      conditions.require_fan_badge || data?.require_fan_badge || /粉丝团|灯牌|fan.?badge/i.test(text)
    ),
    requiresComment: Boolean(
      conditions.require_comment || data?.require_comment || /评论|口令|comment|keyword/i.test(text)
    ),
    commentText:
      String(data?.comment_text || data?.keyword || conditions.comment_text || '') ||
      extractCommentText(text),
    fanBadgeCost,
    remainingSeconds: parseRemainingSeconds(text),
    description,
    raw: data
  }
}

function hasFudaiSignal(text: string): boolean {
  return /福袋|超级福袋|粉丝福袋|luck.?bag|red.?pocket|lottery/i.test(text)
}

function detectType(text: string): FudaiInfo['type'] {
  for (const [pattern, type] of TYPE_KEYWORDS) {
    if (pattern.test(text)) return type
  }
  return 'all'
}

function extractCommentText(text: string): string {
  const match = text.match(/(?:口令|评论|发送)[：:\s"'“”]*([\u4e00-\u9fa5A-Za-z0-9_-]{1,30})/)
  return match?.[1] || ''
}

function extractFanBadgeCost(text: string): number {
  const match = text.match(/(\d{1,3})\s*(?:钻石|抖币)/)
  return match ? Math.max(1, Number(match[1])) : 1
}

function parseRemainingSeconds(text: string): number | null {
  const normalized = text.replace(/\s+/g, '')
  const hhmmss = normalized.match(/(\d{1,2}):(\d{1,2}):(\d{1,2})/)
  if (hhmmss) return Number(hhmmss[1]) * 3600 + Number(hhmmss[2]) * 60 + Number(hhmmss[3])
  const mmss = normalized.match(/(\d{1,2}):(\d{1,2})/)
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2])
  const minSec = normalized.match(/(?:(\d+)分)?(\d+)秒/)
  if (minSec) return Number(minSec[1] || 0) * 60 + Number(minSec[2])
  const minutes = normalized.match(/(\d+)分钟/)
  if (minutes) return Number(minutes[1]) * 60
  return null
}
