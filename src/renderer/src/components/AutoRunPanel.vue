<script setup lang="ts">
import { ref } from 'vue'
import type { AutoRunState, RunStats } from '../types'
import type { MessageKey } from '../composables/useI18n'

defineProps<{
  state: AutoRunState | null
  stats: RunStats | null
  t: (key: MessageKey, params?: Record<string, string | number>) => string
}>()

const emit = defineEmits<{
  start: [options: {
    sourceUrl?: string
    scanIntervalSeconds?: number
    stopAfterMinutes?: number
    enterBeforeSeconds?: number
    candidatePoolLimit?: number
  }]
  stop: []
  resetStats: []
}>()

const sourceUrl = ref('')
const scanIntervalSeconds = ref(40)
const enterBeforeSeconds = ref(75)
const candidatePoolLimit = ref(4)
const stopAfterMinutes = ref<number | null>(null)

function handleStart() {
  emit('start', {
    sourceUrl: sourceUrl.value.trim() || undefined,
    scanIntervalSeconds: scanIntervalSeconds.value,
    enterBeforeSeconds: Math.max(60, enterBeforeSeconds.value || 75),
    candidatePoolLimit: Math.min(5, Math.max(1, candidatePoolLimit.value || 4)),
    stopAfterMinutes: stopAfterMinutes.value || undefined
  })
}

function formatTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '-'
  const date = new Date(timestamp)
  return `${date.getHours().toString().padStart(2, '0')}:${date
    .getMinutes()
    .toString()
    .padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`
}

function formatRemaining(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '-'
  const minutes = Math.floor(Math.max(0, seconds) / 60)
  const rest = Math.max(0, seconds) % 60
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`
}
</script>

<template>
  <div class="auto-run-panel">
    <div class="panel-header">
      <span>{{ t('autoRun') }}</span>
      <span :class="['run-state', state?.running ? 'running' : 'stopped']">
        {{ state?.running ? t('running') : t('stopped') }}
      </span>
    </div>

    <div class="controls">
      <input
        v-model="sourceUrl"
        class="source-input"
        :placeholder="t('sourcePlaceholder')"
        :disabled="state?.running"
      />
      <label class="field">
        <span>{{ t('scanInterval') }}</span>
        <input
          v-model.number="scanIntervalSeconds"
          type="number"
          min="30"
          step="10"
          :disabled="state?.running"
        />
      </label>
      <label class="field">
        <span>{{ t('enterBefore') }}</span>
        <input
          v-model.number="enterBeforeSeconds"
          type="number"
          min="75"
          step="10"
          :disabled="state?.running"
        />
      </label>
      <label class="field">
        <span>{{ t('candidatePoolLimit') }}</span>
        <input
          v-model.number="candidatePoolLimit"
          type="number"
          min="1"
          max="5"
          step="1"
          :disabled="state?.running"
        />
      </label>
      <label class="field">
        <span>{{ t('stopAfter') }}</span>
        <input
          v-model.number="stopAfterMinutes"
          type="number"
          min="1"
          :placeholder="t('unlimited')"
          :disabled="state?.running"
        />
      </label>
      <button v-if="!state?.running" class="btn btn-primary" @click="handleStart">
        {{ t('start') }}
      </button>
      <button v-else class="btn btn-danger" @click="emit('stop')">{{ t('stop') }}</button>
    </div>

    <div class="dashboard">
      <div class="metric">
        <span>{{ t('participated') }}</span>
        <strong>{{ stats?.participated ?? 0 }}</strong>
      </div>
      <div class="metric">
        <span>{{ t('physicalWins') }}</span>
        <strong>{{ stats?.physicalWins ?? 0 }}</strong>
      </div>
      <div class="metric">
        <span>{{ t('diamondWins') }}</span>
        <strong>{{ stats?.diamondWins ?? 0 }}</strong>
      </div>
      <div class="metric muted">
        <span>{{ t('couponWins') }}</span>
        <strong>{{ stats?.couponWins ?? 0 }}</strong>
      </div>
      <div class="metric">
        <span>{{ t('winsTotal') }}</span>
        <strong>{{ (stats?.physicalWins ?? 0) + (stats?.diamondWins ?? 0) }}</strong>
      </div>
      <div class="metric">
        <span>{{ t('nextScan') }}</span>
        <strong>{{ formatTime(state?.nextScanAt) }}</strong>
      </div>
      <div class="metric">
        <span>{{ t('candidates') }}</span>
        <strong>{{ state?.candidateCount ?? 0 }}</strong>
      </div>
      <div class="metric">
        <span>{{ t('pendingVerify') }}</span>
        <strong>{{ state?.pendingVerifyCount ?? 0 }}</strong>
      </div>
      <div v-if="state?.riskPausedUntil" class="metric muted">
        <span>{{ t('riskPaused') }}</span>
        <strong>{{ formatTime(state.riskPausedUntil) }}</strong>
      </div>
      <button class="btn btn-secondary" @click="emit('resetStats')">{{ t('resetStats') }}</button>
    </div>

    <div v-if="state?.candidates?.length" class="candidate-list">
      <div v-for="room in state.candidates.slice(0, 6)" :key="room.url" class="candidate-row">
        <span class="candidate-name" :title="room.name">{{ room.name }}</span>
        <span class="candidate-score">S{{ room.score }}</span>
        <span class="candidate-time">{{ formatRemaining(room.remainingSeconds) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auto-run-panel {
  background: #fff;
  border-radius: 8px;
  padding: 12px 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 15px;
  font-weight: 600;
  color: #1a1a1a;
  margin-bottom: 10px;
}

.run-state {
  font-size: 12px;
  font-weight: normal;
  padding: 2px 8px;
  border-radius: 4px;
}

.run-state.running {
  color: #52c41a;
  background: #f6ffed;
  border: 1px solid #b7eb8f;
}

.run-state.stopped {
  color: #999;
  background: #f5f5f5;
  border: 1px solid #d9d9d9;
}

.controls {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
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

.field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #666;
}

.field input {
  width: 72px;
  padding: 5px 8px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
}

.btn {
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  padding: 6px 12px;
  white-space: nowrap;
}

.btn-primary {
  background: #fe2c55;
  color: #fff;
}

.btn-danger {
  background: #ff4d4f;
  color: #fff;
}

.btn-secondary {
  background: #f0f0f0;
  color: #555;
}

.dashboard {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
  align-items: stretch;
}

.metric {
  min-width: 0;
  padding: 8px;
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 6px;
}

.metric span {
  display: block;
  color: #777;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric strong {
  display: block;
  margin-top: 3px;
  color: #1f1f1f;
  font-size: 16px;
}

.metric.muted strong {
  color: #999;
}

.candidate-list {
  margin-top: 10px;
  display: grid;
  gap: 6px;
}

.candidate-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px 64px;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  background: #fff7f0;
  border: 1px solid #ffd8bf;
  border-radius: 6px;
  font-size: 12px;
}

.candidate-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.candidate-score,
.candidate-time {
  color: #ad4e00;
  text-align: right;
  white-space: nowrap;
}
</style>
