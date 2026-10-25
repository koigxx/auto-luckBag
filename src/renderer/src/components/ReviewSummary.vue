<script setup lang="ts">
import {computed,ref} from 'vue'
import type {Insights} from '../../../shared/insights'
const props=defineProps<{data:Insights;busy:Record<string,boolean>;onAction:(key:string,fn:()=>Promise<{success:boolean;error?:string}>)=>Promise<boolean|null>}>()
const allClaims=ref(false),reportPage=ref(1)
const claims=computed(()=>props.data.rounds.filter(r=>r.result==='won'&&r.confirmedAt!==null&&r.prizeType!=='diamond'&&(allClaims.value||!r.claimed)))
const time=(n:number|null)=>n===null?'运行中':new Date(n).toLocaleString('zh-CN')
const name=(url:string)=>props.data.rooms.find(r=>r.url===url)?.name||url
const reports=computed(()=>props.data.reports||[])
const api=window.api
</script>
<template>
  <section class="surface review-summary">
    <div class="section-heading"><h2>领取待办</h2><label><input type="checkbox" v-model="allClaims" /> 显示已处理</label></div>
    <p class="microcopy">领取操作在抖音完成，收货资料不在此保存。期限以平台显示为准；标记只表示你已处理。</p>
    <p v-if="!claims.length" class="subtle">暂无待处理奖励</p>
    <article v-for="r in claims" :key="r.key" class="claim-item">
      <strong>{{ name(r.roomUrl) }} · {{ r.prizeName || '中奖奖励' }}</strong><p>{{ time(r.drawAt) }} · {{ r.claimDueAt ? `领取截止 ${time(r.claimDueAt)}` : '领取期限未识别，请在抖音确认' }}</p>
      <div class="button-row"><button class="button small" :disabled="busy[`claim-open:${r.key}`]" @click="onAction(`claim-open:${r.key}`,()=>api.insights.openClaim(r.key))">打开直播间查看</button><button class="button small" :disabled="busy[`claim:${r.key}`]" @click="onAction(`claim:${r.key}`,()=>api.insights.claim(r.key,!r.claimed))">{{r.claimed?'恢复为待处理':'已完成领取信息处理'}}</button></div>
    </article>
  </section>
  <section class="surface review-summary">
    <div class="section-heading"><h2>每次运行报告</h2><span class="subtle">共 {{reports.length}} 次</span></div>
    <p v-if="!reports.length" class="subtle">下一次启动后自动生成报告；旧测试记录不推测归入运行。</p>
    <details v-for="r in reports.slice((reportPage-1)*10,reportPage*10)" :key="r.id" class="run-report">
      <summary>{{time(r.startedAt)}} · {{ r.endedAt===null?'运行中':r.reason }}</summary>
      <p class="microcopy">结束 {{time(r.endedAt)}} · 预算第 {{r.budgetCycle+1}} 轮 · {{ r.source }}</p>
      <div class="report-facts"><span>活跃 {{(r.activeMs/60000).toFixed(1)}} 分钟</span><span v-if="r.endedAt!==null">总历时 {{((r.endedAt-r.startedAt)/60000).toFixed(1)}} 分钟</span><span>确认 {{r.confirmed}}</span><span>中奖 {{r.won}}</span><span>未中奖 {{r.lost}}</span><span>未知 {{r.unknown}}</span><span>待结束 {{r.pending}}</span><span>支出 {{r.spent}} 钻 / 占额 {{r.reserved}} 钻</span></div>
      <p v-for="(count,reason) in r.skipReasons" :key="reason" class="microcopy">跳过 {{count}} 次：{{reason}}</p>
    </details>
    <div v-if="reports.length>10" class="button-row"><button class="button small" :disabled="reportPage<=1" @click="reportPage--">上页报告</button><span>{{reportPage}}</span><button class="button small" :disabled="reportPage*10>=reports.length" @click="reportPage++">下页报告</button></div>
  </section>
  <section class="surface review-summary"><details><summary>预算轮次历史</summary><p class="microcopy">已用与预留按原轮次归属。重置不删除旧账本。</p><div class="budget-cycles"><div v-for="c in data.cycles||[]" :key="c.cycle" class="budget-cycle"><strong>第 {{c.cycle+1}} 轮{{c.cycle===data.budget.cycle?' · 当前':''}}</strong><small>支出 {{c.spent}} 钻 / 预留 {{c.reserved}} 钻</small><small>确认参与 {{c.confirmed}} 次</small></div></div></details></section>
</template>
