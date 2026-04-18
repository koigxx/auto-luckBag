<script setup lang="ts">
import type { Language } from '../composables/useI18n'
import type { MessageKey } from '../composables/useI18n'

defineProps<{
  isLoggedIn: boolean
  language: Language
  t: (key: MessageKey) => string
}>()

const emit = defineEmits<{
  login: []
  logout: []
  updateLanguage: [language: Language]
}>()
</script>

<template>
  <div class="login-bar">
    <div class="title">{{ t('appTitle') }}</div>
    <div class="login-status">
      <label class="language-control">
        <span>{{ t('language') }}</span>
        <select
          :value="language"
          @change="emit('updateLanguage', ($event.target as HTMLSelectElement).value as Language)"
        >
          <option value="zh-CN">{{ t('chinese') }}</option>
          <option value="en-US">{{ t('english') }}</option>
        </select>
      </label>
      <span :class="['status-dot', isLoggedIn ? 'online' : 'offline']"></span>
      <span class="status-text">{{ isLoggedIn ? t('loggedIn') : t('loggedOut') }}</span>
      <button v-if="!isLoggedIn" class="btn btn-primary" @click="emit('login')">
        {{ t('loginDouyin') }}
      </button>
      <button v-else class="btn btn-secondary" @click="emit('logout')">{{ t('logout') }}</button>
    </div>
  </div>
</template>

<style scoped>
.login-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.title {
  font-size: 18px;
  font-weight: 600;
  color: #1a1a1a;
}

.login-status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.language-control {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #666;
}

.language-control select {
  height: 28px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  background: #fff;
  color: #333;
  font-size: 12px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-dot.online {
  background: #52c41a;
}

.status-dot.offline {
  background: #d9d9d9;
}

.status-text {
  font-size: 13px;
  color: #666;
}

.btn {
  padding: 6px 16px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary {
  background: #fe2c55;
  color: #fff;
}

.btn-primary:hover {
  background: #e0284e;
}

.btn-secondary {
  background: #f0f0f0;
  color: #666;
}

.btn-secondary:hover {
  background: #e0e0e0;
}
</style>
