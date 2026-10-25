<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { LogEntry, RoomInfo } from '../types'
import { roomDisplayName } from '../../../shared/record-presentation'
import UiIcon from './UiIcon.vue'
const props = defineProps<{ logs: LogEntry[]; rooms: RoomInfo[]; language: string }>()
const emit = defineEmits<{ clear: [] }>()
const tr = (zh: string, en: string) => (props.language === 'en-US' ? en : zh)
const search = ref('')
const autoScroll = ref(true)
const container = ref<HTMLElement | null>(null)
const filtered = computed(() =>
  [...props.logs].reverse().filter((log) =>
    `${log.message} ${source(log)}`.toLowerCase().includes(search.value.toLowerCase())
  )
)
function source(log: LogEntry) {
  const id = log.roomId
  return (
    (log.roomName ? roomDisplayName(log.roomName, /^https?:/.test(log.roomName) ? log.roomName : props.rooms.find(room=>room.id===id)?.url || '', props.language==='en-US') : '') ||
    props.rooms.find((room) => room.id === id)?.name ||
    (
      {
        auto: tr('调度', 'Scheduler'),
        discover: tr('发现', 'Discovery'),
        system: tr('系统', 'System')
      } as Record<string, string>
    )[id] ||
    tr('直播间', 'Room')
  )
}
watch(
  () => props.logs,
  async () => {
    const el=container.value, top=el?.scrollTop??0, height=el?.scrollHeight??0
    await nextTick()
    if(el)el.scrollTop=autoScroll.value?0:top+Math.max(0,el.scrollHeight-height)
  }
)
watch(autoScroll, async following => { if(following){await nextTick();if(container.value)container.value.scrollTop=0} })
</script>

<template>
  <section class="surface log-view">
    <div class="data-toolbar">
      <label class="search-input"
        ><UiIcon name="search" :size="18" /><input
          v-model="search"
          type="search"
          :aria-label="tr('搜索日志', 'Search logs')"
          :placeholder="tr('搜索操作、房间或原因', 'Search actions, rooms or reasons')" /></label
      ><label class="checkbox-label"
        ><input v-model="autoScroll" type="checkbox" />{{ tr('跟随最新', 'Follow latest') }}</label
      ><button class="button small" :disabled="!logs.length" @click="emit('clear')">
        {{ tr('清空显示', 'Clear display') }}
      </button>
    </div>
    <p class="table-note">
      {{
        tr(
          '最新日志在最上方，保留本次打开应用后的最近 500 条。清空显示不会影响历史记录和预算。',
          'Newest events first; shows up to 500 events from this app session. Clearing the display does not change history or budgets.'
        )
      }}
    </p>
    <div
      ref="container"
      class="log-scroll"
      tabindex="0"
      :aria-label="tr('运行日志内容', 'Activity log entries')"
    >
      <div v-if="!filtered.length" class="empty-state page-empty">
        <span class="empty-icon"><UiIcon name="logs" :size="30" /></span>
        <h3>
          {{
            search
              ? tr('没有匹配的日志', 'No matching events')
              : tr('操作过程会记录在这里', 'Your activity will appear here')
          }}
        </h3>
        <p>
          {{
            tr(
              '启动后可查看发现、参与、休息和异常原因。',
              'Follow discovery, participation, breaks and errors after starting.'
            )
          }}
        </p>
      </div>
      <div v-for="(log, index) in filtered" :key="`${log.time}-${index}`" class="log-line">
        <time>{{ new Date(log.time).toLocaleTimeString(language, { hour12: false }) }}</time
        ><span class="log-source">{{ source(log) }}</span>
        <p>{{ log.message }}</p>
      </div>
    </div>
    <footer class="table-footer">
      <span>{{
        tr(
          `显示 ${filtered.length} / ${logs.length} 条`,
          `Showing ${filtered.length} of ${logs.length} events`
        )
      }}</span
      ><span>{{
        autoScroll ? tr('新日志自动回到顶部', 'Following newest events at the top') : tr('自动滚动已暂停', 'Auto-scroll paused')
      }}</span>
    </footer>
  </section>
</template>
