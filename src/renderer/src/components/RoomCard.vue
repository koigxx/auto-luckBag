<script setup lang="ts">
import type { RoomInfo } from '../types'
import type { MessageKey } from '../composables/useI18n'

defineProps<{
  room: RoomInfo
  t: (key: MessageKey) => string
}>()

const emit = defineEmits<{
  remove: [roomId: string]
}>()

function statusClass(status: RoomInfo['status']): string {
  const map: Record<string, string> = {
    monitoring: 'status-monitoring',
    grabbing: 'status-grabbing',
    loading: 'status-loading',
    error: 'status-error',
    idle: 'status-idle'
  }
  return map[status] || ''
}

function statusLabel(status: RoomInfo['status'], t: (key: MessageKey) => string): string {
  const map: Record<RoomInfo['status'], MessageKey> = {
    loading: 'statusLoading',
    monitoring: 'statusMonitoring',
    grabbing: 'statusGrabbing',
    error: 'statusError',
    idle: 'statusIdle'
  }
  return t(map[status])
}

function formatRemaining(seconds: number | null): string {
  if (seconds === null) return '-'
  const minutes = Math.floor(seconds / 60)
  const restSeconds = seconds % 60
  if (minutes <= 0) return `${restSeconds}s`
  return `${minutes}:${restSeconds.toString().padStart(2, '0')}`
}
</script>

<template>
  <div class="room-card">
    <div class="card-header">
      <span class="room-name">{{ room.name }}</span>
      <button class="btn-remove" @click="emit('remove', room.id)" :title="t('remove')">
        &times;
      </button>
    </div>
    <div class="card-body">
      <span :class="['status-badge', statusClass(room.status)]">
        {{ statusLabel(room.status, t) }}
      </span>
      <span v-if="room.hasFanBadge" class="fan-badge">{{ t('hasFanBadge') }}</span>
    </div>
    <div class="card-footer">
      <span class="fudai-count">{{ t('grabbed') }}: {{ room.fudaiCount }}</span>
      <span class="countdown">{{ t('drawIn') }}: {{ formatRemaining(room.remainingSeconds) }}</span>
    </div>
  </div>
</template>

<style scoped>
.room-card {
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  padding: 10px 12px;
  min-width: 140px;
  max-width: 180px;
  transition: all 0.2s;
}

.room-card:hover {
  border-color: #fe2c55;
  box-shadow: 0 2px 6px rgba(254, 44, 85, 0.1);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.room-name {
  font-size: 13px;
  font-weight: 500;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100px;
}

.btn-remove {
  background: none;
  border: none;
  font-size: 18px;
  color: #ccc;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
}

.btn-remove:hover {
  color: #ff4d4f;
}

.card-body {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.status-badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
}

.status-monitoring {
  background: #f6ffed;
  color: #52c41a;
  border: 1px solid #b7eb8f;
}

.status-grabbing {
  background: #fff7e6;
  color: #fa8c16;
  border: 1px solid #ffd591;
  animation: pulse 1s infinite;
}

.status-loading {
  background: #e6f7ff;
  color: #1890ff;
  border: 1px solid #91d5ff;
}

.status-error {
  background: #fff2f0;
  color: #ff4d4f;
  border: 1px solid #ffccc7;
}

.status-idle {
  background: #f5f5f5;
  color: #999;
  border: 1px solid #d9d9d9;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}

.fan-badge {
  font-size: 11px;
  color: #fe2c55;
  background: #fff0f3;
  padding: 1px 4px;
  border-radius: 3px;
}

.card-footer {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: #999;
}

.countdown {
  color: #fe2c55;
}
</style>
