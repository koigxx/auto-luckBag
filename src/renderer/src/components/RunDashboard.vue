<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AppConfig, AutoRunState, RoomInfo, RunStats, Stats } from '../types'
import type { Insights } from '../../../shared/insights'
import UiIcon from './UiIcon.vue'
const props = defineProps<{
  config: AppConfig
  loggedIn: boolean
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
  stop: []
  login: []
  settings: []
  records: []
  add: []
  remove: [id: string]
}>()
const tr = (zh: string, en: string) => (props.config.language === 'en-US' ? en : zh)
const sourceUrl = ref('https://live.douyin.com')
const stopAfter = ref<number | ''>('')
const phase = computed(() => props.state?.status || 'stopped')
const active = computed(() => !!props.state?.running)
const held = computed(
  () => phase.value === 'blocked' || !!props.insights?.payments.some((p) => p.state === 'unresolved')
)
const labels = computed(() => ({
  running: tr('正在运行', 'Running'),
  draining: tr('正在收尾', 'Finishing up'),
  resting: tr('计划休息中', 'On a planned break'),
  'resume-check': tr('检查恢复条件', 'Checking before resume'),
  blocked: tr('需要你处理', 'Needs your attention'),
  stopped: tr('已停止', 'Stopped')
}))
const status = computed(() => labels.value[phase.value as keyof typeof labels.value] || phase.value)
const title = computed(() =>
  !props.loggedIn
    ? tr('先连接你的抖音账号', 'Connect your Douyin account')
    : held.value
      ? tr('处理待办后，再继续', 'Review before continuing')
      : active.value
        ? status.value
        : tr('准备好，开始下一轮', 'Ready for your next session')
)
const description = computed(() =>
  !props.loggedIn
    ? tr(
        '完成登录后，按已保存的策略自动发现和参与福袋。',
        'Sign in to discover and join lucky bags with your saved strategy.'
      )
    : held.value
      ? tr(
          '有风险提示或未决支付。前往运行记录核对，处理后手动启动。',
          'A risk hold or unresolved payment needs review in Records before a manual restart.'
        )
      : props.state?.session?.reason ||
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
    <div class="overview-grid">
      <section
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
        <div v-if="active" class="session-times">
          <div>
            <span>{{
              phase === 'resting' ? tr('距离恢复', 'Resume in') : tr('本段截止', 'Session ends')
            }}</span
            ><strong>{{
              phase === 'resting' ? duration(state?.resumeRemainingSeconds) : time(state?.session?.hardStopAt)
            }}</strong>
          </div>
          <div>
            <span>{{ tr('候选房间', 'Candidates') }}</span
            ><strong>{{ state?.candidateCount ?? 0 }}</strong>
          </div>
          <div>
            <span>{{ tr('等待验证', 'To verify') }}</span
            ><strong>{{ state?.pendingVerifyCount ?? 0 }}</strong>
          </div>
        </div>
        <div class="stage-actions">
          <button v-if="!loggedIn" class="button primary large" :disabled="busy.login" @click="emit('login')">
            <UiIcon name="user" />{{
              busy.login ? tr('等待完成登录…', 'Waiting for sign-in…') : tr('登录抖音', 'Sign in to Douyin')
            }}
          </button>
          <button v-else-if="active" class="button stop large" :disabled="busy.stop" @click="emit('stop')">
            <UiIcon name="stop" />{{ busy.stop ? tr('正在停止…', 'Stopping…') : tr('停止运行', 'Stop run') }}
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
          <UiIcon name="settings" :size="18" />
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
                ? tr('正在寻找合适的直播间', 'Looking for a suitable room')
                : tr('还没有正在参与的直播间', 'No room is active yet')
            }}
          </h3>
          <p>
            {{
              active
                ? tr(
                    '候选会逐个验证，满足条件后自动进房。',
                    'Candidates are checked individually before joining.'
                  )
                : tr('开始自动运行，或添加一个直播间进行验证。', 'Start a run or add a room to verify it.')
            }}
          </p>
        </div>
        <article v-for="room in rooms" :key="room.id" class="active-room">
          <div class="room-avatar"><UiIcon name="rooms" /></div>
          <div class="room-info">
            <h3>{{ room.name }}</h3>
            <p>
              {{ room.phase || room.status
              }}<span v-if="room.hasFanBadge"> · {{ tr('已有粉丝资格', 'Eligible member') }}</span>
            </p>
            <small>{{ tr('本次已结算', 'Rounds settled') }} {{ room.fudaiCount }} {{ tr('轮', '') }}</small>
          </div>
          <div class="draw-clock">
            <span>{{ tr('距离开奖', 'Draw in') }}</span
            ><strong>{{ duration(room.remainingSeconds) }}</strong>
          </div>
          <button
            class="icon-button"
            :disabled="busy[`room:${room.id}`]"
            :aria-label="tr(`结束 ${room.name} 的参与`, `End participation in ${room.name}`)"
            @click="emit('remove', room.id)"
          >
            <UiIcon name="close" :size="18" />
          </button>
        </article>
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
        <div v-for="candidate in state?.candidates || []" :key="candidate.url" class="candidate-item">
          <div>
            <strong>{{ candidate.name }}</strong>
            <p :title="candidate.reason">
              {{
                candidate.probability == null
                  ? tr('概率未知，按可完成性选择', 'Unknown odds; selected by feasibility')
                  : tr(
                      `估计机会 ${(candidate.probability * 100).toFixed(2)}%`,
                      `Estimated chance ${(candidate.probability * 100).toFixed(2)}%`
                    )
              }}
            </p>
          </div>
          <time>{{ duration(candidate.remainingSeconds) }}</time>
        </div>
      </section>
    </div>
  </div>
</template>
