import { Opportunity } from '../shared/policy'

const positive = (n: unknown): number | null =>
  Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null
const timestamp = (n: unknown): number | null => {
  const v = positive(n)
  return v === null ? null : v > 1e10 ? v : v * 1000
}
// Preserve 64-bit IDs before JSON.parse can round them. Quoted strings are left intact.
export function parseLotteryPayload(text: string): any {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token =>
    /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token
  ))
}
export function lotteryIdOf(info: any): string {
  const id = info?.lottery_id_str || info?.lottery_id
  return typeof id === 'string' ? id : Number.isSafeInteger(id) ? String(id) : ''
}
/** Only called for an explicitly supported, naturally observed lottery user-rights response. */
export function panelIdentity(payload: any, url: URL, post = ''): { id: string | null; reason: string } {
  if (payload?.status_code !== 0 && payload?.status_code !== '0') return { id: null, reason: '弹窗业务响应未成功' }
  const data = payload.data
  const info = findLottery(payload)
  const ids = [lotteryIdOf(info), lotteryIdOf(data), lotteryIdOf(payload)].filter(Boolean)
  const query = url.searchParams
  let body: any
  try { body = parseLotteryPayload(post) } catch { body = Object.fromEntries(new URLSearchParams(post)) }
  ids.push(...[query.get('lottery_id_str'), query.get('lottery_id'), lotteryIdOf(body)].filter((v): v is string => !!v))
  if (new Set(ids).size > 1) return { id: null, reason: '弹窗请求与响应的福袋身份不一致' }
  // A request ID alone plus a generic success envelope does not establish a panel.
  const recognized = !!info || !!lotteryIdOf(data) || !!lotteryIdOf(payload) ||
    (data?.user_condition && typeof data.user_condition === 'object')
  return ids.length && recognized
    ? { id: ids[0], reason: '弹窗身份已确认' }
    : { id: null, reason: '弹窗响应缺少可关联的福袋身份或任务结构' }
}

const FAN_LEVEL_UNMET = '粉丝团等级条件尚未满足'
function fanLevel(text: string): number | null {
  const n = text.match(/(?:等级\s*[：:]?\s*|达到\s*|[≥＞>]\s*)?(\d+)\s*级/)?.[1] ||
    text.match(/(?:等级|级别)\s*[：:]?\s*(\d+)/)?.[1]
  if (n) return /(?:大于|超过|高于|[＞>])\s*\d/.test(text) ? Number(n) + 1 : Number(n)
  if (/[一二三四五六七八九十]级|等级|级别|[≥＞>]/.test(text)) return null
  return 0
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
    payload = parseLotteryPayload(text)
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null
  if (payload.status_code !== undefined && payload.status_code !== 0 && payload.status_code !== '0') return null
  const info = findLottery(payload)
  if (!info) return null
  const id = lotteryIdOf(info)
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
    const type = Number(c.type)
    const comment = type === 3 || /^(?:发送|发表|一键)?(?:评论|口令)|^发送[“「"]/.test(description)
    if ((!comment && /分享|转发/.test(description)) || type === 4) {
      o.requiresShare = true
      continue
    }
    // A command may itself contain “关注” or “粉丝团”; its words are not extra tasks.
    if (!comment && (/粉丝团|灯牌/.test(description) || type === 8)) {
      const level = fanLevel(description)
      o.fanLevelRequired = level === null || o.fanLevelRequired === null
        ? null : Math.max(o.fanLevelRequired || 0, level)
      if (
        completed ||
        (level === 0 && c.status === undefined && user.is_fansclub_member === true && user.fansclub_status_active === true)
      )
        continue
      o.membership = 'needs-payment'
      o.cost = positive(description.match(/(\d+)\s*(?:钻石|钻)/)?.[1])
      if (level === null || level > 1 || /提升亲密度|升级/.test(description)) o.unsupported.push(FAN_LEVEL_UNMET)
    } else if (!comment && (/关注/.test(description) || type === 1)) {
      o.requiresFollow = !completed && !(c.status === undefined && user.has_follow === true)
    } else if (comment) {
      o.requiresComment = !completed && !(c.status === undefined && user.has_command === true)
      const content = String(c.content || '')
      const separateContent =
        ((c.description && content !== description) || (type === 3 && !c.description)) &&
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
  const labelled = text.match(/(?:发送口令|口令|评论内容|评论)[：:]\s*([^\n]{1,100})/)?.[1]
  return (quoted || labelled || '').replace(/\s*(?:未达成|已达成|未完成|已完成)\s*$/, '').trim()
}
export function parseOwnResult(text: string) {
  const cleaned = text.replace(/(?:发送评论|发表评论|发送口令|评论内容|口令|评论)[：:]\s*[^\n]*/g, '')
    .replace(/\d+(?:\.\d+)?\s*万?\s*人\s*已(?:成功)?参与/g, '')
    .replace(/已参与\s*\d+(?:\.\d+)?\s*万?\s*人/g, '')
  const compact = cleaned.replace(/\s+/g, ' ')
  const participated = /参与成功|报名成功|等待开奖|成功参与|已成功参与|已参与/.test(compact)
  const notParticipated = /未参与|没有参与|未报名|未成功参与|未获得抽奖资格/.test(compact)
  const loss = /很遗憾.{0,12}(?:未中奖|没有中奖|没中奖|未抽中|没抽中)|(?:本次|本轮|您|你)(?:未中奖|没有中奖|没中奖|未抽中|没抽中)|^(?:未中奖|未抽中)[！!。\s]*$/m.test(cleaned)
  const win = /你已中奖|您已中奖|恭喜(?:你|您).{0,20}(?:中奖|获得|抽中)|^(?:恭喜中奖|中奖啦|中奖成功)(?:[！!，,。\s：:]|$)|^(?:您|你|本次|本轮)(?:已)?(?:获得|抽中)/m.test(cleaned)
  // Conflicting/negative content is not evidence for a reward.
  const qualificationOnly = /(?:获得|抽中)[^。！!\n]{0,12}(?:资格|机会)/.test(cleaned)
  const won = !notParticipated && !qualificationOnly && win && !loss
  const lost = !notParticipated && loss && !win
  // Some modal versions render adjacent labels inline; preserve only bounded reward fields.
  const lines = cleaned.replace(/(我的奖品|中奖奖品|获得奖品|奖品名称|奖品|奖品数量|数量)[：:]/g, '\n$1：')
    .replace(/\s+(?=请(?:填写|提交|确认|领取)|收货地址|领取奖品)/g, '\n')
    .split(/\n/).map(s => s.trim()).filter(Boolean)
  const labelled = lines.find(s => /^(?:我的奖品|中奖奖品|获得奖品|奖品名称|奖品)[：:]/.test(s))
    ?.replace(/^(?:我的奖品|中奖奖品|获得奖品|奖品名称|奖品)[：:]\s*/, '')
  const obtained = lines.map(s => s.replace(/^恭喜(?:你|您)?中奖[，,！!。\s]*/, '')
    .match(/^(?:恭喜(?:你|您)?[，,！!\s]*)?(?:您|你|本次|本轮)?(?:已)?(?:获得|抽中)[：:\s]*(.+)$/)?.[1]).find(Boolean)
  const reward = won ? (labelled || obtained || '').replace(/[！!。]+$/, '').trim().slice(0, 100) : ''
  const quantityPattern = /\s*(?:[xX×*]\s*)?(\d{1,6}|[一二三四五六七八九十])\s*(个|件|份|台|副|套|张|部|盒|本|只|支|包)\s*$/
  const quantityMatch = reward.match(quantityPattern)
  const quantityField = lines.find(s => /^(?:奖品数量|数量)[：:]/.test(s))
    ?.replace(/^(?:奖品数量|数量)[：:]\s*/, '')
    .match(/^(\d{1,6}|[一二三四五六七八九十])\s*(个|件|份|台|副|套|张|部|盒|本|只|支|包)?$/)
  const quantity = quantityMatch || quantityField
  const digits: Record<string,number> = {一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10}
  const prizeQuantity = quantity ? (digits[quantity[1]] ?? Number(quantity[1])) : null
  const prizeName = reward ? reward.slice(0, quantityMatch?.index ?? reward.length).trim() || null : null
  // Only explicit personal reward text/lines; never the bag's total, odds or audience count.
  const amountPattern = /^(?:(?:奖励|获得|我的奖品)[：:]?\s*)?\d{1,6}\s*(?:钻石|钻)[！!。\s]*$|^(?:钻石奖励|获得钻石)[：:]\s*\d{1,6}[！!。\s]*$/
  const amounts = won ? [...new Set([reward, ...lines].filter(s => amountPattern.test(s))
    .map(s => Number(s.match(/\d{1,6}/)![0])))] : []
  const amount = amounts.length === 1 ? amounts[0] : null
  const prizeType = won
    ? /优惠券|购物券/.test(reward || compact)
      ? 'coupon'
      : amount !== null || /钻石/.test(reward || compact)
        ? 'diamond'
        : /实物|收货地址|填写地址/.test(compact) || (!!prizeName && !!quantity && !/币|钻/.test(prizeName))
          ? 'physical'
          : 'unknown'
    : null
  return {
    participated: !notParticipated && (participated || won || lost),
    won,
    lost,
    prizeType,
    diamondAmount: prizeType === 'diamond' ? amount : null,
    prizeName: won ? prizeName : null,
    prizeQuantity: won ? prizeQuantity : null,
    prizeUnit: won ? quantity?.[2] ?? null : null,
    resultText: won ? '本人中奖结果已确认' : lost ? '本轮未中奖' : !notParticipated && participated ? '参与已确认' : '结果未知'
  } as const
}
export function supplementVisibleTask(o: Opportunity, text: string, matchedPanel = false): Opportunity {
  const next = { ...o, unsupported: [...o.unsupported] }
  // Only an identity-bound panel may clear a task; never infer completion from a missing row.
  if (matchedPanel) {
    const rows = text.matchAll(/([^\n]+?)\s*(未达成|已达成|未完成|已完成)(?=\s|$)/g)
    for (const [, description, status] of rows) {
      const complete = status === '已达成' || status === '已完成'
      if (/^(?:发送|发表)?评论|口令/.test(description.trim())) {
        next.requiresComment = !complete
        next.commentText = commentCommand(description) || next.commentText
      } else if (/分享|转发/.test(description)) {
        next.requiresShare = true
      } else if (/粉丝团|灯牌/.test(description)) {
        const level = fanLevel(description)
        const provesLevel = level !== null && next.fanLevelRequired !== null &&
          level >= (next.fanLevelRequired || 0)
        if (!complete || provesLevel) next.unsupported = next.unsupported.filter(x => x !== FAN_LEVEL_UNMET)
        if (complete) {
          next.membership = 'satisfied'
          next.cost = 0
        } else {
          next.membership = 'needs-payment'
          next.cost = null
          if (level === null || level > 1 || next.fanLevelRequired === null || (next.fanLevelRequired || 0) > 1)
            next.unsupported.push(FAN_LEVEL_UNMET)
        }
      } else if (/关注/.test(description)) next.requiresFollow = !complete
      else if (!complete && description.replace(/\s+/g, '') !== '手动参与') {
        if (!(/观看|看播|停留/.test(description) && next.watchSeconds !== null && next.watchSeconds > 0))
          next.unsupported.push('弹窗存在无法解释的未完成任务')
      }
    }
    if (/提升亲密度/.test(text) && !next.unsupported.includes(FAN_LEVEL_UNMET))
      next.unsupported.push(FAN_LEVEL_UNMET)
  }
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
