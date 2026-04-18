<script setup lang="ts">
import type { AppConfig, FudaiTypes } from '../types'
import type { MessageKey } from '../composables/useI18n'

const props = defineProps<{
  config: AppConfig
  t: (key: MessageKey) => string
}>()

const emit = defineEmits<{
  update: [config: Partial<AppConfig>]
  resetDiamond: []
}>()

function toggleFudaiType(key: keyof FudaiTypes) {
  const newTypes = { ...props.config.fudaiTypes }

  // 如果点击的是"全部"，设为全部启用或全部禁用
  if (key === 'all') {
    const newVal = !newTypes.all
    newTypes.all = newVal
    newTypes.physical = newVal
    newTypes.diamond = newVal
    newTypes.other = newVal
  } else {
    newTypes[key] = !newTypes[key]
    // 如果所有子项都选中，则all也选中；否则all取消
    newTypes.all = newTypes.physical && newTypes.diamond && newTypes.other
  }

  emit('update', { fudaiTypes: newTypes })
}

function updateBudget(value: string) {
  const num = parseInt(value, 10)
  if (!isNaN(num) && num >= 0) {
    emit('update', { diamondBudget: num })
  }
}
</script>

<template>
  <div class="config-panel">
    <div class="panel-header">{{ t('config') }}</div>
    <div class="config-items">
      <div class="config-item">
        <label>{{ t('fudaiTypes') }}</label>
        <div class="checkbox-group">
          <label class="checkbox-label">
            <input type="checkbox" :checked="config.fudaiTypes.all" @change="toggleFudaiType('all')" />
            {{ t('all') }}
          </label>
          <label class="checkbox-label">
            <input type="checkbox" :checked="config.fudaiTypes.physical" @change="toggleFudaiType('physical')" />
            {{ t('physical') }}
          </label>
          <label class="checkbox-label">
            <input type="checkbox" :checked="config.fudaiTypes.diamond" @change="toggleFudaiType('diamond')" />
            {{ t('diamond') }}
          </label>
          <label class="checkbox-label">
            <input type="checkbox" :checked="config.fudaiTypes.other" @change="toggleFudaiType('other')" />
            {{ t('other') }}
          </label>
        </div>
      </div>
      <div class="config-item">
        <label>{{ t('badgeBudget') }}</label>
        <div class="budget-control">
          <input
            type="number"
            class="budget-input"
            :value="config.diamondBudget"
            min="0"
            @change="updateBudget(($event.target as HTMLInputElement).value)"
          />
          <span class="budget-info">
            {{ t('used') }}: {{ config.diamondUsed }}
            <button class="btn-link" @click="emit('resetDiamond')">{{ t('reset') }}</button>
          </span>
        </div>
      </div>
      <div class="config-item">
        <label>{{ t('autoFollow') }}</label>
        <span class="enabled-tag">{{ t('enabled') }}</span>
      </div>
      <div class="config-item">
        <label>{{ t('debugLogs') }}</label>
        <label class="checkbox-label">
          <input
            type="checkbox"
            :checked="config.debugLogs"
            @change="emit('update', { debugLogs: ($event.target as HTMLInputElement).checked })"
          />
          {{ config.debugLogs ? t('enabled') : '-' }}
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.config-panel {
  background: #fff;
  border-radius: 8px;
  padding: 12px 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.panel-header {
  font-size: 15px;
  font-weight: 600;
  color: #1a1a1a;
  margin-bottom: 10px;
}

.config-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.config-item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.config-item > label {
  font-size: 13px;
  color: #666;
  min-width: 90px;
}

.checkbox-group {
  display: flex;
  gap: 16px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  cursor: pointer;
}

.checkbox-label input {
  cursor: pointer;
}

.budget-control {
  display: flex;
  align-items: center;
  gap: 10px;
}

.budget-input {
  width: 70px;
  padding: 4px 8px;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  font-size: 13px;
  text-align: center;
}

.budget-input:focus {
  outline: none;
  border-color: #fe2c55;
}

.budget-info {
  font-size: 12px;
  color: #999;
}

.btn-link {
  background: none;
  border: none;
  color: #fe2c55;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}

.enabled-tag {
  font-size: 12px;
  color: #52c41a;
  background: #f6ffed;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid #b7eb8f;
}
</style>
