<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useIpc } from './composables/useIpc'
import { normalizeRoomUrl } from '../../shared/policy'
import UiIcon from './components/UiIcon.vue'
import UiDialog from './components/UiDialog.vue'
import RunDashboard from './components/RunDashboard.vue'
import SettingsView from './components/SettingsView.vue'
import RecordsView from './components/RecordsView.vue'
import ActivityLog from './components/ActivityLog.vue'
import './styles.css'

const {
  alerts,alertDestination,dismissAlert,finishCurrent,extendRun,skipCandidate,
  ready,
  isLoggedIn,
  authState,
  checkLogin,
  rooms,
  config,
  logs,
  stats,
  runStats,
  autoRunState,
  insights,
  busy,
  notice,
  notify,
  action,
  requireSuccess,
  login,
  logout,
  addRoom,
  removeRoom,
  startAutoRun,
  stopAutoRun,
  updateConfig,
  resetRunStats,
  resetBudget,
  refreshInsights,
  retry
} = useIpc()
type View = 'dashboard' | 'settings' | 'library' | 'records' | 'logs'
const view = ref<View>('dashboard')
watch(alertDestination,kind=>{if(kind){view.value=kind==='login'?'dashboard':'records';alertDestination.value=''}})
const dirty = ref(false)
const manualOpen = ref(false)
const manualUrl = ref('')
const manualName = ref('')
const manualError = ref('')
const logoutOpen = ref(false)
const language = computed(() => config.value?.language || 'zh-CN')
const tr = (zh: string, en: string) => (language.value === 'en-US' ? en : zh)
const running = computed(() => !!autoRunState.value?.running)
const navItems: { id: View; icon: string; zh: string; en: string; description: [string, string] }[] = [
  {
    id: 'dashboard',
    icon: 'dashboard',
    zh: '运行面板',
    en: 'Overview',
    description: ['查看当前任务，控制本次运行。', 'Follow your current task and control the run.']
  },
  {
    id: 'settings',
    icon: 'settings',
    zh: '策略设置',
    en: 'Settings',
    description: [
      '选择参与偏好，设置预算和运行节奏。',
      'Choose prize preferences, spending limits and your schedule.'
    ]
  },
  {
    id: 'library',
    icon: 'rooms',
    zh: '房间库',
    en: 'Room library',
    description: ['查看房间历史、验证结果与屏蔽状态。', 'Review room history, checks and blocked rooms.']
  },
  {
    id: 'records',
    icon: 'records',
    zh: '运行记录',
    en: 'Records',
    description: ['核对参与、开奖结果和每一笔支出。', 'Review entries, draw results and every payment.']
  },
  {
    id: 'logs',
    icon: 'logs',
    zh: '运行日志',
    en: 'Activity log',
    description: ['了解操作过程，定位异常原因。', 'Follow actions and understand why something stopped.']
  }
]
const current = computed(() => navItems.find((item) => item.id === view.value)!)
const attentionCount = computed(
  () =>
    (insights.value?.payments.filter((p) => p.state === 'unresolved').length || 0) +
    (insights.value?.risks.filter((r) => r.resolvedAt === null).length || 0)
)
const recordAttentionCount=computed(()=>attentionCount.value+(insights.value?.rounds.filter(r=>r.result==='won'&&r.confirmedAt!==null&&r.prizeType!=='diamond'&&!r.claimed).length||0))
async function switchLanguage(event: Event) {
  if (!(await updateConfig({ language: (event.target as HTMLSelectElement).value as 'zh-CN' | 'en-US' })))
    (event.target as HTMLSelectElement).value = language.value
}
function openManual() {
  if (attentionCount.value || autoRunState.value?.status === 'blocked') {
    view.value = 'records'
    notify(tr('请先处理风险提示和未决支付。', 'Review risk holds and unresolved payments first.'), 'info')
    return
  }
  if (dirty.value) {
    view.value = 'settings'
    notify(
      tr('请先保存或还原设置，再手动参与。', 'Save or discard your settings before joining a room.'),
      'info'
    )
    return
  }
  manualError.value = ''
  manualOpen.value = true
}
async function submitManual() {
  manualError.value = ''
  let url: string
  try {
    url = normalizeRoomUrl(manualUrl.value.trim())
  } catch {
    manualError.value = tr(
      '请输入有效直播间地址，例如 https://live.douyin.com/12345678。',
      'Enter a valid room URL, such as https://live.douyin.com/12345678.'
    )
    return
  }
  if (await addRoom(url, manualName.value.trim() || undefined)) {
    manualOpen.value = false
    manualUrl.value = ''
    manualName.value = ''
    view.value = 'dashboard'
  } else
    manualError.value =
      notice.value?.text ||
      tr('验证未通过，请检查地址或稍后重试。', 'Room verification failed. Check the URL or retry later.')
}
async function cancelManual() {
  if (await stopAutoRun()) manualOpen.value = false
}
async function recordAction(
  key: string,
  fn: () => Promise<{ success: boolean; error?: string; path?: string }>
) {
  return action(key, async () => {
    const result = await fn()
    if (!result.success && result.error === '已取消导出') return false
    requireSuccess(result)
    await refreshInsights()
    notify(
      result.path
        ? tr(`记录已导出：${result.path}`, `Records exported: ${result.path}`)
        : tr('已保存。', 'Saved.')
    )
    return true
  })
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark"><UiIcon name="gift" :size="24" /></span>
        <div>
          <strong>{{ tr('福袋助手', 'Lucky Bag') }}</strong
          ><small>{{ tr('抖音直播工作台', 'Douyin workspace') }}</small>
        </div>
      </div>
      <nav class="main-nav" :aria-label="tr('主导航', 'Main navigation')">
        <button
          v-for="item in navItems"
          :key="item.id"
          :class="{ selected: view === item.id }"
          :aria-current="view === item.id ? 'page' : undefined"
          :aria-label="tr(item.zh, item.en)"
          :title="tr(item.zh, item.en)"
          @click="view = item.id"
        >
          <UiIcon :name="item.icon" /><span>{{ tr(item.zh, item.en) }}</span
          ><i
            v-if="item.id === 'settings' && dirty"
            class="nav-dot"
            :aria-label="tr('未保存', 'Unsaved')"
          /><b v-if="item.id === 'records' && recordAttentionCount" class="nav-count">{{ recordAttentionCount }}</b>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <div class="sidebar-status">
          <span class="status-dot" :class="{ online: running }" /><span>{{
            running ? tr('计划执行中', 'Plan active') : tr('当前未运行', 'Currently stopped')
          }}</span>
        </div>
        <p>{{ tr('低频串行，按计划休息', 'One room at a time, with planned breaks') }}</p>
        <small>v1.0.0</small>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div class="breadcrumb">
          <span>{{ tr('工作台', 'Workspace') }}</span
          ><UiIcon name="chevron" :size="14" /><strong>{{ tr(current.zh, current.en) }}</strong>
        </div>
        <div class="account-actions">
          <button
            v-if="running || busy.start || busy.addRoom"
            class="button stop small"
            :disabled="busy.stop"
            @click="stopAutoRun"
          >
            <UiIcon name="stop" :size="15" />{{
              busy.stop ? tr('停止中…', 'Stopping…') : tr('停止', 'Stop')
            }}</button
          ><select
            :value="language"
            class="language-select"
            :disabled="busy.save"
            :aria-label="tr('界面语言', 'Interface language')"
            @change="switchLanguage"
          >
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option></select
          ><span class="account-state" v-if="isLoggedIn"
            ><span class="status-dot online" />{{ tr('已连接', 'Connected') }}</span
          ><button
            v-if="isLoggedIn"
            class="icon-button"
            :disabled="busy.logout || busy.login"
            :aria-label="tr('退出账号', 'Sign out')"
            :title="tr('退出账号', 'Sign out')"
            @click="logoutOpen = true"
          >
            <UiIcon name="logout" :size="18" /></button
          ><button v-else-if="authState === 'checking' || authState === 'unknown'" class="button small" :disabled="authState === 'checking'" @click="checkLogin">
            {{ authState === 'checking' ? tr('正在校验登录…', 'Checking sign-in…') : tr('暂时无法验证 · 重试', 'Unable to verify · Retry') }}
          </button><button v-else class="button small" :disabled="busy.login" @click="login">
            {{ busy.login ? tr('等待登录…', 'Signing in…') : tr('登录抖音', 'Sign in') }}
          </button>
        </div>
      </header>
      <main id="main-content" class="main-content">
        <div class="page-heading" :class="{'monitoring-heading': view === 'dashboard' && running}">
          <div>
            <h1>{{ tr(current.zh, current.en) }}</h1>
            <p>{{ tr(...current.description) }}</p>
          </div>
          <span v-if="view === 'settings' && dirty" class="status-pill warning">{{
            tr('未保存', 'Unsaved')
          }}</span>
        </div>
        <div
          v-if="notice"
          class="app-notice"
          :class="notice.kind"
          :role="notice.kind === 'error' ? 'alert' : 'status'"
        >
          <UiIcon
            :name="notice.kind === 'error' ? 'alert' : notice.kind === 'success' ? 'check' : 'info'"
            :size="19"
          />
          <p>{{ notice.text }}</p>
          <button
            class="icon-button"
            :aria-label="tr('关闭提示', 'Dismiss notification')"
            @click="notice = null"
          >
            <UiIcon name="close" :size="17" />
          </button>
        </div>
        <div v-if="!ready" class="surface empty-state page-empty">
          <h2>{{ tr('正在加载工作台…', 'Loading your workspace…') }}</h2>
        </div>
        <div v-else-if="!config" class="surface empty-state page-empty">
          <h2>{{ tr('配置加载失败', 'Could not load settings') }}</h2>
          <button class="button primary" :disabled="busy.initialize" @click="retry">
            {{ tr('重新加载', 'Retry') }}
          </button>
        </div>
        <template v-else>
          <RunDashboard
            :auth-state="authState"
            @check-login="checkLogin"
            v-show="view === 'dashboard'"
            :config="config"
            :logged-in="isLoggedIn"
            :state="autoRunState"
            :rooms="rooms"
            :stats="stats"
            :totals="runStats"
            :insights="insights"
            :busy="busy"
            :dirty="dirty"
            @login="login"
            @start="startAutoRun"
            @stop="stopAutoRun"
            @finish="finishCurrent"
            @extend="extendRun"
            @skip="skipCandidate"
            @settings="view = 'settings'"
            @records="view = 'records'"
            @add="openManual"
            @remove="removeRoom"
          />
          <SettingsView
            v-show="view === 'settings'"
            :config="config"
            :running="running"
            :saving="!!busy.save"
            :on-save="updateConfig"
            :on-reset-budget="resetBudget"
            :resetting-budget="!!busy.budgetReset"
            :budget="insights?.budget"
            :can-reset-budget="isLoggedIn && !attentionCount && insights?.budget.hasActivity !== false"
            @dirty="dirty = $event"
          />
          <RecordsView
            v-if="view === 'library' || view === 'records'"
            :view="view"
            :data="insights"
            :logged-in="isLoggedIn"
            :running="running"
            :language="language"
            :busy="busy"
            :membership="config.policy.membership"
            :on-action="recordAction"
            :on-reset="resetRunStats"
            @login="login"
            @add="openManual"
          />
          <ActivityLog
            v-show="view === 'logs'"
            :logs="logs"
            :rooms="rooms"
            :language="language"
            @clear="logs = []"
          />
        </template>
        <footer class="workspace-footer">
          <UiIcon name="shield" :size="14" /><span>{{
            tr(
              '预算、未知结果与风险提示均按实际记录展示。',
              'Budgets, unknown results and risk notices reflect recorded evidence.'
            )
          }}</span>
        </footer>
      </main>
    </div>
    <aside v-if="alerts.length" class="alert-toast" role="status" aria-live="polite">
      <div class="section-heading"><small>{{ tr('福袋助手', 'Lucky Bag') }} · {{ alerts.length }} {{ tr('条提醒','notifications') }}</small><button class="icon-button" aria-label="稍后查看提醒" @click="dismissAlert(alerts[0].id)"><UiIcon name="close" :size="16" /></button></div>
      <strong>{{ alerts[0].title }}</strong><p>{{ alerts[0].message }}</p>
      <button class="button small" @click="view=alerts[0].kind==='login'?'dashboard':'records';dismissAlert(alerts[0].id)">{{ alerts[0].kind==='login'?tr('返回登录','Sign in'):alerts[0].kind==='risk'?tr('查看异常待办','View issue'):tr('查看记录','View records') }}</button>
    </aside>
    <UiDialog
      :open="manualOpen"
      :title="tr('手动参与直播间', 'Join a room')"
      :busy="!!busy.addRoom"
      :close-label="tr('关闭', 'Close')"
      @close="manualOpen = false"
    >
      <form id="manual-room-form" novalidate @submit.prevent="submitManual">
        <p class="dialog-copy">
          {{
            tr(
              '先验证福袋和任务条件，通过后参与。验证约需 20–28 秒，还可能等待导航间隔。',
              'The room is verified before joining. Checks take about 20–28 seconds, plus any navigation wait.'
            )
          }}
        </p>
        <div v-if="manualError" class="inline-notice error" role="alert">{{ manualError }}</div>
        <label class="field-label"
          >{{ tr('直播间地址', 'Room URL')
          }}<input
            v-model="manualUrl"
            type="url"
            autofocus
            :disabled="busy.addRoom"
            placeholder="https://live.douyin.com/12345678" /></label
        ><label class="field-label"
          >{{ tr('备注名称（可选）', 'Display name (optional)')
          }}<input
            v-model="manualName"
            :disabled="busy.addRoom"
            :placeholder="tr('便于下次找到这个房间', 'Make this room easier to recognize')"
        /></label>
      </form>
      <template #footer
        ><button v-if="busy.addRoom" class="button" :disabled="busy.stop" @click="cancelManual">
          {{ tr('取消验证并停止', 'Cancel verification and stop') }}</button
        ><button v-else class="button" @click="manualOpen = false">{{ tr('取消', 'Cancel') }}</button
        ><button
          class="button primary"
          type="submit"
          form="manual-room-form"
          :disabled="busy.addRoom || !manualUrl.trim()"
        >
          {{ busy.addRoom ? tr('正在验证…', 'Verifying…') : tr('验证并参与', 'Verify and join') }}
        </button></template
      >
    </UiDialog>
    <UiDialog
      :open="logoutOpen"
      :title="tr('退出当前账号', 'Sign out')"
      :busy="!!busy.logout"
      :close-label="tr('关闭', 'Close')"
      @close="logoutOpen = false"
      ><p class="dialog-copy">
        {{
          tr(
            '退出会停止当前计划并关闭工作页面。账号的历史记录和支出账本会保留。',
            'Signing out stops the plan and closes work pages. Account history and spending records are kept.'
          )
        }}
      </p>
      <template #footer
        ><button class="button" :disabled="busy.logout" @click="logoutOpen = false">
          {{ tr('取消', 'Cancel') }}</button
        ><button
          class="button primary"
          :disabled="busy.logout"
          @click="
            async () => {
              if (await logout()) logoutOpen = false
            }
          "
        >
          {{ busy.logout ? tr('正在退出…', 'Signing out…') : tr('退出账号', 'Sign out') }}
        </button></template
      ></UiDialog
    >
  </div>
</template>
