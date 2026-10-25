<script setup lang="ts">
import { roomDisplayName } from '../../../shared/record-presentation'
import { computed, ref, watch } from 'vue'
import type { Insights } from '../../../shared/insights'
import type { Policy, RoomProfile } from '../../../shared/policy'
import UiIcon from './UiIcon.vue'
const props = defineProps<{
  data: Insights; running: boolean; language: string; membership: Policy['membership']
  busy: Record<string, boolean>
  onAction: (key: string, fn: () => Promise<{success: boolean; error?: string}>) => Promise<boolean | null>
}>()
const emit = defineEmits<{ add: [] }>()
const tr = (zh: string, en: string) => props.language === 'en-US' ? en : zh
const search = ref(''), filter = ref('all'), page = ref(1)
const summaries = computed(() => {
  const result = new Map<string, {confirmed: number; won: number; spent: number}>()
  for (const r of props.data.rooms) result.set(r.url, {confirmed: 0, won: 0, spent: 0})
  for (const r of props.data.rounds) {
    const s = result.get(r.roomUrl)
    if (s && r.confirmedAt != null) { s.confirmed++; if (r.result === 'won') s.won++ }
  }
  for (const p of props.data.payments) if (p.state === 'confirmed') {
    const s = result.get(p.roomUrl); if (s) s.spent += p.cost
  }
  return result
})
const blocked = computed(() => props.data.rooms.filter(r => r.blocked).length)
const participated = computed(() => props.data.rooms.filter(r => summaries.value.get(r.url)!.confirmed > 0).length)
const rooms = computed(() => props.data.rooms.filter(r =>
  `${r.name} ${r.url}`.toLowerCase().includes(search.value.trim().toLowerCase()) &&
  (filter.value === 'all' || (filter.value === 'blocked' ? r.blocked : filter.value === 'participated' ? summaries.value.get(r.url)!.confirmed > 0 : r.failures > 0))
).slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt))
const pages = computed(() => Math.max(1, Math.ceil(rooms.value.length / 15)))
watch([search, filter], () => page.value = 1)
watch(pages, n => page.value = Math.min(n, page.value))
const time = (at: number) => at ? new Date(at).toLocaleString(props.language, {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}) : '—'
const policyText = computed(() => props.membership === 'prefer'
  ? tr('自动判断付费 · 每轮检查资格、金额和预算', 'Automatic payment checks · eligibility, price and budget every round')
  : props.membership === 'existing'
    ? tr('仅已有资格 · 不新增费用', 'Existing eligibility only · no new spending')
    : tr('仅历史许可房间 · 继续遵守原许可范围和预算', 'Previously permitted rooms only · existing permissions and budget apply'))
const blockedAction = (r: RoomProfile) => props.onAction(`profile:${r.url}`, () => window.api.insights.room(r.url, {blocked: !r.blocked}))
const held = computed(() => props.data.payments.some(p => p.state === 'unresolved') || props.data.risks.some(r => r.resolvedAt === null))
</script>

<template>
  <section class="surface room-library">
    <header class="library-heading">
      <div><h2>{{ tr('房间历史', 'Room history') }} <span class="count-label">{{ data.rooms.length }}</span></h2><p>{{ policyText }}</p></div>
      <button class="button" :disabled="running || busy.addRoom || held" @click="emit('add')"><UiIcon name="plus" :size="16" />{{ tr('手动参与','Join a room') }}</button>
    </header>
    <div class="library-tools">
      <div class="library-tabs" :aria-label="tr('房间筛选','Filter rooms')">
        <button v-for="item in [{id:'all',label:tr('全部','All'),count:data.rooms.length},{id:'participated',label:tr('参与过','Entered'),count:participated},{id:'blocked',label:tr('已屏蔽','Blocked'),count:blocked},{id:'failed',label:tr('验证受阻','Check issues'),count:data.rooms.filter(r=>r.failures>0).length}]" :key="item.id" :aria-pressed="filter===item.id" :class="{selected:filter===item.id}" @click="filter=item.id">{{ item.label }} <span>{{ item.count }}</span></button>
      </div>
      <label class="search-input"><UiIcon name="search" :size="17" /><input v-model="search" type="search" :aria-label="tr('搜索房间','Search rooms')" :placeholder="tr('搜索房间名称或地址','Search name or URL')" /></label>
    </div>
    <p class="library-explainer">{{ tr('按最近发现排序。历史资格仅供参考，返房时重新验证；复访与付费由策略自动判断。','Newest observations first. Historical eligibility is rechecked on return; policy determines revisits and payment.') }} <span v-if="running">{{ tr('运行中暂不可修改屏蔽。','Blocking is read-only during a run.') }}</span></p>
    <div v-if="!rooms.length" class="empty-state page-empty"><UiIcon name="rooms" :size="28" /><h3>{{ tr('没有匹配的房间','No matching rooms') }}</h3><p>{{ tr('运行中发现的房间会自动保存在这里。','Rooms discovered during runs are saved here automatically.') }}</p></div>
    <div v-else class="room-history-list">
      <article v-for="room in rooms.slice((page-1)*15,page*15)" :key="room.url" class="room-history-row" :class="{blocked:room.blocked}">
        <div class="room-history-main">
          <span class="room-avatar" aria-hidden="true">{{ roomDisplayName(room.name,room.url,language==='en-US').slice(0,1) }}</span>
          <div class="room-history-name"><strong>{{ roomDisplayName(room.name,room.url,language==='en-US') }}</strong><small>{{ tr('最近发现','Last seen') }} {{ time(room.lastSeenAt) }}</small></div>
          <span class="status-pill" :class="room.blocked?'neutral':room.failures?'warning':'neutral'">{{ room.blocked?tr('已屏蔽','Blocked'):room.failures?tr('验证受阻','Check issue'):room.visits.length?tr('已验证','Checked'):tr('待验证','Not checked') }}</span>
        </div>
        <div class="room-history-stats"><span>{{ tr('确认参与','Confirmed') }} <b>{{ summaries.get(room.url)!.confirmed }}</b></span><span>{{ tr('中奖','Won') }} <b>{{ summaries.get(room.url)!.won }}</b></span><span>{{ tr('确认支出','Spent') }} <b>{{ summaries.get(room.url)!.spent }}</b> {{ tr('钻','♦') }}</span></div>
        <details class="room-history-detail">
          <summary>{{ tr('验证详情','Check details') }}</summary>
          <dl><div><dt>{{ tr('验证中发现福袋','Checks with a bag') }}</dt><dd>{{ room.visits.filter(v=>v.found).length }} / {{ room.visits.length }}</dd></div><div><dt>{{ tr('最早可复访','Earliest revisit') }}</dt><dd>{{ room.blocked ? tr('已屏蔽','Blocked') : time(room.nextEligibleCheckAt) }}</dd></div><div><dt>{{ tr('上次观察到的资格','Last observed eligibility') }}</dt><dd>{{ room.membership==='satisfied'?tr('满足当时条件','Eligible at that time'):room.membership==='needs-payment'?tr('当时需新增费用','Payment needed at that time'):tr('未确认满足','Not confirmed') }} · {{ time(room.membershipAt) }}</dd></div></dl>
          <p class="microcopy">{{ tr('可复访时间不是预约时间，是否返回由队列、资格与运行节奏共同决定。','Earliest revisit is not a booking. The queue, eligibility and run limits determine when to return.') }}</p>
          <p v-if="membership==='whitelist'" class="microcopy">{{ room.allowPaid?tr('历史许可：已许可；仍需逐轮通过费用检查。','Historical permission: allowed; payment checks still apply.'):tr('历史许可：未许可；不会新增付费。','Historical permission: not allowed; no new payments.') }}</p>
          <p class="room-address">{{ room.url }}</p>
        </details>
        <button class="button text-button small room-block" :disabled="running || busy[`profile:${room.url}`]" :aria-label="`${room.name} ${room.blocked?tr('取消屏蔽','Unblock'):tr('屏蔽','Block')}`" @click="blockedAction(room)">{{ room.blocked?tr('取消屏蔽','Unblock'):tr('屏蔽','Block') }}</button>
      </article>
    </div>
    <footer class="table-footer"><span>{{ tr(`共 ${rooms.length} 个房间`,`${rooms.length} rooms`) }}</span><div><button class="button small" :disabled="page<=1" @click="page--">{{ tr('上一页','Previous') }}</button><span>{{ page }} / {{ pages }}</span><button class="button small" :disabled="page>=pages" @click="page++">{{ tr('下一页','Next') }}</button></div></footer>
  </section>
</template>
