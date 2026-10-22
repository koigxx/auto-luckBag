<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'
const props = withDefaults(
  defineProps<{ open: boolean; title: string; closeLabel?: string; busy?: boolean }>(),
  { closeLabel: '关闭', busy: false }
)
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const headingId = `dialog-${Math.random().toString(36).slice(2)}`
let returnFocus: HTMLElement | null = null
watch(
  () => props.open,
  async (value) => {
    await nextTick()
    if (value && !dialog.value?.open) {
      returnFocus = document.activeElement as HTMLElement
      dialog.value?.showModal()
    } else if (!value && dialog.value?.open) {
      dialog.value.close()
      returnFocus?.focus()
    }
  },
  { immediate: true }
)
function close() {
  if (!props.busy) emit('close')
}
</script>

<template>
  <dialog ref="dialog" class="ui-dialog" :aria-labelledby="headingId" @cancel.prevent="close">
    <div class="dialog-heading">
      <h2 :id="headingId">{{ title }}</h2>
      <button class="icon-button" :disabled="busy" :aria-label="closeLabel" @click="close">
        <UiIcon name="close" />
      </button>
    </div>
    <slot />
    <div v-if="$slots.footer" class="dialog-footer"><slot name="footer" /></div>
  </dialog>
</template>
