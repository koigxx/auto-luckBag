<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ won: number; lost: number; unknown: number; pending: number; language?: string }>()
const tr = (zh: string, en: string) => props.language === 'en-US' ? en : zh
const segments = computed(() => [
  { key: 'won', label: tr('中奖', 'Won'), count: props.won },
  { key: 'lost', label: tr('未中奖', 'Not won'), count: props.lost },
  { key: 'pending', label: tr('待结束', 'Pending'), count: props.pending },
  { key: 'unknown', label: tr('未知', 'Unknown'), count: props.unknown }
])
const total = computed(() => segments.value.reduce((n, s) => n + s.count, 0))
</script>

<template>
  <div class="outcome-distribution">
    <div v-if="total" class="outcome-track" role="img" :aria-label="segments.map(s => `${s.label} ${s.count}`).join('，')">
      <span v-for="s in segments" :key="s.key" :class="s.key" :style="{ width: `${s.count / total * 100}%` }" />
    </div>
    <p v-else class="microcopy">{{ tr('本次尚无结果记录', 'No results recorded for this run yet') }}</p>
    <div class="outcome-legend"><span v-for="s in segments" :key="s.key"><i :class="s.key" />{{ s.label }} <b>{{ s.count }}</b></span></div>
  </div>
</template>
