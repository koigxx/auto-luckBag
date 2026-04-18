<script setup lang="ts">
import type { Stats } from '../types'
import type { MessageKey } from '../composables/useI18n'

defineProps<{
  stats: Stats
  t: (key: MessageKey) => string
}>()
</script>

<template>
  <div class="stats-bar">
    <div class="stat-item">
      <span class="stat-label">{{ t('todayGrabbed') }}</span>
      <span class="stat-value">{{ stats.totalFudai }}</span>
    </div>
    <div class="divider"></div>
    <div class="stat-item">
      <span class="stat-label">{{ t('activeRooms') }}</span>
      <span class="stat-value">{{ stats.activeRooms }}</span>
    </div>
    <div class="divider"></div>
    <div class="stat-item">
      <span class="stat-label">{{ t('diamondBudget') }}</span>
      <span class="stat-value">{{ stats.diamondBudget }}</span>
    </div>
    <div class="divider"></div>
    <div class="stat-item">
      <span class="stat-label">{{ t('used') }}</span>
      <span class="stat-value used">{{ stats.diamondUsed }}</span>
    </div>
    <div class="divider"></div>
    <div class="stat-item">
      <span class="stat-label">{{ t('remainingBudget') }}</span>
      <span :class="['stat-value', stats.diamondRemaining <= 0 ? 'empty' : 'remaining']">
        {{ stats.diamondRemaining }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.stats-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  padding: 8px 16px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  overflow-x: auto;
}

.stat-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-shrink: 0;
}

.stat-label {
  font-size: 12px;
  color: #777;
}

.stat-value {
  font-size: 14px;
  font-weight: 600;
  color: #1f1f1f;
}

.stat-value.used {
  color: #fa8c16;
}

.stat-value.remaining {
  color: #52c41a;
}

.stat-value.empty {
  color: #ff4d4f;
}

.divider {
  width: 1px;
  height: 14px;
  background: #ececec;
  flex-shrink: 0;
}
</style>
