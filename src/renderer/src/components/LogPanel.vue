<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import type { LogEntry } from '../types'
import type { MessageKey } from '../composables/useI18n'

const props = defineProps<{
  logs: LogEntry[]
  t: (key: MessageKey) => string
}>()

const logContainer = ref<HTMLElement | null>(null)

// 自动滚动到底部
watch(
  () => props.logs.length,
  async () => {
    await nextTick()
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight
    }
  }
)

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}
</script>

<template>
  <div class="log-panel">
    <div class="panel-header">{{ t('logs') }}</div>
    <div ref="logContainer" class="log-content">
      <div v-for="(log, index) in logs" :key="index" class="log-entry">
        <span class="log-time">{{ formatTime(log.time) }}</span>
        <span class="log-room">[{{ log.roomId.substring(0, 6) }}]</span>
        <span class="log-message">{{ log.message }}</span>
      </div>
      <div v-if="logs.length === 0" class="empty-hint">{{ t('logsEmpty') }}</div>
    </div>
  </div>
</template>

<style scoped>
.log-panel {
  background: #fff;
  border-radius: 8px;
  padding: 12px 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  height: 180px;
  display: flex;
  flex-direction: column;
}

.panel-header {
  font-size: 15px;
  font-weight: 600;
  color: #1a1a1a;
  margin-bottom: 8px;
}

.log-content {
  flex: 1;
  overflow-y: auto;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
}

.log-entry {
  display: flex;
  gap: 6px;
  padding: 1px 0;
}

.log-time {
  color: #999;
  flex-shrink: 0;
}

.log-room {
  color: #1890ff;
  flex-shrink: 0;
}

.log-message {
  color: #333;
  word-break: break-all;
}

.empty-hint {
  color: #bbb;
  text-align: center;
  padding: 20px;
}
</style>
