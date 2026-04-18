<script setup lang="ts">
import { computed } from 'vue'
import { useIpc } from './composables/useIpc'
import { useI18n, type Language } from './composables/useI18n'
import LoginBar from './components/LoginBar.vue'
import ConfigPanel from './components/ConfigPanel.vue'
import AutoRunPanel from './components/AutoRunPanel.vue'
import RoomList from './components/RoomList.vue'
import LogPanel from './components/LogPanel.vue'
import StatsBar from './components/StatsBar.vue'

const {
  isLoggedIn,
  rooms,
  config,
  logs,
  stats,
  runStats,
  autoRunState,
  login,
  logout,
  addRoom,
  startAutoRun,
  stopAutoRun,
  resetRunStats,
  removeRoom,
  updateConfig,
  resetDiamondUsed,
  refreshStats
} = useIpc()

const language = computed(() => config.value?.language || 'zh-CN')
const { t } = useI18n(language)

function updateLanguage(nextLanguage: Language) {
  updateConfig({ language: nextLanguage })
}
</script>

<template>
  <div class="app">
    <LoginBar
      :is-logged-in="isLoggedIn"
      :language="language"
      :t="t"
      @login="login"
      @logout="logout"
      @update-language="updateLanguage"
    />
    <div class="main-content">
      <ConfigPanel
        v-if="config"
        :config="config"
        :run-stats="runStats"
        :t="t"
        @update="updateConfig"
        @reset-diamond="resetDiamondUsed"
      />
      <AutoRunPanel
        :state="autoRunState"
        :stats="runStats"
        :t="t"
        @start="startAutoRun"
        @stop="stopAutoRun"
        @reset-stats="resetRunStats"
      />
      <RoomList :rooms="rooms" :t="t" @add="addRoom" @remove="removeRoom" />
      <LogPanel :logs="logs" :t="t" />
    </div>
    <StatsBar v-if="stats" :stats="stats" :t="t" />
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
    sans-serif;
  font-size: 14px;
  color: #333;
  background: #f5f5f5;
  overflow: auto;
  user-select: text;
}

button,
input,
select {
  user-select: none;
}

.app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  padding: 12px;
  gap: 10px;
}

.main-content {
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: visible;
}
</style>
