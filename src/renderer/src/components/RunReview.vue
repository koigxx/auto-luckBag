<script setup lang="ts">
import { computed } from 'vue'
import type { Insights } from '../../../shared/insights'
import { activityLabel, type ActivityKind, type LogContext } from '../../../shared/experience'
const props=defineProps<{report:NonNullable<Insights['reports']>[number];language:string}>()
const emit=defineEmits<{logs:[context:LogContext]}>()
const tr=(zh:string,en:string)=>props.language==='en-US'?en:zh
const timings=computed(()=>Object.entries(props.report.activityTiming?.totals||{}).filter(([,ms])=>ms>0).sort((a,b)=>b[1]-a[1]))
const total=computed(()=>timings.value.reduce((n,[,ms])=>n+ms,0))
const skips=computed(()=>Object.entries(props.report.skipReasons||{}).sort((a,b)=>b[1]-a[1]).slice(0,3))
</script>
<template>
  <div class="run-review">
    <h3>{{tr('本次时间与待核对事项','Time and follow-up')}}</h3>
    <div v-if="timings.length" class="timing-list"><div v-for="[kind,ms] in timings" :key="kind"><span>{{activityLabel(kind as ActivityKind,language==='en-US')}}</span><meter :value="ms" :max="total" :aria-label="activityLabel(kind as ActivityKind,language==='en-US')" /><strong>{{(ms/60000).toFixed(1)}} {{tr('分钟','min')}}</strong></div></div>
    <p class="microcopy">{{report.activityTiming ? tr(`采样覆盖 ${(total/60000).toFixed(1)} 分钟；按观察时的阶段归类，包含正常等待，长时间挂起不补算。`, `Samples cover ${(total/60000).toFixed(1)} min by observed stage, including waits. Long suspend gaps are excluded.`) : tr('此记录未采集细分耗时，不从总时长推算。','Detailed timing was not collected for this run; no breakdown is inferred.')}}</p>
    <p class="microcopy">{{tr('主要跳过原因','Top skip reasons')}}：{{skips.length?'':tr('暂无记录','No records')}}</p>
    <ul v-if="skips.length" class="review-reasons"><li v-for="[reason,count] in skips" :key="reason">{{reason}} <strong>× {{count}}</strong></li></ul>
    <p class="microcopy">{{tr(`结果未知 ${report.unknown} 轮，待结束 ${report.pending} 轮；未决或预留占额 ${report.reserved} 钻。请结合下方明细核对。`,`Unknown ${report.unknown}, pending ${report.pending}; held budget ${report.reserved} diamonds. Review the detail records.`)}}</p>
    <button class="inline-link" @click="emit('logs',{runId:report.id})">{{tr('查看本次运行日志','View this run’s logs')}}</button>
  </div>
</template>
