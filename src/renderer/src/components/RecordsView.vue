<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Insights } from '../../../shared/insights'
import type { Payment, Policy } from '../../../shared/policy'
import ReviewSummary from './ReviewSummary.vue'
import RoomLibraryView from './RoomLibraryView.vue'
import OutcomeBar from './OutcomeBar.vue'
import { inRun, recordTotals, roomDisplayName } from '../../../shared/record-presentation'
import UiIcon from './UiIcon.vue'
import UiDialog from './UiDialog.vue'
const props = defineProps<{
  view: 'library' | 'records'
  data: Insights | null
  loggedIn: boolean
  running: boolean
  membership: Policy['membership']
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
const runFilter = ref('')
const tab = ref('rounds')
const page = ref(1)
const search=ref(''), dateFrom=ref(''),dateTo=ref(''),resultFilter=ref(''),cycleFilter=ref('')
function matches(r:any):boolean {
  const at=r.createdAt??r.at,day=at?new Date(at).toLocaleDateString('en-CA'):''
  return `${name(r.roomUrl||r.url||'')} ${r.roomUrl||r.url||''} ${r.reason||''} ${r.prizeName||''}`.toLowerCase().includes(search.value.toLowerCase()) &&
    (!dateFrom.value||day>=dateFrom.value)&&(!dateTo.value||day<=dateTo.value)&&
    (!resultFilter.value||(r.result||r.state||r.action)===resultFilter.value)&&
    (!cycleFilter.value||(r.budgetCycle??0)===Number(cycleFilter.value))
}
const scopedRounds = computed(() => props.data?.rounds.filter(r => inRun(r,runFilter.value)) || [])
const scopedPayments = computed(() => props.data?.payments.filter(r => inRun(r,runFilter.value)) || [])
const totals = computed(() => recordTotals(scopedRounds.value, scopedPayments.value))
const selectedRun = computed(() => props.data?.reports?.find(r => r.id === runFilter.value))
const filteredRounds=computed(()=>scopedRounds.value.filter(matches))
const filteredPayments=computed(()=>scopedPayments.value.filter(matches))
const filteredDecisions=computed(()=>props.data?.decisions.filter(matches)||[])
const tabItems=computed(()=>[
  {id:'rounds',label:tr('参与记录','Entries'),hint:tr('参与是否成功，开奖结果如何','Participation and results'),count:scopedRounds.value.length},
  {id:'payments',label:tr('支出账本','Payments'),hint:tr('扣款、预留与待核对','Charges, holds and review'),count:scopedPayments.value.length},
  {id:'decisions',label:tr('选择依据','Decisions'),hint:tr('为什么参与、预约或跳过','Why joined, queued or skipped'),count:props.data?.decisions.length||0}
])
const searchHint=computed(()=>tab.value==='rounds'?tr('搜索房间或奖品','Search room or reward'):tab.value==='payments'?tr('搜索房间','Search room'):tr('搜索房间或原因','Search room or reason'))
const paymentLabel=(state:string)=>({confirmed:tr('已确认扣款','Charge confirmed'),reserved:tr('仅预留，未付款','Reserved, not paid'),submitted:tr('已发起，待反馈','Sent, awaiting response'),unresolved:tr('支付待核对','Charge needs review'),failed:tr('未扣款','Not charged')}[state]||state)
const unconfirmedOutcomes=computed(()=>scopedRounds.value.filter(r=>r.confirmedAt==null&&['unknown','pending'].includes(r.result)).length)

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
  roomDisplayName(props.data?.rooms.find((room) => room.url === url)?.name, url, props.language==='en-US')
const unresolved = computed(
  () => props.data?.payments.filter((payment) => payment.state === 'unresolved') || []
)
const risks = computed(() => props.data?.risks.filter((risk) => risk.resolvedAt === null) || [])
watch(tab,()=>{resultFilter.value='';cycleFilter.value='';if(tab.value==='decisions')runFilter.value=''})
const rows = computed(
  () =>
    (tab.value === 'rounds'
      ? filteredRounds.value
      : tab.value === 'payments'
        ? filteredPayments.value
        : filteredDecisions.value) || []
)
const total = computed(() => rows.value.length)
const pages = computed(() => Math.max(1, Math.ceil(total.value / 15)))
const start = computed(() => (page.value - 1) * 15)
const dialogTitle = computed(() =>
  confirmation.value?.kind === 'reset'
    ? tr('重置展示统计', 'Reset display totals')
    : tr('核对这笔支付', 'Reconcile this payment')
)
watch([() => props.view, runFilter, tab,search,dateFrom,dateTo,resultFilter,cycleFilter], () => {
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
  <RoomLibraryView v-else-if="view==='library'" :data="data" :running="running" :language="language" :membership="membership" :busy="busy" :on-action="onAction" @add="emit('add')" />
  <div v-else class="records-view">
    <section class="surface record-overview">
      <div class="record-scope-heading">
        <div><h2>{{ tr('运行回顾','Run review') }}</h2><p>{{ selectedRun ? (selectedRun.endedAt===null?tr('运行中','Running'):selectedRun.reason) : runFilter==='unassigned'?tr('未归属的历史记录，不按时间推测运行。','Unassigned history; no inferred run ownership.'):tr('全部历史记录，包含旧预算轮次。','All historical records, including earlier budget cycles.') }}</p></div>
        <label v-if="tab!=='decisions'" class="run-scope-label">{{ tr('查看范围','Scope') }}<select v-model="runFilter" :aria-label="tr('运行范围','Run scope')"><option value="">{{ tr('全部运行','All runs') }}</option><option v-for="r in data.reports||[]" :key="r.id" :value="r.id">{{ time(r.startedAt) }} · {{ r.endedAt===null?tr('运行中','Running'):r.reason }}</option><option value="unassigned">{{ tr('未归属运行的历史记录','Unassigned history') }}</option></select></label>
      </div>
      <div class="record-headline"><div><span>{{tr('确认参与','Confirmed entries')}}</span><strong>{{totals.confirmed}}</strong></div><div><span>{{tr('中奖','Won')}}</span><strong>{{totals.won}}</strong></div><div><span>{{tr('记录支出','Recorded spending')}}</span><strong>{{totals.spent}} <small>{{tr('钻','diamonds')}}</small></strong></div><div><span>{{tr('待定占额','Reserved / pending')}}</span><strong>{{totals.reserved}} <small>{{tr('钻','diamonds')}}</small></strong></div></div>
      <OutcomeBar :won="totals.won" :lost="totals.lost" :unknown="totals.unknown" :pending="totals.pending" :language="language" />
      <p v-if="unconfirmedOutcomes" class="microcopy">{{tr(`分布中包含 ${unconfirmedOutcomes} 条尚未确认参与的记录；未知结果不代表未中奖。`, `Distribution includes ${unconfirmedOutcomes} records without confirmed participation. Unknown is not a loss.`)}}</p>
      <p v-if="selectedRun" class="microcopy">{{ tr('活跃','Active') }} {{ (selectedRun.activeMs/60000).toFixed(1) }} {{tr('分钟','minutes')}} · {{tr('结束','Ended')}} {{selectedRun.endedAt===null?'—':time(selectedRun.endedAt)}} · {{tr('预算轮次','Budget cycle')}} {{selectedRun.budgetCycle+1}}</p>
    </section>
    <ReviewSummary part="claims" :data="data" :busy="busy" :on-action="onAction" :language="language" />
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
    <section class="surface data-surface">
      <div class="data-toolbar">
        <div class="record-navigation" :aria-label="tr('记录类型','Record type')">
          <button v-for="item in tabItems" :key="item.id" :class="{selected:tab===item.id}" :aria-label="item.label" :aria-pressed="tab===item.id" @click="tab=item.id"><span class="record-nav-title">{{item.label}}<b>{{item.count}}</b></span><small>{{item.hint}}</small></button>
        </div>
        <details class="record-actions"><summary>{{ tr('更多操作','More actions') }}</summary><div class="button-row">
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
        </div></details>
      </div>
      <div class="record-filters">
        <input v-model="search" type="search" :placeholder="searchHint" :aria-label="tr('搜索运行记录','Search records')" />
        <select v-model="resultFilter" :aria-label="tr('记录状态','Record status')"><option value="">{{tr('全部状态','All statuses')}}</option><option v-for="value in (tab==='rounds'?['won','lost','unknown','pending','cancelled']:tab==='payments'?['confirmed','failed','unresolved','submitted','reserved']:['skip','candidate','takeover','budget-reset','reconcile'])" :key="value" :value="value">{{tab==='payments'?paymentLabel(value):label(value)}}</option></select>
        <details class="advanced-filters"><summary>{{tr('更多筛选','More filters')}}<span v-if="dateFrom||dateTo||cycleFilter"> · {{tr('已启用','Active')}}</span></summary><div>
          <label>{{tr('从','From')}}<input v-model="dateFrom" type="date" :aria-label="tr('记录开始日期','Start date')" /></label><label>{{tr('到','To')}}<input v-model="dateTo" type="date" :aria-label="tr('记录结束日期','End date')" /></label>
          <select v-model="cycleFilter" :aria-label="tr('预算轮次筛选','Budget cycle filter')" v-if="tab!=='decisions'"><option value="">{{tr('全部预算轮次','All budget cycles')}}</option><option v-for="c in data.cycles||[]" :key="c.cycle" :value="String(c.cycle)">{{tr('预算轮次','Budget cycle')}} {{c.cycle+1}}</option></select>
        </div></details>
        <button v-if="search||dateFrom||dateTo||resultFilter||cycleFilter" class="button text-button small" @click="search='';dateFrom='';dateTo='';resultFilter='';cycleFilter=''">{{tr('清除筛选','Clear filters')}}</button>
      </div>
      <p v-if="tab==='decisions'" class="table-note">{{tr('选择依据未绑定单次运行，按全部历史展示；可按日期和房间筛选。','Decisions have no run ownership. Showing all history; filter by date or room.')}}</p>
      <p v-else class="record-scope-note">{{tr('明细遵循所选运行范围；上方摘要不受明细筛选影响。','Details follow the selected run scope. Detail filters do not change the summary.')}}</p>
      <div v-if="!total" class="empty-state page-empty"><UiIcon name="records" :size="28" /><h3>{{tr('没有匹配的记录','No matching records')}}</h3><p>{{tr('切换运行范围或清除筛选，查看其他记录。','Change run scope or clear filters to see other records.')}}</p></div>
      <ol v-else-if="tab==='decisions'" class="decision-feed" :aria-label="tr('选择依据时间线','Decision timeline')">
        <li v-for="(decision,index) in filteredDecisions.slice(start,start+15)" :key="`${decision.at}:${index}`" class="decision-event">
          <div class="decision-event-time"><span class="decision-dot" :class="{skipped:decision.action==='skip'}" /><time>{{time(decision.at)}}</time></div>
          <div class="decision-event-body"><div class="decision-event-heading"><span class="status-pill" :class="decision.action==='skip'?'neutral':'schedule'">{{label(decision.action)}}</span><strong>{{name(decision.url)}}</strong></div><p class="decision-reason">{{decision.reason || tr('未记录具体原因','No reason recorded')}}</p>
            <details class="record-evidence"><summary>{{tr('查看判断详情','Decision details')}}</summary>
              <dl v-if="decision.snapshot"><div><dt>{{tr('预计新增费用','Expected new cost')}}</dt><dd>{{decision.snapshot.opportunity.cost??'—'}} {{tr('钻','diamonds')}}</dd></div><div><dt>{{tr('准备时间','Preparation')}}</dt><dd>{{decision.snapshot.leadSeconds}}s</dd></div><div><dt>{{tr('耗时样本数','Timing samples')}}</dt><dd>{{decision.snapshot.sampleCount}}</dd></div><div><dt>{{tr('证据来源','Evidence source')}}</dt><dd>{{decision.snapshot.opportunity.source}}</dd></div></dl>
              <p>{{tr('估计中奖机会','Estimated chance')}} {{decision.probability==null?tr('无法估计','Not available'):`≈ ${(decision.probability*100).toFixed(2)}%`}}</p><p class="microcopy">{{tr('仅在名额与参与人数可用、同资格等概率的假设下估计，不代表实际中奖保证。','Estimate assumes equal chances and available prize / participant counts; it is not a guarantee.')}}</p><p class="record-address">{{decision.url||tr('系统记录','System record')}}</p>
            </details>
          </div>
        </li>
      </ol>
      <div v-else class="table-scroll" tabindex="0" :aria-label="tr('记录表格','Records table')">
        <table class="record-table entry-table" role="table" v-if="tab==='rounds'">
          <thead><tr><th>{{tr('直播间与开奖时间','Room and draw')}}</th><th>{{tr('参与与结果','Entry and result')}}</th><th>{{tr('中奖奖励','Won reward')}}</th></tr></thead>
          <tbody><tr v-for="round in filteredRounds.slice(start,start+15)" :key="round.key">
            <td :data-label="tr('直播间与开奖时间','Room and draw')"><strong class="cell-title">{{name(round.roomUrl)}}</strong><small>{{tr('开奖','Draw')}} {{time(round.drawAt)}}</small>
              <details class="record-evidence"><summary>{{tr('参与详情','Entry details')}}</summary><dl><div><dt>{{tr('提交时间','Submitted')}}</dt><dd>{{time(round.submittedAt)}}</dd></div><div><dt>{{tr('确认时间','Confirmed')}}</dt><dd>{{time(round.confirmedAt)}}</dd></div><div><dt>{{tr('福袋编号','Bag ID')}}</dt><dd>{{round.lotteryId}}</dd></div></dl><p class="record-address">{{round.roomUrl}}</p></details>
            </td>
            <td :data-label="tr('参与与结果','Entry and result')"><span class="status-pill" :class="round.result==='won'?'success':round.result==='unknown'?'warning':'neutral'">{{label(round.result)}}</span><small class="entry-confirmation" :class="{confirmed:round.confirmedAt!=null}">{{round.confirmedAt!=null?tr('已确认参与','Participation confirmed'):round.submittedAt!=null?tr('已提交，参与未确认','Submitted; participation unconfirmed'):tr('未确认参与','Participation unconfirmed')}}</small></td>
            <td :data-label="tr('中奖奖励','Won reward')">
              <template v-if="round.result==='won' && round.confirmedAt!=null"><strong class="reward-title">{{round.prizeName || (round.prizeType==='diamond'?tr('钻石奖励','Diamond reward'):tr('已中奖，奖品待补充','Won; reward details pending'))}}</strong><span class="reward-amount" v-if="round.prizeType==='diamond' && round.diamondAmount!=null">{{round.diamondAmount}} <small>{{tr('钻','diamonds')}}</small></span><small v-else-if="round.prizeType==='diamond'">{{tr('数量待确认','Amount pending')}}</small><small v-else-if="round.prizeQuantity!=null">× {{round.prizeQuantity}}{{round.prizeUnit||''}}</small><small v-if="round.prizeType!=='diamond'">{{round.claimed?tr('已标记处理','Marked handled'):tr('领取信息见上方待办','See claim checklist above')}}</small></template>
              <span v-else class="empty-reward">{{round.result==='lost'?tr('无中奖奖励','No reward'):tr('暂无已确认奖励','No confirmed reward')}}</span>
            </td>
          </tr></tbody>
        </table>
        <table v-else class="record-table payment-table" role="table">
          <thead><tr><th>{{tr('直播间与用途','Room and purpose')}}</th><th>{{tr('支付金额','Payment amount')}}</th><th>{{tr('账本状态','Ledger status')}}</th></tr></thead>
          <tbody><tr v-for="payment in filteredPayments.slice(start,start+15)" :key="payment.id">
            <td :data-label="tr('直播间与用途','Room and purpose')"><strong class="cell-title">{{name(payment.roomUrl)}}</strong><small>{{payment.newClub?tr('新开粉丝团','New membership'):tr('再次点亮','Relight')}} · {{time(payment.at)}}</small><details class="record-evidence"><summary>{{tr('支付详情','Payment details')}}</summary><dl><div><dt>{{tr('记录创建时间','Recorded')}}</dt><dd>{{time(payment.at)}}</dd></div><div><dt>{{tr('确认扣款时间','Charge confirmed')}}</dt><dd>{{time(payment.confirmedAt)}}</dd></div><div><dt>{{tr('预算轮次','Budget cycle')}}</dt><dd>{{(payment.budgetCycle??0)+1}}</dd></div><div><dt>{{tr('本地支付编号','Local payment ID')}}</dt><dd>{{payment.id}}</dd></div></dl><p class="record-address">{{payment.roomUrl}}</p></details></td>
            <td :data-label="tr('支付金额','Payment amount')"><strong class="ledger-amount" :class="{settled:payment.state==='confirmed'}">{{payment.cost}} <small>{{tr('钻','diamonds')}}</small></strong><small>{{payment.state==='confirmed'?tr('计入已用预算','Counts as spent'):payment.state==='failed'?tr('不占用预算','No budget held'):tr('仍占用预算','Budget remains held')}}</small></td>
            <td :data-label="tr('账本状态','Ledger status')"><span class="status-pill" :class="payment.state==='confirmed'?'success':payment.state==='unresolved'?'warning':'neutral'">{{paymentLabel(payment.state)}}</span><small v-if="payment.state==='unresolved'">{{tr('请在上方异常区核对实际扣款','Verify the actual charge in the review section above')}}</small></td>
          </tr></tbody>
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
    <ReviewSummary part="history" :data="data" :busy="busy" :on-action="onAction" :language="language" />
    <p class="microcopy">
      {{
        tr(
          '概率估计假设同资格等概率。未知结果不等于未中奖；导出不包含登录态、账号标识或评论口令。',
          'Estimated chances assume equal odds among eligible participants. Unknown is not a loss. Exports omit login data, account identifiers and comment commands.'
        )
      }}
    </p>
    <details v-if="Object.keys(data.legacy).length" class="legacy-records">
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
