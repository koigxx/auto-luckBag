<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { AppConfig } from '../types'
import type { Policy } from '../../../shared/policy'
import { participationPreset, type ParticipationPreset } from '../../../shared/config'
import { validateConfigPatch } from '../../../shared/config-validation'
import UiIcon from './UiIcon.vue'
import UiDialog from './UiDialog.vue'

const props = defineProps<{
  config: AppConfig
  running: boolean
  saving: boolean
  onSave: (value: Partial<AppConfig>) => Promise<boolean | null>
  onResetBudget: () => Promise<boolean | null>
  resettingBudget: boolean
  canResetBudget: boolean
  budget?: import('../../../shared/insights').Insights['budget']
}>()
const emit = defineEmits<{ dirty: [value: boolean] }>()
const tr = (zh: string, en: string) => (props.config.language === 'en-US' ? en : zh)
const editable = (c: AppConfig) =>
  JSON.parse(
    JSON.stringify({
      fudaiTypes: c.fudaiTypes,
      diamondBudget: c.diamondBudget,
      allowDiamondProfit: c.allowDiamondProfit,
      debugLogs: c.debugLogs,
      scanIntervalSeconds: c.scanIntervalSeconds,
      enterBeforeSeconds: c.enterBeforeSeconds,
      candidatePoolLimit: c.candidatePoolLimit,
      policy: c.policy
    })
  ) as Pick<
    AppConfig,
    | 'fudaiTypes'
    | 'diamondBudget'
    | 'allowDiamondProfit'
    | 'debugLogs'
    | 'scanIntervalSeconds'
    | 'enterBeforeSeconds'
    | 'candidatePoolLimit'
    | 'policy'
  >
const draft = ref(editable(props.config))
function applyPreset(preset:ParticipationPreset){if(props.running||props.saving)return;Object.assign(draft.value,participationPreset(draft.value,preset));saved.value=false}
const baseline = ref(JSON.stringify(draft.value))
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)
const section = ref('preferences')
const error = ref('')
const saved = ref(false)
const resetBudgetOpen = ref(false)
async function confirmBudgetReset() {
  if (props.running || dirty.value || !props.canResetBudget || props.resettingBudget) return
  if (await props.onResetBudget()) resetBudgetOpen.value = false
}
const groups = [
  { id: 'preferences', icon: 'gift', zh: '参与偏好', en: 'Participation' },
  { id: 'budget', icon: 'diamond', zh: '支出与粉丝团', en: 'Spending & membership' },
  { id: 'schedule', icon: 'clock', zh: '运行与休息', en: 'Run & rest' },
  { id: 'advanced', icon: 'settings', zh: '高级设置', en: 'Advanced' }
]
type NumberField = {
  key: keyof Policy
  group: string
  zh: string
  en: string
  min: number
  max?: number
  step?: number
}
const fields: NumberField[] = [
  {
    key: 'dailySpend',
    group: 'budget',
    zh: '每天支出上限（钻）',
    en: 'Daily spending cap (diamonds)',
    min: 0
  },
  {
    key: 'anchorSpend',
    group: 'budget',
    zh: '每位主播累计上限（钻）',
    en: 'Lifetime cap per host (diamonds)',
    min: 0
  },
  {
    key: 'paymentLimit',
    group: 'budget',
    zh: '单次支付上限（钻）',
    en: 'Single payment cap (diamonds)',
    min: 0
  },
  { key: 'dailyNewClubs', group: 'budget', zh: '每天新开粉丝团上限', en: 'New memberships per day', min: 0 },
  {
    key: 'reinvestRatio',
    group: 'budget',
    zh: '已确认奖励可用比例（0–1）',
    en: 'Reward reinvestment ratio (0–1)',
    min: 0,
    max: 1,
    step: 0.1
  },
  {
    key: 'reinvestCap',
    group: 'budget',
    zh: '奖励追加额度上限（钻）',
    en: 'Reward credit cap (diamonds)',
    min: 0
  },
  {
    key: 'sessionMin',
    group: 'schedule',
    zh: '单段运行最短（分钟）',
    en: 'Minimum session (minutes)',
    min: 1,
    max: 240
  },
  {
    key: 'sessionMax',
    group: 'schedule',
    zh: '单段运行最长（分钟）',
    en: 'Maximum session (minutes)',
    min: 1,
    max: 240
  },
  { key: 'breakMin', group: 'schedule', zh: '休息最短（分钟）', en: 'Minimum break (minutes)', min: 1 },
  { key: 'breakMax', group: 'schedule', zh: '休息最长（分钟）', en: 'Maximum break (minutes)', min: 1 },
  {
    key: 'dailyMinutes',
    group: 'schedule',
    zh: '每天活跃时间上限（分钟）',
    en: 'Daily active limit (minutes)',
    min: 0
  },
  { key: 'maxRounds', group: 'schedule', zh: '同房连续参与轮数', en: 'Rounds per room visit', min: 1 },
  {
    key: 'maxStayMinutes',
    group: 'schedule',
    zh: '单房停留上限（分钟）',
    en: 'Maximum room stay (minutes)',
    min: 1
  },
  {
    key: 'nextRoundWaitSeconds',
    group: 'schedule',
    zh: '等待下一袋上限（秒）',
    en: 'Wait for next bag (seconds)',
    min: 5
  },
  {
    key: 'navigationMinSeconds',
    group: 'advanced',
    zh: '导航间隔最短（秒）',
    en: 'Minimum navigation gap (seconds)',
    min: 15,
    max: 600
  },
  {
    key: 'navigationMaxSeconds',
    group: 'advanced',
    zh: '导航间隔最长（秒）',
    en: 'Maximum navigation gap (seconds)',
    min: 15,
    max: 600
  },
  { key: 'newRoomsPerHour', group: 'advanced', zh: '每小时新房访问上限', en: 'New rooms per hour', min: 0 },
  {
    key: 'navigationsPerHour',
    group: 'advanced',
    zh: '每小时全部导航上限',
    en: 'All navigations per hour',
    min: 0
  },
  {
    key: 'actionsPerMinute',
    group: 'advanced',
    zh: '每分钟页面动作上限',
    en: 'Page actions per minute',
    min: 0
  },
  {
    key: 'explorationRatio',
    group: 'advanced',
    zh: '新房探索比例（0–1）',
    en: 'New-room exploration ratio (0–1)',
    min: 0,
    max: 1,
    step: 0.05
  }
]
const objectives = [
  {
    value: 'opportunity',
    icon: 'gift',
    zh: '参与机会',
    en: 'Opportunities',
    detail: ['按时间与任务条件选择机会', 'Balance opportunity, time and task effort']
  },
  {
    value: 'diamond',
    icon: 'diamond',
    zh: '钻石偏好',
    en: 'Diamonds',
    detail: ['在信息充足时估计钻石净增', 'Estimate net diamonds when data allows']
  },
  {
    value: 'physical',
    icon: 'rooms',
    zh: '实物偏好',
    en: 'Physical prizes',
    detail: ['优先选择已确认的实物福袋', 'Choose confirmed physical-prize bags']
  }
]
watch(
  dirty,
  (value) => {
    emit('dirty', value)
    if (value) saved.value = false
  },
  { immediate: true }
)
watch(
  () => JSON.stringify(editable(props.config)),
  () => {
    if (!dirty.value) restore()
  }
)
function restore() {
  draft.value = editable(props.config)
  baseline.value = JSON.stringify(draft.value)
  error.value = ''
  saved.value = false
}
function selectType(type: 'all' | 'physical' | 'diamond', value: boolean) {
  draft.value.fudaiTypes[type] = value
  if (type === 'all' && value) {
    draft.value.fudaiTypes.physical = false
    draft.value.fudaiTypes.diamond = false
  } else if (type !== 'all' && value) draft.value.fudaiTypes.all = false
}
async function invalid(group: string, message: string, id?: string) {
  section.value = group
  error.value = message
  await nextTick()
  document.getElementById(id || 'settings-error')?.focus()
}
async function save() {
  if (props.running || props.saving || !dirty.value) return
  error.value = ''
  if (!Object.values(draft.value.fudaiTypes).some(Boolean))
    return invalid('preferences', tr('至少选择一种福袋类型。', 'Select at least one prize type.'))
  for (const f of fields) {
    const value = draft.value.policy[f.key]
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < f.min ||
      value > (f.max ?? 100000) ||
      (!f.step && !Number.isInteger(value))
    )
      return invalid(
        f.group,
        tr(
          `请检查“${f.zh}”，范围为 ${f.min}–${f.max ?? 100000}${f.step ? '。' : '，请填写整数。'}`,
          `Check ${f.en}: use ${f.min}–${f.max ?? 100000}${f.step ? '.' : ' as a whole number.'}`
        ),
        `setting-${f.key}`
      )
  }
  for (const [min, max, group] of [
    ['sessionMin', 'sessionMax', 'schedule'],
    ['breakMin', 'breakMax', 'schedule'],
    ['navigationMinSeconds', 'navigationMaxSeconds', 'advanced']
  ] as const) {
    if (draft.value.policy[min] > draft.value.policy[max])
      return invalid(
        group,
        tr('最短时间不能大于最长时间。', 'The minimum interval cannot exceed the maximum.'),
        `setting-${min}`
      )
  }
  const simple = [
    ['diamondBudget', 0, 100000, 'budget'],
    ['scanIntervalSeconds', 30, 3600, 'advanced'],
    ['enterBeforeSeconds', 30, 600, 'advanced'],
    ['candidatePoolLimit', 1, 5, 'advanced']
  ] as const
  for (const [key, min, max, group] of simple)
    if (!Number.isInteger(draft.value[key]) || draft.value[key] < min || draft.value[key] > max)
      return invalid(
        group,
        tr(`请填写 ${min}–${max} 范围内的整数。`, `Enter a whole number between ${min} and ${max}.`),
        `setting-${key}`
      )
  if (
    ![draft.value.policy.allowedStart, draft.value.policy.allowedEnd].every((t) =>
      /^([01]\d|2[0-3]):[0-5]\d$/.test(t)
    )
  )
    return invalid('schedule', tr('请填写有效的开始和结束时间。', 'Enter valid start and end times.'))
  try {
    new Intl.DateTimeFormat('en', { timeZone: draft.value.policy.timezone }).format()
  } catch {
    return invalid(
      'schedule',
      tr('时区无效，例如 Asia/Shanghai。', 'Invalid time zone. For example: Asia/Shanghai.')
    )
  }
  try {
    const patch = validateConfigPatch(draft.value)
    if (await props.onSave(patch)) {
      baseline.value = JSON.stringify(draft.value)
      saved.value = true
    } else
      error.value = tr(
        '保存未成功，草稿已保留。请查看上方提示后重试。',
        'Not saved. Your draft is kept. Check the message above and retry.'
      )
  } catch (e: any) {
    error.value = e.message
  }
}
</script>

<template>
  <div class="settings-view">
  <form class="settings-layout surface" novalidate @submit.prevent="save">
    <nav class="settings-nav" :aria-label="tr('设置分组', 'Settings groups')">
      <button
        v-for="group in groups"
        :key="group.id"
        type="button"
        :class="{ selected: section === group.id }"
        :aria-pressed="section === group.id"
        @click="section = group.id"
      >
        <UiIcon :name="group.icon" :size="18" />{{ tr(group.zh, group.en) }}
      </button>
      <p>{{ tr('修改后统一保存', 'Save all changes together') }}</p>
    </nav>
    <div class="settings-content">
      <div v-if="running" class="inline-notice">
        <UiIcon name="info" :size="18" />{{
          tr(
            '计划运行或休息中，停止后可修改设置。',
            'Stop the current plan, including breaks, before editing.'
          )
        }}
      </div>
      <div v-if="error" id="settings-error" tabindex="-1" class="inline-notice error" role="alert">
        <UiIcon name="alert" :size="18" />{{ error }}
      </div>
      <fieldset :disabled="running || saving">
        <section v-show="section === 'preferences'" class="settings-section">
          <h3>{{tr('快捷方案','Quick presets')}}</h3>
          <div class="preset-options"><button v-for="item in [{id:'existing',label:'仅已有资格'},{id:'physical',label:'实物优先'},{id:'diamond',label:'钻石优先'},{id:'balanced',label:'全部均衡'}]" :key="item.id" type="button" class="button small" @click="applyPreset(item.id as ParticipationPreset)">{{item.label}}</button></div>
          <p class="microcopy">{{tr('方案仅调整参与偏好，保留现有预算、付费限制和运行节奏。检查后保存生效。','Presets change preferences only. Spending limits and pacing stay as configured. Review and save to apply.')}}</p>
          <h2>{{ tr('先选你更关注的机会', 'Choose what matters to you') }}</h2>
          <p class="section-description">
            {{
              tr(
                '数据不足时按任务与时间选择，不把估计当作中奖承诺。',
                'When data is missing, use task feasibility and time. Estimates are not guarantees.'
              )
            }}
          </p>
          <div class="choice-grid">
            <label
              v-for="item in objectives"
              :key="item.value"
              class="choice-tile"
              :class="{ selected: draft.policy.objective === item.value }"
              ><input
                v-model="draft.policy.objective"
                type="radio"
                name="objective"
                :value="item.value"
              /><UiIcon :name="item.icon" :size="23" /><strong>{{ tr(item.zh, item.en) }}</strong
              ><span>{{ tr(item.detail[0], item.detail[1]) }}</span></label
            >
          </div>
          <div class="form-divider" />
          <h3>{{ tr('参与哪些福袋', 'Prize types to join') }}</h3>
          <p class="section-description">
            {{
              tr(
                '实物和钻石可同时选择；全部还包含优惠券等已支持类型。',
                'Physical and diamond prizes can be combined. All also includes other supported types.'
              )
            }}
          </p>
          <div class="type-options">
            <label
              v-for="item in [
                { key: 'all', zh: '全部类型', en: 'All types' },
                { key: 'physical', zh: '实物福袋', en: 'Physical' },
                { key: 'diamond', zh: '钻石福袋', en: 'Diamonds' }
              ]"
              :key="item.key"
              :class="{ selected: draft.fudaiTypes[item.key as 'all' | 'physical' | 'diamond'] }"
              ><input
                type="checkbox"
                :checked="draft.fudaiTypes[item.key as 'all' | 'physical' | 'diamond']"
                @change="
                  selectType(
                    item.key as 'all' | 'physical' | 'diamond',
                    ($event.target as HTMLInputElement).checked
                  )
                "
              />{{ tr(item.zh, item.en) }}</label
            >
          </div>
          <div class="quiet-note">
            <UiIcon name="check" :size="17" />{{
              tr(
                '关注任务自动处理；评论只发送识别到的口令；分享任务跳过。',
                'Follow tasks are automatic; comments use recognized commands; share tasks are skipped.'
              )
            }}
          </div>
        </section>
        <section v-show="section === 'budget'" class="settings-section">
          <h2>{{ tr('先复用资格，再考虑支出', 'Reuse eligibility and control spending') }}</h2>
          <p class="section-description">
            {{
              tr(
                '预算由所有直播间共享。未决支付占用额度，免费任务不受剩余额度影响。',
                'All rooms share the budget. Unresolved payments reserve funds; free tasks remain eligible.'
              )
            }}
          </p>
          <label class="field-label prominent-field"
            >{{ tr('总钻石预算', 'Total diamond budget') }}
            <div class="input-suffix">
              <input
                id="setting-diamondBudget"
                :aria-label="tr('总钻石预算', 'Total diamond budget')"
                v-model.number="draft.diamondBudget"
                type="number"
                min="0"
                max="100000"
                step="1"
              /><span>{{ tr('钻', 'diamonds') }}</span>
            </div></label
          >
          <div class="quiet-note">
            <span>{{ tr('本轮已用', 'Cycle spent') }} {{ budget?.spent ?? config.diamondUsed }} ·
              {{ tr('累计支出', 'Lifetime spent') }} {{ budget?.lifetimeSpent ?? budget?.spent ?? config.diamondUsed }}</span>
            <button type="button" class="button" :disabled="running || saving || dirty || resettingBudget || !canResetBudget" @click="resetBudgetOpen = true">
              {{ tr('重置本轮预算', 'Reset cycle budget') }}
            </button>
          </div>
          <p v-if="budget?.hasActivity === false" class="microcopy">{{ tr('当前预算轮次尚无参与或支付记录，无需重复重置。', 'This budget cycle has no activity yet; no reset is needed.') }}</p>
          <p class="microcopy">{{ tr('停止运行并保存设置后可重置。本轮及每日已用归零，历史账单、主播累计和新开团数量限制保留；未决支付需先核对。', 'Stop and save settings before resetting. Cycle and daily spending reset; history, host caps and new-club counts remain. Reconcile pending payments first.') }}</p>
          <label class="field-label"
            >{{ tr('粉丝团付费策略', 'Membership spending policy')
            }}<select v-model="draft.policy.membership">
              <option value="existing">
                {{ tr('仅使用已有资格，不新增付费', 'Existing eligibility only, no new payments') }}
              </option>
              <option value="prefer">
                {{
                  tr(
                    '优先复用已有资格，首次发现也可在预算内付费',
                    'Reuse eligibility first; first-time rooms may be paid within budget'
                  )
                }}
              </option>
              <option value="whitelist">
                {{ tr('仅对已明确许可的主播付费', 'Payments only for explicitly permitted hosts') }}
              </option>
            </select></label
          >
          <p class="microcopy">
            {{
              tr(
                '首次发现且时间、任务和支出限制满足即可付费参与，无需重复验证两次；仅许可策略仍需在房间库授权。',
                'First-time rooms are eligible when time, tasks and spending limits permit. The permitted-hosts policy still requires room authorization.'
              )
            }}
          </p>
          <div class="form-divider" />
          <div class="form-grid">
            <label
              v-for="field in fields.filter((f) => f.group === 'budget' && !f.key.startsWith('reinvest'))"
              :key="field.key"
              class="field-label"
              >{{ tr(field.zh, field.en)
              }}<input
                :id="`setting-${field.key}`"
                v-model.number="draft.policy[field.key]"
                type="number"
                :min="field.min"
                :max="field.max ?? 100000"
                :step="field.step || 1"
            /></label>
          </div>
          <div class="toggle-row">
            <label
              ><input v-model="draft.allowDiamondProfit" type="checkbox" /><strong>{{
                tr('允许使用已确认钻石奖励', 'Allow confirmed diamond rewards to be reused')
              }}</strong></label
            >
            <p>
              {{ tr('开启后受以下比例和追加上限共同约束。', 'The ratio and credit cap below both apply.') }}
            </p>
          </div>
          <div v-if="draft.allowDiamondProfit" class="form-grid">
            <label
              v-for="field in fields.filter((f) => f.key.startsWith('reinvest'))"
              :key="field.key"
              class="field-label"
              >{{ tr(field.zh, field.en)
              }}<input
                :id="`setting-${field.key}`"
                v-model.number="draft.policy[field.key]"
                type="number"
                :min="field.min"
                :max="field.max ?? 100000"
                :step="field.step || 1"
            /></label>
          </div>
        </section>
        <section v-show="section === 'schedule'" class="settings-section">
          <h2>{{ tr('安排运行，也留出休息', 'Set a pace with room for breaks') }}</h2>
          <p class="section-description">
            {{
              tr(
                '每段开始时选定运行时长，休息期间关闭工作页面。',
                'A session duration is chosen at the start. Work pages close during breaks.'
              )
            }}
          </p>
          <div class="form-grid">
            <label
              v-for="field in fields.filter((f) => f.group === 'schedule')"
              :key="field.key"
              class="field-label"
              >{{ tr(field.zh, field.en)
              }}<input
                :id="`setting-${field.key}`"
                v-model.number="draft.policy[field.key]"
                type="number"
                :min="field.min"
                :max="field.max ?? 100000"
                step="1"
            /></label>
          </div>
          <div class="form-divider" />
          <h3>{{ tr('允许运行的时间', 'Allowed operating hours') }}</h3>
          <div class="form-grid">
            <label class="field-label"
              >{{ tr('开始时间', 'From') }}<input v-model="draft.policy.allowedStart" type="time" /></label
            ><label class="field-label"
              >{{ tr('结束时间', 'Until') }}<input v-model="draft.policy.allowedEnd" type="time" /></label
            ><label class="field-label"
              >{{ tr('运行时区', 'Time zone')
              }}<input v-model="draft.policy.timezone" placeholder="Asia/Shanghai"
            /></label>
          </div>
          <p class="microcopy">
            {{
              tr(
                '开始与结束相同表示全天；支持跨午夜。',
                'Equal start and end means all day. Overnight ranges are supported.'
              )
            }}
          </p>
          <div class="toggle-row">
            <label
              ><input v-model="draft.policy.autoResume" type="checkbox" /><strong>{{
                tr('计划休息结束后自动恢复', 'Resume automatically after a planned break')
              }}</strong></label
            >
            <p>
              {{
                tr(
                  '恢复前重新检查运行条件；手动停止、应用重启或风险阻断不会自动恢复。',
                  'Conditions are checked before resuming. Manual stops, app restarts and risk holds never auto-resume.'
                )
              }}
            </p>
          </div>
        </section>
        <section v-show="section === 'advanced'" class="settings-section">
          <h2>{{ tr('发现与操作节奏', 'Discovery and action limits') }}</h2>
          <p class="section-description">
            {{
              tr(
                '按顺序验证房间，证据齐全即可结束。任务准备窗口不含返房耗时：系统会另外预留加载30秒、复验12秒和调度3秒，更早开始返房；复杂任务可能需要更长准备时间。',
                'Verify rooms in order. The task window excludes return preparation: allow another 30 seconds for loading, 12 for revalidation and 3 for scheduling. Complex tasks may need more time.'
              )
            }}
          </p>
          <div class="form-grid">
            <label class="field-label"
              >{{ tr('首页重复扫描间隔（秒）', 'Source rescan interval (seconds)')
              }}<input
                id="setting-scanIntervalSeconds"
                v-model.number="draft.scanIntervalSeconds"
                type="number"
                min="30"
                max="3600" /></label
            ><label class="field-label"
              >{{ tr('开奖前任务准备窗口（秒）', 'Task preparation window (seconds)')
              }}<input
                id="setting-enterBeforeSeconds"
                v-model.number="draft.enterBeforeSeconds"
                type="number"
                min="30"
                max="600" /></label
            ><label class="field-label"
              >{{ tr('候选池上限', 'Candidate pool limit')
              }}<input
                id="setting-candidatePoolLimit"
                v-model.number="draft.candidatePoolLimit"
                type="number"
                min="1"
                max="5" /></label
            ><label
              v-for="field in fields.filter((f) => f.group === 'advanced')"
              :key="field.key"
              class="field-label"
              >{{ tr(field.zh, field.en)
              }}<input
                :id="`setting-${field.key}`"
                v-model.number="draft.policy[field.key]"
                type="number"
                :min="field.min"
                :max="field.max ?? 100000"
                :step="field.step || 1"
            /></label>
          </div>
          <div class="toggle-row">
            <label
              ><input v-model="draft.debugLogs" type="checkbox" /><strong>{{
                tr('调试日志', 'Debug logging')
              }}</strong></label
            >
          </div>
        </section>
      </fieldset>
    </div>
    <footer class="settings-footer">
      <span :class="{ 'unsaved-label': dirty }"
        ><UiIcon :name="dirty ? 'info' : 'check'" :size="16" />{{
          dirty
            ? tr('有未保存的更改', 'You have unsaved changes')
            : saved
              ? tr('已保存，下次运行生效', 'Saved for the next run')
              : tr('当前为已保存设置', 'Showing saved settings')
        }}</span
      >
      <div>
        <button type="button" class="button" :disabled="!dirty || running || saving" @click="restore">
          {{ tr('还原更改', 'Discard changes') }}</button
        ><button type="submit" class="button primary" :disabled="!dirty || running || saving">
          {{ saving ? tr('正在保存…', 'Saving…') : tr('保存设置', 'Save settings') }}
        </button>
      </div>
    </footer>
  </form>
  <UiDialog :open="resetBudgetOpen" :title="tr('开始新一轮预算', 'Start a new budget cycle')" :busy="resettingBudget" @close="resetBudgetOpen = false">
    <p>{{ tr('重置后，本轮已用归零，基础可用额度恢复为', 'Cycle spending will reset and base funds will return to') }} {{ config.diamondBudget }} {{ tr('钻。历史支出和中奖记录保留，旧轮奖励不再计入新轮预算。', 'diamonds. Payment and award history stay; earlier awards do not fund this cycle.') }}</p>
    <p>{{ tr('每日已用同时归零，每日支出额度恢复为', 'Daily spending also resets, restoring the daily allowance to') }} {{ config.policy.dailySpend }} {{ tr('钻。单主播累计上限和每日新开团数量不重置。', 'diamonds. Host spending and daily new-club counts do not reset.') }}</p>
    <template #footer>
      <button type="button" class="button" :disabled="resettingBudget" @click="resetBudgetOpen = false">{{ tr('取消', 'Cancel') }}</button>
      <button type="button" class="button primary" :disabled="running || dirty || resettingBudget || !canResetBudget" @click="confirmBudgetReset">{{ resettingBudget ? tr('正在重置…', 'Resetting…') : tr('确认重置预算', 'Confirm budget reset') }}</button>
    </template>
  </UiDialog>
  </div>
</template>
