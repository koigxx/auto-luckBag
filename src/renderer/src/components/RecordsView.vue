<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Insights } from '../../../shared/insights'
import type { Payment, RoomProfile } from '../../../shared/policy'
import ReviewSummary from './ReviewSummary.vue'
import UiIcon from './UiIcon.vue'
import UiDialog from './UiDialog.vue'
const props = defineProps<{
  view: 'library' | 'records'
  data: Insights | null
  loggedIn: boolean
  running: boolean
  language: string
  busy: Record<string, boolean>
  onAction: (
    key: string,
    fn: () => Promise<{ success: boolean; error?: string; path?: string }>
  ) => Promise<boolean | null>
  onReset: () => Promise<boolean | null>
}>()
const api = window.api
const emit = defineEmits<{ login: []; add: [] }>()
const tr = (zh: string, en: string) => (props.language === 'en-US' ? en : zh)
const filter = ref('')
const roomFilter = ref('all')
const tab = ref('rounds')
const page = ref(1)
const search=ref(''), dateFrom=ref(''),dateTo=ref(''),resultFilter=ref(''),cycleFilter=ref('')
function matches(r:any):boolean {
  const at=r.createdAt??r.at,day=at?new Date(at).toLocaleDateString('en-CA'):''
  return `${name(r.roomUrl||r.url||'')} ${r.reason||''}`.toLowerCase().includes(search.value.toLowerCase()) &&
    (!dateFrom.value||day>=dateFrom.value)&&(!dateTo.value||day<=dateTo.value)&&
    (!resultFilter.value||(r.result||r.state||r.action)===resultFilter.value)&&
    (!cycleFilter.value||(r.budgetCycle??0)===Number(cycleFilter.value))
}
const filteredRounds=computed(()=>props.data?.rounds.filter(matches)||[])
const filteredPayments=computed(()=>props.data?.payments.filter(matches)||[])
const filteredDecisions=computed(()=>props.data?.decisions.filter(matches)||[])
const confirmation = ref<{
  kind: 'payment' | 'reset'
  payment?: Payment
  state?: 'confirmed' | 'failed'
} | null>(null)
const dialogBusy = ref(false)
const time = (value: number | null | undefined) =>
  value
    ? new Date(value).toLocaleString(props.language, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    : '—'
const name = (url: string) =>
  props.data?.rooms.find((room) => room.url === url)?.name || url || tr('系统', 'System')
const rooms = computed(() =>
  (props.data?.rooms || [])
    .filter(
      (room) =>
        `${room.name} ${room.url}`.toLowerCase().includes(filter.value.toLowerCase()) &&
        (roomFilter.value === 'all' ||
          (roomFilter.value === 'favorite'
            ? room.favorite
            : roomFilter.value === 'blocked'
              ? room.blocked
              : room.allowPaid))
    )
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.lastSeenAt - a.lastSeenAt)
)
const unresolved = computed(
  () => props.data?.payments.filter((payment) => payment.state === 'unresolved') || []
)
const risks = computed(() => props.data?.risks.filter((risk) => risk.resolvedAt === null) || [])
watch(tab,()=>{resultFilter.value='';cycleFilter.value=''})
const rows = computed(
  () =>
    (tab.value === 'rounds'
      ? filteredRounds.value
      : tab.value === 'payments'
        ? filteredPayments.value
        : filteredDecisions.value) || []
)
const total = computed(() => (props.view === 'library' ? rooms.value.length : rows.value.length))
const pages = computed(() => Math.max(1, Math.ceil(total.value / 15)))
const start = computed(() => (page.value - 1) * 15)
const dialogTitle = computed(() =>
  confirmation.value?.kind === 'reset'
    ? tr('重置展示统计', 'Reset display totals')
    : tr('核对这笔支付', 'Reconcile this payment')
)
watch([() => props.view, filter, roomFilter, tab,search,dateFrom,dateTo,resultFilter,cycleFilter], () => {
  page.value = 1
})
watch(pages, (count) => {
  if (page.value > count) page.value = count
})
function label(value: string | null) {
  if(value==='budget-reset')return tr('开始新预算轮次','New budget cycle')
  const map: Record<string, [string, string]> = {
    unknown: ['未知', 'Unknown'],
    pending: ['等待开奖', 'Pending'],
    won: ['中奖', 'Won'],
    lost: ['未中奖', 'Not won'],
    cancelled: ['已取消', 'Cancelled'],
    reserved: ['已预留', 'Reserved'],
    submitted: ['已提交', 'Submitted'],
    confirmed: ['已确认', 'Confirmed'],
    failed: ['未扣款', 'Not charged'],
    unresolved: ['待核对', 'Unresolved'],
    satisfied: ['当前资格满足', 'Currently eligible'],
    'needs-payment': ['需要新增付费', 'Payment required'],
    'not-joined': ['未加入', 'Not joined'],
    physical: ['实物', 'Physical'],
    diamond: ['钻石', 'Diamonds'],
    coupon: ['优惠券', 'Coupon'],
    participate: ['参与', 'Participate'],
    skip: ['跳过', 'Skip'],
    candidate: ['加入候选', 'Queue'],
    takeover: ['当前页参与', 'Join this page'],
    reconcile: ['支付核对', 'Reconcile'],
    discovery: ['入口发现', 'Discovery'],
    legacy: ['历史迁移', 'Migrated']
  }
  return value && map[value] ? tr(...map[value]) : value || '—'
}
async function confirm() {
  const target = confirmation.value
  if (!target || dialogBusy.value) return
  dialogBusy.value = true
  try {
    const success =
      target.kind === 'reset'
        ? await props.onReset()
        : await props.onAction('reconcile', () => api.insights.payment(target.payment!.id, target.state!))
    if (success) confirmation.value = null
  } finally {
    dialogBusy.value = false
  }
}
async function changeRoom(room: RoomProfile, key: 'favorite' | 'blocked' | 'allowPaid', event: Event) {
  const input = event.target as HTMLInputElement
  const requested = input.checked
  input.checked = room[key]
  await props.onAction(`profile:${room.url}`, () => api.insights.room(room.url, { [key]: requested }))
}
</script>

<template>
  <section v-if="!loggedIn" class="surface empty-state page-empty">
    <span class="empty-icon"><UiIcon :name="view === 'library' ? 'rooms' : 'records'" :size="30" /></span>
    <h2>{{ tr('连接账号后查看记录', 'Connect to view your records') }}</h2>
    <p>
      {{
        tr(
          '房间、参与和支出记录按账号分别保存。',
          'Rooms, entries and spending are stored separately for each account.'
        )
      }}
    </p>
    <button class="button primary" :disabled="busy.login" @click="emit('login')">
      {{ busy.login ? tr('等待登录…', 'Waiting for sign-in…') : tr('登录抖音', 'Sign in to Douyin') }}
    </button>
  </section>
  <section v-else-if="!data" class="surface empty-state page-empty">
    <h2>{{ tr('正在读取记录…', 'Loading records…') }}</h2>
  </section>
  <div v-else class="records-view">
    <template v-if="view === 'records'">
      <ReviewSummary :data="data" :busy="busy" :on-action="onAction" />
      <section v-if="unresolved.length || risks.length" class="review-panel" aria-labelledby="review-title">
        <div class="section-heading">
          <h2 id="review-title"><UiIcon name="alert" />{{ tr('需要处理', 'Needs attention') }}</h2>
          <span class="status-pill warning">{{ unresolved.length + risks.length }}</span>
        </div>
        <div v-for="payment in unresolved" :key="payment.id" class="review-row">
          <div>
            <strong>{{ name(payment.roomUrl) }} · {{ payment.cost }} {{ tr('钻', 'diamonds') }}</strong>
            <p>
              {{
                tr(
                  '支付结果尚未明确，请先核对抖音扣款记录。',
                  'Payment is unresolved. Check the actual charge in Douyin first.'
                )
              }}
            </p>
            <small>{{ time(payment.at) }}</small>
          </div>
          <div class="button-row">
            <button
              class="button"
              :disabled="running"
              @click="confirmation = { kind: 'payment', payment, state: 'failed' }"
            >
              {{ tr('核实未扣款', 'Verified not charged') }}</button
            ><button
              class="button"
              :disabled="running"
              @click="confirmation = { kind: 'payment', payment, state: 'confirmed' }"
            >
              {{ tr('核实已扣款', 'Verified charged') }}
            </button>
          </div>
        </div>
        <div v-for="(risk, index) in risks" :key="index" class="review-row">
          <div>
            <strong>{{ risk.reason }}</strong>
            <p>{{ time(risk.at) }} · {{ risk.source }}</p>
          </div>
        </div>
        <div v-if="risks.length" class="review-footer">
          <p>
            {{
              unresolved.length
                ? tr(
                    '先核对未决支付，再解除阻断。',
                    'Reconcile unresolved payments before clearing the hold.'
                  )
                : tr(
                    '确认已处理风险后解除阻断，之后仍需手动启动。',
                    'Clear the hold after addressing the issue, then start manually.'
                  )
            }}
          </p>
          <button
            class="button"
            :disabled="running || !!unresolved.length || busy.resolve"
            @click="onAction('resolve', () => api.insights.resolveRisk())"
          >
            {{
              busy.resolve ? tr('处理中…', 'Working…') : tr('已处理，解除阻断', 'Issue handled; clear hold')
            }}
          </button>
        </div>
      </section>
      <section class="metrics-strip record-metrics">
        <div>
          <span>{{ tr('已用 / 预留（钻）', 'Spent / reserved (diamonds)') }}</span
          ><strong>{{ data.budget.spent }}<i> / </i>{{ data.budget.reserved }}</strong>
        </div>
        <div>
          <span>{{ tr('免费复用参与占比', 'Entries reusing eligibility') }}</span
          ><strong>{{ (data.metrics.reuse * 100).toFixed(1) }}<small>%</small></strong>
        </div>
        <div>
          <span>{{ tr('每轮新增支出（钻）', 'New cost per entry') }}</span
          ><strong>{{ data.metrics.costPerRound.toFixed(2) }}</strong>
        </div>
        <div>
          <span>{{ tr('今日活跃（分钟）', 'Active today (minutes)') }}</span
          ><strong
            >{{ data.metrics.activeMinutes.toFixed(1)
            }}<i> / {{ data.session.policy.dailyMinutes }}</i></strong
          >
        </div>
      </section>
    </template>
    <section class="surface data-surface">
      <div class="data-toolbar" v-if="view === 'library'">
        <label class="search-input"
          ><UiIcon name="search" :size="18" /><input
            v-model="filter"
            type="search"
            :aria-label="tr('搜索房间', 'Search rooms')"
            :placeholder="tr('搜索主播或直播间地址', 'Search host or room URL')" /></label
        ><select v-model="roomFilter" :aria-label="tr('房间筛选', 'Filter rooms')">
          <option value="all">{{ tr('所有房间', 'All rooms') }}</option>
          <option value="favorite">{{ tr('已收藏', 'Favorites') }}</option>
          <option value="permitted">{{ tr('允许付费', 'Payment permitted') }}</option>
          <option value="blocked">{{ tr('已屏蔽', 'Blocked') }}</option></select
        ><button
          class="button"
          :disabled="running || busy.addRoom || !!unresolved.length || !!risks.length"
          @click="emit('add')"
        >
          <UiIcon name="plus" :size="17" />{{ tr('手动参与', 'Join a room') }}
        </button>
      </div>
      <div class="data-toolbar" v-else>
        <div class="segment-control" :aria-label="tr('记录类型', 'Record type')">
          <button
            v-for="item in [
              { id: 'rounds', zh: '参与记录', en: 'Entries' },
              { id: 'payments', zh: '支出账本', en: 'Payments' },
              { id: 'decisions', zh: '选择依据', en: 'Decisions' }
            ]"
            :key="item.id"
            :class="{ selected: tab === item.id }"
            :aria-pressed="tab === item.id"
            @click="tab = item.id"
          >
            {{ tr(item.zh, item.en) }}
          </button>
        </div>
        <div class="button-row">
          <button
            class="button small"
            :disabled="busy.export"
            @click="onAction('export', () => api.insights.export())"
          >
            <UiIcon name="download" :size="16" />{{ tr('脱敏导出', 'Export redacted') }}</button
          ><button
            class="button text-button small"
            :disabled="running || busy.reset"
            @click="confirmation = { kind: 'reset' }"
          >
            {{ tr('重置展示统计', 'Reset display totals') }}
          </button>
        </div>
      </div>
      <div v-if="view==='records'" class="record-filters">
        <input v-model="search" type="search" placeholder="搜索房间或原因" aria-label="搜索运行记录" />
        <input v-model="dateFrom" type="date" aria-label="记录开始日期" /><input v-model="dateTo" type="date" aria-label="记录结束日期" />
        <select v-model="resultFilter" aria-label="记录状态"><option value="">全部状态</option><option v-for="value in (tab==='rounds'?['won','lost','unknown','pending','cancelled']:tab==='payments'?['confirmed','failed','unresolved','submitted','reserved']:['skip','candidate','takeover','budget-reset','reconcile'])" :key="value" :value="value">{{label(value)}}</option></select>
        <select v-model="cycleFilter" aria-label="预算轮次筛选" v-if="tab!=='decisions'"><option value="">全部预算轮次</option><option v-for="c in data.cycles||[]" :key="c.cycle" :value="String(c.cycle)">预算第 {{c.cycle+1}} 轮</option></select>
        <button class="button small" @click="search='';dateFrom='';dateTo='';resultFilter='';cycleFilter=''">清除筛选</button>
      </div>
      <p v-if="view === 'library'" class="table-note">
        {{
          running
            ? tr(
                '运行中可查看，停止计划后可修改房间设置。',
                'Read-only during a run. Stop the plan to edit rooms.'
              )
            : tr(
                '收藏影响复访优先级；允许付费仍受策略和预算限制。当前资格每轮重新验证。',
                'Favorites affect revisit order. Payment permission remains subject to policy and budget. Eligibility is rechecked each round.'
              )
        }}
      </p>
      <div v-if="!total" class="empty-state page-empty">
        <span class="empty-icon"><UiIcon :name="view === 'library' ? 'rooms' : 'records'" :size="28" /></span>
        <h3>
          {{
            view === 'library'
              ? filter || roomFilter !== 'all'
                ? tr('没有匹配的房间', 'No matching rooms')
                : tr('房间库还是空的', 'Your room library is empty')
              : tr('这里还没有记录', 'No records yet')
          }}
        </h3>
        <p>
          {{
            view === 'library'
              ? tr(
                  '开始自动运行或手动验证后，会在这里保留房间档案。',
                  'Verified and discovered rooms will appear here after a run.'
                )
              : tr(
                  '参与、支付和选择过程会分别保留可核对的记录。',
                  'Entries, payments and decisions are recorded separately.'
                )
          }}
        </p>
      </div>
      <div v-else class="table-scroll" tabindex="0" :aria-label="tr('记录表格', 'Records table')">
        <table v-if="view === 'library'">
          <thead>
            <tr>
              <th>{{ tr('直播间 / 来源', 'Room / source') }}</th>
              <th>{{ tr('当前资格', 'Eligibility') }}</th>
              <th>{{ tr('发现 / 验证', 'Found / checked') }}</th>
              <th>{{ tr('下次可复访', 'Next revisit') }}</th>
              <th>{{ tr('房间设置', 'Room options') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="room in rooms.slice(start, start + 15)" :key="room.url">
              <td>
                <strong class="cell-title" :title="room.url">{{ room.name }}</strong
                ><small>{{ label(room.source) }}</small>
              </td>
              <td>
                <span class="status-pill" :class="room.membership === 'satisfied' ? 'success' : 'neutral'">{{
                  label(room.membership)
                }}</span>
              </td>
              <td>{{ room.visits.filter((v) => v.found).length }} / {{ room.visits.length }}</td>
              <td>{{ time(room.nextEligibleCheckAt) }}</td>
              <td>
                <div class="room-options">
                  <label
                    v-for="option in [
                      { key: 'favorite', zh: '收藏', en: 'Favorite' },
                      { key: 'blocked', zh: '屏蔽', en: 'Block' },
                      { key: 'allowPaid', zh: '付费许可', en: 'Allow payment' }
                    ]"
                    :key="option.key"
                    ><input
                      type="checkbox"
                      :checked="room[option.key as 'favorite' | 'blocked' | 'allowPaid']"
                      :disabled="running || busy[`profile:${room.url}`]"
                      :aria-label="`${room.name} ${tr(option.zh, option.en)}`"
                      @change="changeRoom(room, option.key as 'favorite' | 'blocked' | 'allowPaid', $event)"
                    />{{ tr(option.zh, option.en) }}</label
                  >
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <table v-else-if="tab === 'rounds'">
          <thead>
            <tr>
              <th>{{ tr('直播间 / 开奖时间', 'Room / draw time') }}</th>
              <th>{{ tr('提交与确认', 'Submission / confirmation') }}</th>
              <th>{{ tr('开奖结果', 'Draw result') }}</th>
              <th>{{ tr('奖励', 'Reward') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="round in filteredRounds.slice(start, start + 15)" :key="round.key">
              <td>
                <strong class="cell-title">{{ name(round.roomUrl) }}</strong
                ><small>{{ time(round.drawAt) }}</small>
              </td>
              <td>
                <span>{{ tr('提交', 'Submitted') }} {{ time(round.submittedAt) }}</span
                ><small>{{ tr('确认', 'Confirmed') }} {{ time(round.confirmedAt) }}</small>
              </td>
              <td>
                <span
                  class="status-pill"
                  :class="
                    round.result === 'won' ? 'success' : round.result === 'unknown' ? 'warning' : 'neutral'
                  "
                  >{{ label(round.result) }}</span
                >
              </td>
              <td>
                {{ label(round.prizeType) }}
                <strong v-if="round.prizeType === 'diamond' && round.diamondAmount != null">{{ round.diamondAmount }} {{ tr('钻', 'diamonds') }}</strong>
                <small v-else-if="round.result === 'won' && round.prizeType === 'diamond'">{{ tr('数量待确认', 'Amount pending') }}</small>
                <small v-if="round.prizeName">{{ round.prizeName }}</small>
                <small v-if="round.prizeQuantity != null">× {{ round.prizeQuantity }}{{ round.prizeUnit || '' }}</small>
              </td>
            </tr>
          </tbody>
        </table>
        <table v-else-if="tab === 'payments'">
          <thead>
            <tr>
              <th>{{ tr('直播间 / 时间', 'Room / time') }}</th>
              <th>{{ tr('金额', 'Amount') }}</th>
              <th>{{ tr('用途', 'Purpose') }}</th>
              <th>{{ tr('支付状态', 'Payment status') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="payment in filteredPayments.slice(start, start + 15)" :key="payment.id">
              <td>
                <strong class="cell-title">{{ name(payment.roomUrl) }}</strong
                ><small>{{ time(payment.at) }}</small>
              </td>
              <td>{{ payment.cost }} {{ tr('钻', 'diamonds') }}</td>
              <td>{{ payment.newClub ? tr('新开粉丝团', 'New membership') : tr('再次点亮', 'Relight') }}</td>
              <td>
                <span
                  class="status-pill"
                  :class="
                    payment.state === 'confirmed'
                      ? 'success'
                      : payment.state === 'unresolved'
                        ? 'warning'
                        : 'neutral'
                  "
                  >{{ label(payment.state) }}</span
                >
              </td>
            </tr>
          </tbody>
        </table>
        <table v-else>
          <thead>
            <tr>
              <th>{{ tr('直播间 / 时间', 'Room / time') }}</th>
              <th>{{ tr('决策与理由', 'Decision / reason') }}</th>
              <th>{{ tr('估计机会', 'Estimated chance') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(decision, index) in filteredDecisions.slice(start, start + 15)" :key="index">
              <td>
                <strong class="cell-title">{{ name(decision.url) }}</strong
                ><small>{{ time(decision.at) }}</small>
              </td>
              <td>
                <strong>{{ label(decision.action) }}</strong>
                <p class="cell-reason">{{ decision.reason }}</p>
                <details v-if="decision.snapshot" class="evidence">
                  <summary>{{ tr('查看依据', 'Show evidence') }}</summary>
                  <p>
                    {{ tr('费用', 'Cost') }} {{ decision.snapshot.opportunity.cost ?? '—' }} ·
                    {{ tr('提前', 'Lead') }} {{ decision.snapshot.leadSeconds }}s ·
                    {{ tr('样本', 'Samples') }} {{ decision.snapshot.sampleCount }}
                  </p>
                  <p>
                    {{ tr('证据来源', 'Source') }}: {{ decision.snapshot.opportunity.source }} ·
                    {{ tr('评分', 'Score') }} {{ decision.score?.toFixed(3) ?? '—' }}
                  </p>
                </details>
              </td>
              <td>
                {{
                  decision.probability == null
                    ? tr('未知', 'Unknown')
                    : `≈ ${(decision.probability * 100).toFixed(2)}%`
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <footer class="table-footer">
        <span>{{ tr(`共 ${total} 条`, `${total} records`) }}</span>
        <div>
          <button class="button small" :disabled="page <= 1" @click="page--">
            {{ tr('上一页', 'Previous') }}</button
          ><span>{{ page }} / {{ pages }}</span
          ><button class="button small" :disabled="page >= pages" @click="page++">
            {{ tr('下一页', 'Next') }}
          </button>
        </div>
      </footer>
    </section>
    <p v-if="view === 'records'" class="microcopy">
      {{
        tr(
          '概率估计假设同资格等概率。未知结果不等于未中奖；导出不包含登录态、账号标识或评论口令。',
          'Estimated chances assume equal odds among eligible participants. Unknown is not a loss. Exports omit login data, account identifiers and comment commands.'
        )
      }}
    </p>
    <details v-if="view === 'records' && Object.keys(data.legacy).length" class="legacy-records">
      <summary>{{ tr('旧版汇总，仅供参考', 'Legacy totals, for reference only') }}</summary>
      <pre>{{ data.legacy }}</pre>
    </details>
    <UiDialog
      :open="!!confirmation"
      :title="dialogTitle"
      :busy="dialogBusy"
      :close-label="tr('关闭', 'Close')"
      @close="confirmation = null"
      ><p v-if="confirmation?.kind === 'reset'" class="dialog-copy">
        {{
          tr(
            '只清空本次展示的累计统计。历史记录、已用钻石和预留额度都会保留。',
            'Reset display totals only. History, spent diamonds and reserved funds remain unchanged.'
          )
        }}
      </p>
      <div v-else class="dialog-copy">
        <strong
          >{{ confirmation?.payment && name(confirmation.payment.roomUrl) }} ·
          {{ confirmation?.payment?.cost }} {{ tr('钻', 'diamonds') }}</strong
        >
        <p>
          {{
            confirmation?.state === 'confirmed'
              ? tr(
                  '请确认已在抖音扣款记录中核实这笔支付成功，确认后计入已用预算。',
                  'Confirm you verified this charge in Douyin. It will be counted as spent.'
                )
              : tr(
                  '请确认已核实没有扣款。确认后将释放这笔预留额度。',
                  'Confirm you verified that no charge occurred. The reserved funds will be released.'
                )
          }}
        </p>
      </div>
      <template #footer
        ><button class="button" :disabled="dialogBusy" @click="confirmation = null">
          {{ tr('取消', 'Cancel') }}</button
        ><button class="button primary" :disabled="dialogBusy" @click="confirm">
          {{ dialogBusy ? tr('处理中…', 'Working…') : tr('确认', 'Confirm') }}
        </button></template
      ></UiDialog
    >
  </div>
</template>
