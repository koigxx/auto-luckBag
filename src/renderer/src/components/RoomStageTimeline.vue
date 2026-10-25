<script setup lang="ts">
import { computed } from 'vue'
import type { RoomTimeline } from '../../../shared/policy'
import { timeProgress } from '../../../shared/display-progress'
const props=defineProps<{timeline?:RoomTimeline;phase?:string;language:string}>()
const tr=(zh:string,en:string)=>props.language==='en-US'?en:zh
const stage=computed(()=>props.timeline?.stage || (/下一轮/.test(props.phase||'')?'next':/等待开奖|开奖核对/.test(props.phase||'')?'draw':'prepare'))
const steps=computed(()=>[
  {id:'prepare',label:tr('准备任务','Tasks'),at:props.timeline?.taskAt,hint:tr('开始窗口','Start window')},
  {id:'draw',label:tr('开奖与核对','Draw & result'),at:props.timeline?.drawAt,hint:tr('开奖时间','Draw time')},
  {id:'next',label:tr('观察续轮','Next round'),at:props.timeline?.nextUntil,hint:tr('最迟结束','End by')}
])
const activeIndex=computed(()=>steps.value.findIndex(s=>s.id===stage.value))
const progress=computed(()=>timeProgress(props.timeline?.startedAt,props.timeline?.endsAt,props.timeline?.remainingSeconds))
const time=(at:number|null|undefined)=>at==null?'—':new Date(at).toLocaleTimeString(props.language,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})
</script>
<template>
  <ol class="room-timeline" :aria-label="tr('当前任务阶段','Current task phase')">
    <li v-for="(step,index) in steps" :key="step.id" :class="{current:index===activeIndex,done:index<activeIndex}" :aria-current="index===activeIndex?'step':undefined">
      <div class="stage-track" :class="{indeterminate:index===activeIndex && progress===null}" :role="index===activeIndex?'progressbar':undefined" :aria-label="index===activeIndex?step.label:undefined" :aria-valuenow="index===activeIndex && progress!==null?progress:undefined" :aria-valuetext="index===activeIndex?phase:undefined" :aria-valuemin="index===activeIndex?0:undefined" :aria-valuemax="index===activeIndex?100:undefined"><span :style="{width:index<activeIndex?'100%':index===activeIndex && progress!==null?`${progress}%`:'0%'}" /></div>
      <strong>{{step.label}}</strong><small>{{step.hint}}</small><time>{{time(step.at)}}</time>
    </li>
  </ol>
</template>
