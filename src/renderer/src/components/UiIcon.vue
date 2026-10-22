<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 })
const paths: Record<string, string> = {
  dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  rooms: 'M3 5h18v13H3z M8 22h8 M12 18v4 M9 9l6 3-6 3z',
  records: 'M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h4',
  logs: 'M4 5h16v14H4z M7 9l3 3-3 3 M13 15h4',
  gift: 'M3 8h18v4H3z M5 12v9h14v-9 M12 8v13 M12 8H8a3 3 0 1 1 3-3l1 3z M12 8h4a3 3 0 1 0-3-3l-1 3z',
  play: 'M8 5l11 7-11 7z',
  stop: 'M6 6h12v12H6z',
  pause: 'M8 5v14 M16 5v14',
  check: 'M5 12l4 4L19 6',
  close: 'M6 6l12 12 M18 6L6 18',
  chevron: 'M9 5l7 7-7 7',
  down: 'M5 9l7 7 7-7',
  clock: 'M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  diamond: 'M3 9l4-5h10l4 5-9 12z M3 9h18 M7 4l5 17 5-17',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2',
  plus: 'M12 5v14 M5 12h14',
  search: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M15 15l6 6',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
  alert: 'M12 3L2 21h20z M12 9v5 M12 17v.1',
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 11v6 M12 7v.1',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z',
  shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
  arrow: 'M4 12h16 M14 6l6 6-6 6',
  logout: 'M9 4H4v16h5 M12 12h9 M17 8l4 4-4 4',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 14 6 M4 12a8 8 0 0 0 14 6'
}
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="paths[name] || paths.info" />
  </svg>
</template>
