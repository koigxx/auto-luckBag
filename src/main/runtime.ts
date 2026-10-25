import Store from 'electron-store'
import fs from 'fs'
import { RuntimeData, validatePolicy } from '../shared/policy'
import { RuntimeRepository, emptyRuntime, allowedNow, dayKey } from './runtime-repository'
import { SessionEngine } from './session-engine'
import { ExecutionGate, checkSignal, delay, navigationQuotaReadyAt, navigationSpacingReadyAt, isDiscoveryUrl } from './execution-gate'
import { store } from './store'
import { defaults } from '../shared/config'
import { validateConfigPatch } from '../shared/config-validation'

// Keep the original store intact, and save a one-time migration snapshot before binding legacy data.
const disk = new Store<{ data: RuntimeData }>({ name: 'runtime-v2', defaults: { data: emptyRuntime() } })
const backupPath = `${store.path}.before-runtime-v2.bak`
if (!fs.existsSync(backupPath) && fs.existsSync(store.path)) fs.copyFileSync(store.path, backupPath)
for (const key of [
  'language',
  'fudaiTypes',
  'diamondBudget',
  'allowDiamondProfit',
  'debugLogs',
  'scanIntervalSeconds',
  'enterBeforeSeconds',
  'candidatePoolLimit',
  'policy'
] as const) {
  try {
    const validated = validateConfigPatch({ [key]: store.get(key) })
    store.set(key, (validated as any)[key])
  } catch {
    store.set(key, (key === 'diamondBudget' ? 0 : defaults[key]) as any)
  }
}
if (!Number.isFinite(store.get('diamondUsed')) || store.get('diamondUsed') < 0) {
  store.set('diamondBudget', 0)
  store.set('diamondUsed', 0)
}
export const repository = new RuntimeRepository({
  read: () => disk.get('data'),
  write: (data) => disk.set('data', data)
})
repository.recover()
export const sessionEngine = new SessionEngine(repository, Math.random, () => performance.now())
export const execution = new ExecutionGate()
let executionLog: (message: string) => void = () => {}
export function setExecutionLogger(logger: (message: string) => void): void { executionLog = logger }
export const policy = () => validatePolicy(store.get('policy'))
const stopListeners = new Set<() => Promise<void>>()
export function onHalt(listener: () => Promise<void>): void {
  stopListeners.add(listener)
}
export async function haltPages(): Promise<void> {
  execution.stop()
  await Promise.allSettled([...stopListeners].map((fn) => fn()))
}
export function reportRisk(reason: string, source: string, url?: string): void {
  if (!repository.read().activeAccount) return
  repository.risk(reason, source, url)
  execution.stop()
  void haltPages()
}
export function assertActive(signal: AbortSignal, newWork = false): void {
  checkSignal(signal)
  if (execution.signal !== signal) throw new Error('旧运行批次已取消')
  const a = repository.account(),
    s = a.session,
    now = Date.now()
  if (
    a.risks.some((r) => r.resolvedAt === null) ||
    !['running', 'draining'].includes(s.phase) ||
    now >= (s.hardStopAt || 0) ||
    (s.stopAt !== null && now >= s.stopAt) ||
    !allowedNow(now, s.policy) ||
    (a.session.activeByDay[dayKey(now, s.policy.timezone)] || 0) >= s.policy.dailyMinutes * 60_000 ||
    (newWork && (s.phase !== 'running' || now >= (s.drainAt || 0)))
  )
    throw new Error('当前运行状态不允许此操作')
}
export async function perform<T>(
  signal: AbortSignal,
  task: () => Promise<T>,
  navigation?: { url: string; fresh: boolean }
): Promise<T> {
  return execution.run(signal, task, async () => {
    assertActive(signal, !!navigation)
    const p = repository.account().session.policy
    if (navigation) {
      const a = repository.account(),
        now = Date.now()
      if (navigationQuotaReadyAt(a.navigations, p, now, navigation.fresh) > now)
        throw new Error('导航或新房探索小时额度已达上限')
      // Draw the spacing once, not on each polling tick. Every source shares this queue.
      const spacing =
        (p.navigationMinSeconds + Math.random() * (p.navigationMaxSeconds - p.navigationMinSeconds)) * 1000
      const readyAt = navigationSpacingReadyAt(a.navigations, navigation.url, spacing, now)
      if (readyAt - now >= 1000) executionLog(
        `${isDiscoveryUrl(navigation.url) ? '首页扫描' : '直播间导航'}等待间隔约 ${Math.ceil((readyAt - now) / 1000)} 秒，预计 ${new Date(readyAt).toLocaleTimeString('zh-CN', {timeZone:p.timezone,hour12:false})} 继续；当前保存的导航间隔 ${p.navigationMinSeconds}–${p.navigationMaxSeconds} 秒，重启不清除最近访问记录`
      )
      await delay(readyAt - now, signal)
      assertActive(signal, true)
      repository.change((a) => {
        a.navigations = [
          ...a.navigations.filter((n) => n.at > Date.now() - 86400_000),
          { ...navigation, at: Date.now() }
        ]
      })
    } else {
      await delay(350 + Math.random() * 650, signal)
      assertActive(signal)
      const recent = repository.account().actions.filter((at) => at > Date.now() - 60000)
      if (recent.length >= p.actionsPerMinute) throw new Error('本分钟操作额度已达上限')
      repository.change((a) => {
        a.actions = [...recent, Date.now()]
      })
    }
  })
}
export function currentBudget() {
  return repository.budget(store.get('diamondBudget'), store.get('allowDiamondProfit'), policy())
}
export function paymentReason(url: string, cost: number | null) {
  return repository.canPay(url, cost, store.get('diamondBudget'), store.get('allowDiamondProfit'), policy())
}
