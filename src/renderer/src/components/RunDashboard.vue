<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AppConfig, AutoRunState, RoomInfo, RunStats, Stats } from '../types'
import type { Insights } from '../../../shared/insights'
import UiIcon from './UiIcon.vue'
import OutcomeBar from './OutcomeBar.vue'
import RoomStageTimeline from './RoomStageTimeline.vue'
import { roomDisplayName } from '../../../shared/record-presentation'
import { waitingForScheduledStop } from '../../../shared/run-presentation'
import { returnProgress } from '../../../shared/display-progress'
const props = defineProps<{
  config: AppConfig
  loggedIn: boolean
  authState?: import('../../../shared/auth').AuthState
  state: AutoRunState | null
  rooms: RoomInfo[]
  stats: Stats | null
  totals: RunStats | null
  insights: Insights | null
  busy: Record<string, boolean>
  dirty: boolean
}>()
const emit = defineEmits<{
  start: [options: { sourceUrl?: string; stopAfterMinutes?: number }]
  finish: []
  skip:[url:string,id:string,today:boolean]
  stop: []
  login: []
  checkLogin: []
  settings: []
  records: []
  add: []
  remove: [id: string]
}>()
const tr = (zh: string, en: string) => (props.config.language === 'en-US' ? en : zh)
const sourceUrl = ref('https://live.douyin.com')
const stopAfter = ref<number | ''>('')
const phase = computed(() => props.state?.status || 'stopped')
const timedWaiting = computed(() => !!props.state?.session && waitingForScheduledStop(props.state.session))
const candidateName = (candidate: {name:string;url:string}) => roomDisplayName(candidate.name,candidate.url,props.config.language==='en-US')
const active = computed(() => !!props.state?.running)
const strategyOpen = ref(false)
watch(active, () => { strategyOpen.value = false })
const report = computed(() => active.value
  ? props.insights?.reports?.find(r => r.endedAt === null)
  : props.insights?.reports?.[0])
const dailyUse = computed(() => Math.min(100, Math.max(0, (props.insights?.metrics.activeMinutes ?? 0) / props.config.policy.dailyMinutes * 100)))
function roomCountdown(room: RoomInfo) {
  const t = room.timeline
  if(t?.stage==='next')return {label:tr('续轮观察剩余','Next-round observation'),seconds:t.remainingSeconds}
  if(t?.stage==='prepare' && t.endsAt!==null)return {label:tr('距离执行任务','Tasks begin in'),seconds:t.remainingSeconds}
  if(t?.stage==='draw' && room.remainingSeconds===0)return {label:tr('结果核对剩余','Result check remaining'),seconds:t.remainingSeconds}
  return {label:tr('距离开奖','Draw in'),seconds:room.remainingSeconds}
}
const held = computed(
  () => phase.value === 'blocked' || !!props.insights?.payments.some((p) => p.state === 'unresolved')
)
const labels = computed(() => ({
  running: tr('正在运行', 'Running'),
  draining: tr('正在收尾', 'Finishing up'),
  resting: timedWaiting.value ? tr('等待定时结束','Waiting for scheduled stop') : tr('计划休息中', 'On a planned break'),
  'resume-check': tr('检查恢复条件', 'Checking before resume'),
  blocked: tr('需要你处理', 'Needs your attention'),
  stopped: tr('已停止', 'Stopped')
}))
const status = computed(() => labels.value[phase.value as keyof typeof labels.value] || phase.value)
const title = computed(() =>
  props.authState === 'checking' ? tr('正在后台校验登录', 'Verifying your saved session')
    : props.authState === 'unknown' ? tr('暂时无法验证登录状态', 'Unable to verify your session')
    : props.authState === 'expired' ? tr('登录已失效，请重新登录', 'Session expired. Please sign in')
    : !props.loggedIn
    ? tr('先连接你的抖音账号', 'Connect your Douyin account')
    : held.value
      ? tr('处理待办后，再继续', 'Review before continuing')
      : active.value
        ? status.value
        : tr('准备好，开始下一轮', 'Ready for your next session')
)
const description = computed(() =>
  props.authState === 'checking' ? tr('正在复用保存的会话，不会打开登录窗口。', 'Checking your saved session without opening a login window.')
    : props.authState === 'unknown' ? tr('已保留原登录信息。网络异常或页面未返回明确结果，请稍后重试。', 'Your session is retained. Check your connection and retry.')
    : !props.loggedIn
    ? tr(
        '完成登录后，按已保存的策略自动发现和参与福袋。',
        'Sign in to discover and join lucky bags with your saved strategy.'
      )
    : held.value
      ? tr(
          '有风险提示或未决支付。前往运行记录核对，处理后手动启动。',
          'A risk hold or unresolved payment needs review in Records before a manual restart.'
        )
      : timedWaiting.value ? tr('本轮已完成，等待定时结束','This round is complete; waiting for the scheduled stop') : props.state?.session?.reason ||
        props.state?.waitingReason ||
        (active.value
          ? tr(
              '按计划逐个验证直播间，满足条件时参与。',
              'Rooms are verified one at a time and joined when eligible.'
            )
          : tr(
              '历史房间优先复访，符合条件时在同一直播间继续参与。',
              'Revisit known rooms first and stay for another round when eligible.'
            ))
)
const typeText = computed(() =>
  props.config.fudaiTypes.all
    ? tr('全部福袋', 'All lucky bags')
    : [
        props.config.fudaiTypes.physical ? tr('实物', 'Physical') : '',
        props.config.fudaiTypes.diamond ? tr('钻石', 'Diamonds') : ''
      ]
        .filter(Boolean)
        .join(' + ') || tr('未选择类型', 'No prize type selected')
)
const membership = computed(
  () =>
    ({
      existing: tr('仅使用已有资格', 'Existing eligibility only'),
      prefer: tr('优先复用已有资格', 'Reuse eligibility first'),
      whitelist: tr('仅许可主播可付费', 'Permitted hosts only')
    })[props.config.policy.membership]
)
const budget = computed(() => props.insights?.budget)
const usage = computed(() =>
  budget.value?.effective
    ? Math.min(100, ((budget.value.spent + budget.value.reserved) / budget.value.effective) * 100)
    : 0
)
const time = (value: number | null | undefined) =>
  value
    ? new Date(value).toLocaleTimeString(props.config.language, { hour: '2-digit', minute: '2-digit' })
    : '—'
const scheduleTime = (value: number | null | undefined) => value == null ? '—' :
  new Date(value).toLocaleTimeString(props.config.language, {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})
const duration = (value: number | null | undefined) =>
  value == null ? '—' : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
function start() {
  emit('start', {
    sourceUrl: sourceUrl.value.trim(),
    stopAfterMinutes: stopAfter.value === '' ? undefined : Number(stopAfter.value)
  })
}
</script>

<template>
  <div class="dashboard-view">
    <section v-if="active" class="live-control surface" :aria-label="tr('运行控制', 'Run controls')">
      <div class="live-control-main">
        <span class="live-beacon" :class="{resting: phase === 'resting'}"><UiIcon :name="phase === 'resting' ? 'pause' : 'play'" /></span>
        <div class="live-control-copy"><h2>{{ title }}</h2><p>{{ description }}</p></div>
        <div class="control-deadline"><span>{{ timedWaiting ? tr('定时结束','Scheduled stop') : phase === 'resting' ? tr('距离恢复','Resume in') : tr('本段截止','Session ends') }}</span><strong>{{ timedWaiting ? time(state?.session?.stopAt) : phase === 'resting' ? duration(state?.resumeRemainingSeconds) : time(state?.session?.hardStopAt) }}</strong></div>
      </div>
      <div class="live-control-actions">
        <button class="button small" :aria-expanded="strategyOpen" aria-controls="run-plan" @click="strategyOpen = !strategyOpen"><UiIcon name="settings" :size="16" />{{ strategyOpen ? tr('收起策略','Hide strategy') : tr('查看策略','View strategy') }}</button>
        <button class="button small" :disabled="busy.finish || state?.session?.finishRequested || busy.stop" @click="emit('finish')">{{ state?.session?.finishRequested ? tr('正在等待本轮结束','Finishing current round') : tr('本轮结束后停止','Stop after this round') }}</button>
        <button class="button stop small" :disabled="busy.stop" @click="emit('stop')"><UiIcon name="stop" :size="16" />{{ busy.stop ? tr('正在停止…','Stopping…') : tr('立即停止','Stop now') }}</button>
      </div>
    </section>
    <div v-show="!active || strategyOpen" id="run-plan" class="overview-grid" :class="{'compact-plan': active}">
      <section v-if="!active"
        class="run-stage"
        :class="{ 'is-active': active, 'needs-attention': held }"
        aria-labelledby="run-title"
      >
        <div class="stage-top">
          <span
            class="status-pill"
            :class="{
              success: active && phase !== 'resting',
              warning: held,
              neutral: !active || phase === 'resting'
            }"
            ><span class="status-dot" />{{ loggedIn ? status : tr('账号未连接', 'Not connected') }}</span
          ><span class="subtle">{{ tr('自动运行', 'Automatic run') }}</span>
        </div>
        <h2 id="run-title">{{ title }}</h2>
        <p class="stage-description">{{ description }}</p>
        <div class="stage-actions">
          <button v-if="authState === 'checking' || authState === 'unknown'" class="button primary large" :disabled="authState === 'checking'" @click="emit('checkLogin')">
            {{ authState === 'checking' ? tr('校验中…', 'Checking…') : tr('重新校验', 'Retry verification') }}
          </button>
          <button v-else-if="!loggedIn" class="button primary large" :disabled="busy.login" @click="emit('login')">
            <UiIcon name="user" />{{
              busy.login ? tr('等待完成登录…', 'Waiting for sign-in…') : tr('登录抖音', 'Sign in to Douyin')
            }}
          </button>
          <button v-else-if="held" class="button primary large" @click="emit('records')">
            <UiIcon name="alert" />{{ tr('查看待处理事项', 'Review pending items') }}
          </button>
          <button
            v-else
            class="button primary large"
            :disabled="
              busy.start ||
              busy.save ||
              busy.addRoom ||
              dirty ||
              (!config.fudaiTypes.all && !config.fudaiTypes.physical && !config.fudaiTypes.diamond)
            "
            @click="start"
          >
            <UiIcon name="play" />{{
              busy.start ? tr('正在启动…', 'Starting…') : tr('开始运行', 'Start run')
            }}
          </button>
          <button class="button text-button" @click="emit('settings')">
            {{ dirty ? tr('有未保存的设置', 'Unsaved settings') : tr('调整策略', 'Edit strategy')
            }}<UiIcon name="chevron" :size="16" />
          </button>
        </div>
        <details v-if="!active && !held" class="run-options">
          <summary>{{ tr('本次运行选项', 'Options for this run') }}</summary>
          <div class="form-grid compact">
            <label class="field-label"
              >{{ tr('发现入口', 'Discovery page')
              }}<select v-model="sourceUrl">
                <option value="https://live.douyin.com">{{ tr('直播首页', 'Live home') }}</option>
                <option value="https://live.douyin.com/follow">{{ tr('关注页', 'Following') }}</option>
                <option value="https://live.douyin.com/category">{{ tr('分类页', 'Categories') }}</option>
              </select></label
            >
            <label class="field-label"
              >{{ tr('定时停止（分钟）', 'Stop after (minutes)')
              }}<input
                v-model="stopAfter"
                type="number"
                min="1"
                max="1440"
                step="1"
                :placeholder="tr('按运行计划执行', 'Use the session plan')"
            /></label>
          </div>
        </details>
      </section>
      <aside class="plan-summary surface" aria-label="本次计划">
        <div class="section-heading">
          <h2>{{ tr('当前策略', 'Current strategy') }}</h2>
          <button class="inline-link" @click="emit('settings')">{{ tr('调整策略', 'Edit strategy') }}</button>
        </div>
        <dl class="summary-list">
          <div>
            <dt>{{ tr('参与类型', 'Prizes') }}</dt>
            <dd>{{ typeText }}</dd>
          </div>
          <div>
            <dt>{{ tr('粉丝团', 'Membership') }}</dt>
            <dd>{{ membership }}</dd>
          </div>
          <div>
            <dt>{{ tr('运行 / 休息', 'Run / break') }}</dt>
            <dd>
              {{ config.policy.sessionMin }}–{{ config.policy.sessionMax }} / {{ config.policy.breakMin }}–{{
                config.policy.breakMax
              }}
              {{ tr('分钟', 'min') }}
            </dd>
          </div>
          <div>
            <dt>{{ tr('每日运行上限', 'Daily active limit') }}</dt>
            <dd>{{ config.policy.dailyMinutes }} {{ tr('分钟', 'min') }}</dd>
          </div>
        </dl>
        <p class="microcopy">{{ tr(`任务准备 ${config.enterBeforeSeconds} 秒；单次最多 ${config.policy.paymentLimit} 钻；今日可用 ${budget?.dailyRemaining ?? '—'} 钻。`, `Task window ${config.enterBeforeSeconds}s; per payment ${config.policy.paymentLimit}; daily remaining ${budget?.dailyRemaining ?? '—'}.`) }}</p>
        <div class="budget-summary">
          <div class="budget-caption">
            <span>{{ tr('剩余钻石预算', 'Diamond budget left') }}</span
            ><strong
              >{{ loggedIn ? (budget?.remaining ?? stats?.diamondRemaining ?? '—') : '—'
              }}<small> / {{ budget?.effective ?? config.diamondBudget }}</small></strong
            >
          </div>
          <div
            class="budget-track"
            role="meter"
            :aria-label="tr('预算已占用比例', 'Budget allocated')"
            :aria-valuenow="usage"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span :style="{ width: `${usage}%` }" />
          </div>
          <p class="microcopy">
            {{
              loggedIn
                ? tr(
                    `已用 ${budget?.spent ?? 0} 钻，预留 ${budget?.reserved ?? 0} 钻`,
                    `${budget?.spent ?? 0} spent, ${budget?.reserved ?? 0} reserved`
                  )
                : tr('登录后读取账号账本', 'Connect to load your account ledger')
            }}
          </p>
        </div>
      </aside>
    </div>
    <section class="run-monitor surface" :aria-label="tr('运行数据', 'Run data')">
      <div class="monitor-heading"><h2>{{ active ? tr('本次运行','This run') : tr('最近一次运行','Latest run') }}</h2><span>{{ report ? tr(`活跃 ${(report.activeMs / 60000).toFixed(1)} 分钟`, `${(report.activeMs / 60000).toFixed(1)} active min`) : tr('启动后生成独立运行数据','An independent report starts with each run') }}</span><button class="inline-link" @click="emit('records')">{{ tr('查看运行记录','View records') }}<UiIcon name="chevron" :size="14" /></button></div>
      <div class="run-numbers">
        <div><span><UiIcon name="check" :size="16" />{{ tr('确认参与','Confirmed entries') }}</span><strong>{{ report?.confirmed ?? '—' }}</strong><small>{{ tr('已收到本人参与反馈','Personal participation acknowledged') }}</small></div>
        <div><span><UiIcon name="gift" :size="16" />{{ tr('中奖轮次','Winning rounds') }}</span><strong>{{ report?.won ?? '—' }}</strong><small>{{ tr('仅统计明确开奖结果','Explicit results only') }}</small></div>
        <div><span><UiIcon name="diamond" :size="16" />{{ tr('本次支出','Run spending') }}</span><strong>{{ report?.spent ?? '—' }}<small>{{ tr('钻','diamonds') }}</small></strong><small>{{ tr('待确认占额','Pending allocation') }} {{ report?.reserved ?? '—' }}</small></div>
        <div><span><UiIcon name="clock" :size="16" />{{ tr('已预约 / 待验证','Queued / to verify') }}</span><strong>{{ state?.candidateCount ?? 0 }}<i> / </i>{{ state?.pendingVerifyCount ?? 0 }}</strong><small>{{ tr('按返房时间顺序参与','Join in scheduled return order') }}</small></div>
      </div>
      <OutcomeBar v-if="report" :won="report.won" :lost="report.lost" :unknown="report.unknown" :pending="report.pending" :language="config.language" />
    </section>
    <div class="activity-grid">
      <section class="surface current-rooms">
        <div class="section-heading">
          <h2>
            {{ tr('当前直播间', 'Current room') }}<span class="count-badge">{{ rooms.length }}</span>
          </h2>
          <button
            class="button small"
            :disabled="!loggedIn || active || held || busy.addRoom || dirty"
            @click="emit('add')"
          >
            <UiIcon name="plus" :size="16" />{{ tr('手动参与', 'Join a room') }}
          </button>
        </div>
        <div v-if="!rooms.length" class="empty-state">
          <span class="empty-icon"><UiIcon name="rooms" :size="28" /></span>
          <h3>
            {{
              active
                ? phase === 'running'
                  ? state?.waitingReason || tr('正在寻找合适的直播间', 'Looking for a suitable room')
                  : status
                : tr('还没有正在参与的直播间', 'No room is active yet')
            }}
          </h3>
          <p>
            {{
              active
                ? description
                : tr('开始自动运行，或添加一个直播间进行验证。', 'Start a run or add a room to verify it.')
            }}
          </p>
        </div>
        <article v-for="room in rooms" :key="room.id" class="live-room-card">
          <header><span class="room-avatar"><UiIcon name="rooms" /></span><div class="room-info"><h3>{{ roomDisplayName(room.name,room.url,config.language==='en-US') }}</h3><p>{{ room.hasFanBadge ? tr('当前粉丝资格满足','Membership requirement met') : tr('按本轮任务核对资格','Eligibility follows this round’s requirements') }}</p></div><button class="icon-button" :disabled="busy[`room:${room.id}`]" :aria-label="tr(`结束 ${room.name} 的参与`, `End participation in ${room.name}`)" @click="emit('remove',room.id)"><UiIcon name="close" :size="18" /></button></header>
          <div class="live-room-stage"><span class="status-pill success">{{ room.phase || room.status }}</span><div class="room-countdown"><span>{{roomCountdown(room).label}}</span><strong>{{duration(roomCountdown(room).seconds)}}</strong></div><small v-if="room.timeline?.stage==='prepare' && room.timeline.endsAt!==null" class="stage-draw-note">{{tr('距离开奖','Draw in')}} {{duration(room.remainingSeconds)}}</small></div>
          <RoomStageTimeline :timeline="room.timeline" :phase="room.phase" :language="config.language" />
          <footer><span>{{ tr('本次已结算','Rounds settled') }} <b>{{ room.fudaiCount }}</b> {{ tr('轮','') }}</span><span>{{ tr('结果以本人弹窗为准','Only your result counts') }}</span></footer>
        </article>
        <div class="monitor-resources">
          <div class="resource-heading"><UiIcon name="diamond" :size="17" /><h3>{{ tr('预算与节奏','Budget & pace') }}</h3></div>
          <div class="resource-caption"><span>{{ tr('剩余钻石预算','Diamond budget left') }}</span><strong>{{ loggedIn ? budget?.remaining ?? '—' : '—' }}<small> / {{ budget?.effective ?? config.diamondBudget }}</small></strong></div>
          <div class="resource-meter" role="meter" :aria-label="tr('预算已占用比例','Budget allocated')" :aria-valuenow="usage" aria-valuemin="0" aria-valuemax="100"><span class="spent" :style="{width: `${Math.min(usage, (budget?.spent ?? 0) / (budget?.effective || 1) * 100)}%`}"/><span class="reserved" :style="{width: `${Math.max(0, usage - (budget?.spent ?? 0) / (budget?.effective || 1) * 100)}%`}"/></div>
          <p class="resource-note">{{ tr(`已用 ${budget?.spent ?? 0} 钻，预留 ${budget?.reserved ?? 0} 钻`, `${budget?.spent ?? 0} spent, ${budget?.reserved ?? 0} reserved`) }}</p>
          <div class="resource-caption"><span>{{ tr('今日活跃','Active today') }}</span><strong>{{ insights?.metrics.activeMinutes.toFixed(1) ?? '—' }}<small> / {{ config.policy.dailyMinutes }} {{ tr('分钟','min') }}</small></strong></div>
          <div class="resource-meter" role="meter" :aria-label="tr('今日活跃额度使用比例','Daily active allowance used')" :aria-valuenow="dailyUse" aria-valuemin="0" aria-valuemax="100"><span class="daily" :style="{width: `${dailyUse}%`}" /></div>
          <p class="resource-note">{{ tr(`运行 ${config.policy.sessionMin}–${config.policy.sessionMax} 分钟后，按计划休息。`, `Planned breaks follow ${config.policy.sessionMin}–${config.policy.sessionMax} active minutes.`) }}</p>
        </div>
      </section>
      <section class="surface candidates">
        <div class="section-heading">
          <h2>
            {{ tr('候选队列', 'Candidate queue')
            }}<span class="count-badge">{{ state?.candidateCount ?? 0 }}</span>
          </h2>
          <span class="subtle">{{ tr('按计划进房', 'Scheduled entry') }}</span>
        </div>
        <div v-if="!state?.candidates?.length" class="empty-state compact-empty">
          <span class="empty-icon"><UiIcon name="clock" :size="26" /></span>
          <h3>{{ tr('等待验证通过的候选', 'Waiting for verified rooms') }}</h3>
          <p>
            {{
              tr(
                '可靠倒计时和任务条件齐全后进入队列。',
                'Rooms appear once timing and eligibility are confirmed.'
              )
            }}
          </p>
        </div>
        <ol v-if="state?.candidates?.length" class="reservation-list">
          <li v-for="(candidate,index) in state.candidates" :key="`${candidate.url}:${candidate.lotteryId}`" class="reservation" :class="{'is-next': index===0}">
            <div class="reservation-heading"><span class="queue-position">{{ index+1 }}</span><h3>{{ candidateName(candidate) }}</h3><span class="cost-tag" :class="{free:candidate.cost===0}">{{ candidate.cost === 0 ? tr('零新增费用','No new cost') : candidate.cost == null ? tr('费用待核对','Cost unknown') : tr(`预计 ${candidate.cost} 钻`, `Est. ${candidate.cost} diamonds`) }}</span></div>
            <div class="reservation-countdown"><span>{{ index===0 ? tr('下一项返房','Next return') : tr('返房倒计时','Return in') }}</span><strong>{{ duration(candidate.entryRemainingSeconds) }}</strong><span class="draw-remaining">{{ tr('距开奖','Draw in') }} <b>{{ duration(candidate.remainingSeconds) }}</b></span></div>
            <div v-if="returnProgress(candidate) !== null" class="return-progress" role="progressbar" :aria-label="tr(`${candidateName(candidate)} 距离返房进度`, `${candidateName(candidate)} return progress`)" :aria-valuenow="returnProgress(candidate)!" aria-valuemin="0" aria-valuemax="100"><span :style="{width: `${returnProgress(candidate)}%`}" /></div>
            <div class="reservation-timeline" :aria-label="tr('预约时间安排','Reservation schedule')">
              <div><span>{{ tr('返房复验','Return check') }}</span><time>{{ scheduleTime(candidate.startAt) }}</time></div><div><span>{{ tr('任务准备','Task window') }}</span><time>{{ scheduleTime(candidate.taskAt) }}</time></div><div><span>{{ tr('开奖','Draw') }}</span><time>{{ scheduleTime(candidate.drawAt) }}</time></div>
            </div>
            <details class="reservation-details"><summary>{{ tr('预约依据与操作','Details & actions') }}<UiIcon name="down" :size="14" /></summary><div><p>{{ candidate.reason || tr('按可完成性与时间安排','Scheduled by feasibility and timing') }}</p><p>{{ candidate.probability == null ? tr('概率未知；返房后重新核对资格和费用。','Odds unknown. Eligibility and cost are rechecked on return.') : tr(`等概率假设下估计机会 ${(candidate.probability*100).toFixed(2)}%；返房仍需复验。`, `Estimated chance ${(candidate.probability*100).toFixed(2)}% assuming equal odds; return checks still apply.`) }}</p><p class="room-address">{{ candidate.url }}</p><div class="button-row"><button class="button small" :disabled="!candidate.lotteryId || busy[`candidate:${candidate.url}`]" @click="emit('skip',candidate.url,candidate.lotteryId!,false)">{{ tr('移除本轮','Skip this round') }}</button><button class="button text-button small" :disabled="!candidate.lotteryId || busy[`candidate:${candidate.url}`]" @click="emit('skip',candidate.url,candidate.lotteryId!,true)">{{ tr('今天跳过','Skip today') }}</button></div></div></details>
          </li>
        </ol>
      </section>
    </div>
    <details class="lifetime-summary"><summary>{{ tr('累计展示统计','Display totals') }}<span>{{ tr('跨运行统计，与本次运行分开','Across runs, separate from this run') }}</span></summary>
    <section class="metrics-strip" :aria-label="tr('累计展示统计', 'Display totals')">
      <div>
        <span>{{ tr('已确认参与', 'Confirmed entries') }}</span
        ><strong>{{ totals?.participated ?? 0 }}</strong
        ><small>{{ tr('已收到参与反馈', 'Participation acknowledged') }}</small>
      </div>
      <div>
        <span>{{ tr('实物中奖', 'Physical wins') }}</span
        ><strong>{{ totals?.physicalWins ?? 0 }}</strong
        ><small>{{ tr('仅统计本人结果', 'Your results only') }}</small>
      </div>
      <div>
        <span>{{ tr('获得钻石', 'Diamonds won') }}</span
        ><strong>{{ totals?.diamondWonAmount ?? 0 }}</strong
        ><small>{{ totals?.diamondWins ?? 0 }} {{ tr('次钻石中奖', 'diamond wins') }}</small>
      </div>
      <div>
        <span>{{ tr('待确认 / 结果未知', 'Unconfirmed / unknown') }}</span
        ><strong>{{ totals?.submittedUnknown ?? 0 }}<i> / </i>{{ totals?.unknownResults ?? 0 }}</strong
        ><button class="inline-link" @click="emit('records')">
          {{ tr('查看运行记录', 'View records') }}
        </button>
      </div>
    </section>
    </details>
  </div>
</template>
