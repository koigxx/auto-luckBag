<script setup lang="ts">
import { ref } from 'vue'
import type { DiscoveredRoom } from '../types'
import type { MessageKey } from '../composables/useI18n'

defineProps<{
  rooms: DiscoveredRoom[]
  scanning: boolean
  status: string
  t: (key: MessageKey, params?: Record<string, string | number>) => string
}>()

const emit = defineEmits<{
  scan: [sourceUrl?: string]
  add: [room: DiscoveredRoom]
  addFastest: [sourceUrl?: string]
}>()

const sourceUrl = ref('')

function formatRemaining(seconds: number | null): string {
  if (seconds === null) return ''
  const minutes = Math.floor(seconds / 60)
  const restSeconds = seconds % 60
  if (minutes <= 0) return String(restSeconds)
  return `${minutes}:${restSeconds.toString().padStart(2, '0')}`
}

function handleScan() {
  emit('scan', sourceUrl.value.trim() || undefined)
}

function handleAddFastest() {
  emit('addFastest', sourceUrl.value.trim() || undefined)
}
</script>

<template>
  <div class="discovery-panel">
    <div class="panel-header">
      <span>{{ t('discovery') }}</span>
      <span class="hint">{{ t('countdownFirst') }}</span>
    </div>

    <div class="actions">
      <input
        v-model="sourceUrl"
        class="source-input"
        :placeholder="t('sourcePlaceholder')"
        @keyup.enter="handleScan"
      />
      <button class="btn btn-secondary" :disabled="scanning" @click="handleScan">
        {{ scanning ? t('scanning') : t('scan') }}
      </button>
      <button class="btn btn-primary" :disabled="scanning" @click="handleAddFastest">
        {{ t('addFastest') }}
      </button>
    </div>

    <div class="candidate-list">
      <div v-if="status" class="scan-status">{{ status }}</div>
      <div v-for="room in rooms" :key="room.url" class="candidate">
        <div class="candidate-main">
          <div class="candidate-title">{{ room.name }}</div>
          <div class="candidate-meta">
            <span>
              {{ t('remaining') }}
              {{
                room.remainingSeconds === null
                  ? t('unknown')
                  : room.remainingSeconds < 60
                    ? `${formatRemaining(room.remainingSeconds)}${t('seconds')}`
                    : formatRemaining(room.remainingSeconds)
              }}
            </span>
            <span>{{ t('matched') }} {{ room.reason }}</span>
          </div>
          <div class="candidate-text">{{ room.countdownText }}</div>
        </div>
        <button class="btn btn-add" @click="emit('add', room)">{{ t('add') }}</button>
      </div>
      <div v-if="rooms.length === 0" class="empty-hint">
        {{ t('discoveryEmpty') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.discovery-panel {
  background: #fff;
  border-radius: 8px;
  padding: 12px 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 15px;
  font-weight: 600;
  color: #1a1a1a;
  margin-bottom: 10px;
}

.hint {
  font-size: 12px;
  font-weight: normal;
  color: #999;
}

.actions {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.source-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  font-size: 13px;
}

.source-input:focus {
  outline: none;
  border-color: #fe2c55;
}

.btn {
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
  white-space: nowrap;
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.btn-primary {
  padding: 6px 14px;
  background: #fe2c55;
  color: #fff;
}

.btn-secondary {
  padding: 6px 14px;
  background: #f0f0f0;
  color: #555;
}

.btn-add {
  padding: 5px 12px;
  background: #fff0f3;
  color: #fe2c55;
  border: 1px solid #ffd6df;
}

.candidate-list {
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.scan-status {
  padding: 6px 8px;
  background: #f7f7f7;
  border: 1px solid #eeeeee;
  border-radius: 6px;
  color: #666;
  font-size: 12px;
}

.candidate {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 6px;
}

.candidate-main {
  min-width: 0;
  flex: 1;
}

.candidate-title {
  font-size: 13px;
  font-weight: 600;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.candidate-meta {
  display: flex;
  gap: 10px;
  margin-top: 2px;
  font-size: 12px;
  color: #777;
}

.candidate-text {
  margin-top: 2px;
  font-size: 12px;
  color: #aaa;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-hint {
  color: #bbb;
  font-size: 13px;
  text-align: center;
  padding: 14px;
}
</style>
