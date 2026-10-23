export interface Policy {
  objective: 'opportunity' | 'diamond' | 'physical'
  membership: 'existing' | 'prefer' | 'whitelist'
  sessionMin: number
  sessionMax: number
  breakMin: number
  breakMax: number
  dailyMinutes: number
  dailySpend: number
  anchorSpend: number
  paymentLimit: number
  dailyNewClubs: number
  reinvestRatio: number
  reinvestCap: number
  explorationRatio: number
  newRoomsPerHour: number
  navigationsPerHour: number
  actionsPerMinute: number
  navigationMinSeconds: number
  navigationMaxSeconds: number
  maxRounds: number
  maxStayMinutes: number
  nextRoundWaitSeconds: number
  allowedStart: string
  allowedEnd: string
  timezone: string
  autoResume: boolean
}

export const DEFAULT_POLICY: Policy = {
  objective: 'opportunity', membership: 'prefer', sessionMin: 25, sessionMax: 40,
  breakMin: 10, breakMax: 20, dailyMinutes: 460, dailySpend: 50, anchorSpend: 5,
  paymentLimit: 1, dailyNewClubs: 50, reinvestRatio: 1, reinvestCap: 10,
  explorationRatio: 0.6, newRoomsPerHour: 30, navigationsPerHour: 40, actionsPerMinute: 20,
  navigationMinSeconds: 90, navigationMaxSeconds: 120, maxRounds: 6,
  maxStayMinutes: 20, nextRoundWaitSeconds: 60,
  allowedStart: '00:00', allowedEnd: '00:00', timezone: 'Asia/Shanghai', autoResume: true
}

export const SOURCE_TO_FIRST_ROOM_SECONDS = 20
export const VERIFICATION_MAX_SECONDS = 28
export const RETURN_VERIFICATION_MAX_SECONDS = 12
export const ROOM_NAVIGATION_TIMEOUT_SECONDS = 30
export const RETURN_SCHEDULING_MARGIN_SECONDS = 3
export const RETURN_PREPARATION_SECONDS = ROOM_NAVIGATION_TIMEOUT_SECONDS + RETURN_VERIFICATION_MAX_SECONDS + RETURN_SCHEDULING_MARGIN_SECONDS

export function validatePolicy(input: unknown): Policy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid policy')
  const raw = input as Record<string, unknown>
  if (Object.keys(raw).some(k => !Object.prototype.hasOwnProperty.call(DEFAULT_POLICY,k))) throw new Error('Unknown policy field')
  const p = { ...DEFAULT_POLICY, ...raw } as Policy
  for (const key of Object.keys(DEFAULT_POLICY) as (keyof Policy)[]) {
    if (typeof p[key] !== typeof DEFAULT_POLICY[key]) throw new Error(`Invalid ${key}`)
    if (typeof p[key] === 'number' && (!Number.isFinite(p[key]) || Number(p[key]) < 0 || Number(p[key]) > 100000)) throw new Error(`Invalid ${key}`)
  }
  if (!['opportunity', 'diamond', 'physical'].includes(p.objective) || !['existing', 'prefer', 'whitelist'].includes(p.membership)) throw new Error('Invalid strategy')
  if (p.sessionMin < 1 || p.sessionMax > 240 || p.sessionMin > p.sessionMax || p.breakMin < 1 || p.breakMin > p.breakMax) throw new Error('Invalid work/rest interval')
  if (p.navigationMinSeconds < 15 || p.navigationMinSeconds > p.navigationMaxSeconds || p.navigationMaxSeconds > 600) throw new Error('Invalid navigation interval')
  if (p.explorationRatio > 1 || p.reinvestRatio > 1 || p.maxRounds < 1 || p.maxStayMinutes < 1 || p.nextRoundWaitSeconds < 5) throw new Error('Invalid policy limits')
  for (const k of ['dailyNewClubs', 'newRoomsPerHour', 'navigationsPerHour', 'actionsPerMinute', 'maxRounds'] as const) if (!Number.isInteger(p[k])) throw new Error(`Invalid ${k}`)
  if (![p.allowedStart, p.allowedEnd].every(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new Error('Invalid allowed hours')
  new Intl.DateTimeFormat('en', { timeZone: p.timezone }).format(0)
  return p
}

export type Membership = 'unknown' | 'not-joined' | 'satisfied' | 'needs-payment'
export interface Opportunity {
  lotteryId: string
  drawAt: number | null
  source: 'network' | 'visible-dom' | 'unknown'
  observedAt: number
  confidence: 'exact' | 'estimated' | 'unknown'
  prizeType: 'all' | 'physical' | 'diamond' | 'coupon'
  winnerCount: number | null
  participantCount: number | null
  totalDiamonds: number | null
  diamondPerWinner: number | null
  cost: number | null
  membership: Membership
  requiresFollow: boolean
  requiresComment: boolean
  requiresShare: boolean
  commentText: string
  watchSeconds: number | null
  unsupported: string[]
  tasksKnown: boolean
  memberKnown?: boolean | null
  /** Highest explicit fan level in the current conditions; null means unparsed. */
  fanLevelRequired?: number | null
}
export interface RoomProfile {
  url: string
  name: string
  favorite: boolean
  blocked: boolean
  allowPaid: boolean
  source: string
  lastSeenAt: number
  nextEligibleCheckAt: number
  membership: Membership
  membershipAt: number
  everPaid: boolean
  memberKnown?: boolean | null
  visits: { at: number; found: boolean }[]
  observations: { at: number; lotteryId: string; drawAt: number; participants: number | null }[]
  failures: number
}
export interface RoundRecord {
  key: string
  lotteryId: string
  roomUrl: string
  createdAt: number
  drawAt: number | null
  submittedAt: number | null
  confirmedAt: number | null
  result: 'pending' | 'won' | 'lost' | 'unknown' | 'cancelled'
  prizeType: 'physical' | 'diamond' | 'coupon' | 'unknown' | null
  diamondAmount: number | null
  prizeName?: string | null
  prizeQuantity?: number | null
  prizeUnit?: string | null
  updatedAt: number
  taskSeconds: number | null
  claimDueAt: number | null
  claimed: boolean
  actions?: Partial<Record<'comment' | 'follow', { at: number; command?: string }>>
}
export interface Payment {
  id: string
  roundKey: string
  roomUrl: string
  cost: number
  newClub: boolean
  at: number
  confirmedAt?: number
  state: 'reserved' | 'submitted' | 'confirmed' | 'failed' | 'unresolved'
}
export type SessionPhase = 'stopped' | 'running' | 'draining' | 'resting' | 'resume-check' | 'blocked'
export interface SessionRecord {
  phase: SessionPhase
  startedAt: number | null
  drainAt: number | null
  hardStopAt: number | null
  nextResumeAt: number | null
  stopAt: number | null
  reason: string
  activeByDay: Record<string, number>
  lastTickAt: number | null
  seed: number
  policy: Policy
}
export interface RiskRecord { at: number; reason: string; source: string; resolvedAt: number | null }
export interface DecisionRecord { at: number; url: string; action: string; reason: string; score: number | null; probability: number | null; seed?: number; snapshot?: {version:2;opportunity:Opportunity;leadSeconds:number;utility:number;mode:string;sampleCount:number} }
export interface AccountData {
  openingSpent: number
  legacyStats: Record<string, unknown>
  rooms: Record<string, RoomProfile>
  rounds: Record<string, RoundRecord>
  payments: Record<string, Payment>
  risks: RiskRecord[]
  decisions: DecisionRecord[]
  navigations: { at: number; url: string; fresh: boolean }[]
  actions: number[]
  session: SessionRecord
  statsSince: number
}
export interface RuntimeData { version: 2; activeAccount: string | null; legacyAssigned: boolean; accounts: Record<string, AccountData> }

export function emptySession(): SessionRecord {
  return { phase: 'stopped', startedAt: null, drainAt: null, hardStopAt: null, nextResumeAt: null,
    stopAt: null, reason: '', activeByDay: {}, lastTickAt: null, seed: 0, policy: { ...DEFAULT_POLICY } }
}
export function normalizeRoomUrl(value: string): string {
  const url = new URL(value)
  const key = url.pathname.split('/').filter(Boolean)
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'live.douyin.com' || key.length !== 1 || !/^[A-Za-z0-9_-]{5,}$/.test(key[0]) || /^[a-z_]+$/i.test(key[0]) || /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(key[0])) throw new Error('请输入有效的抖音直播间地址')
  return `https://live.douyin.com/${key[0]}`
}
// Startup discovery freshness, not a platform safety threshold.
export const HISTORY_STARTUP_FRESHNESS_MS = 30 * 60 * 1000
