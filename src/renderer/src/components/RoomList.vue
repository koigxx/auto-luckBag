<script setup lang="ts">
import { ref } from 'vue'
import type { RoomInfo } from '../types'
import RoomCard from './RoomCard.vue'
import type { MessageKey } from '../composables/useI18n'

const props = defineProps<{
  rooms: RoomInfo[]
  t: (key: MessageKey, params?: Record<string, string | number>) => string
}>()

const emit = defineEmits<{
  add: [url: string, name?: string]
  remove: [roomId: string]
}>()

const newUrl = ref('')
const newName = ref('')

function handleAdd() {
  const url = newUrl.value.trim()
  if (!url) return
  emit('add', url, newName.value.trim() || undefined)
  newUrl.value = ''
  newName.value = ''
}

function handleRemove(roomId: string) {
  emit('remove', roomId)
}
</script>

<template>
  <div class="room-list">
    <div class="panel-header">
      <span>{{ t('rooms') }}</span>
      <span class="room-count">{{ t('roomCount', { count: rooms.length }) }}</span>
    </div>
    <div class="add-room">
      <input
        v-model="newUrl"
        class="input url-input"
        :placeholder="t('roomUrlPlaceholder')"
        @keyup.enter="handleAdd"
      />
      <input
        v-model="newName"
        class="input name-input"
        :placeholder="t('roomNamePlaceholder')"
        @keyup.enter="handleAdd"
      />
      <button class="btn btn-add" @click="handleAdd">{{ t('add') }}</button>
    </div>
    <div class="rooms">
      <RoomCard
        v-for="room in rooms"
        :key="room.id"
        :room="room"
        :t="t"
        @remove="handleRemove"
      />
      <div v-if="rooms.length === 0" class="empty-hint">
        {{ t('roomsEmpty') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.room-list {
  background: #fff;
  border-radius: 8px;
  padding: 12px 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
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

.room-count {
  font-size: 12px;
  font-weight: normal;
  color: #999;
}

.add-room {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.input {
  padding: 6px 10px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  font-size: 13px;
}

.input:focus {
  outline: none;
  border-color: #fe2c55;
}

.url-input {
  flex: 1;
  min-width: 0;
}

.name-input {
  width: 100px;
}

.btn {
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}

.btn-add {
  padding: 6px 16px;
  background: #fe2c55;
  color: #fff;
}

.btn-add:hover {
  background: #e0284e;
}

.rooms {
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-content: flex-start;
}

.empty-hint {
  color: #bbb;
  font-size: 13px;
  text-align: center;
  padding: 20px;
  width: 100%;
}
</style>
