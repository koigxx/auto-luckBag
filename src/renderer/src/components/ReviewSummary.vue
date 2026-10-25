<script setup lang="ts">
import {computed,ref} from 'vue'
import type {Insights} from '../../../shared/insights'
import OutcomeBar from './OutcomeBar.vue'
const props=defineProps<{data:Insights;language:string;part:'claims'|'history';busy:Record<string,boolean>;onAction:(key:string,fn:()=>Promise<{success:boolean;error?:string}>)=>Promise<boolean|null>}>()
const tr=(zh:string,en:string)=>props.language==='en-US'?en:zh
const allClaims=ref(false),reportPage=ref(1)
const pending=computed(()=>props.data.rounds.filter(r=>r.result==='won'&&r.confirmedAt!=null&&r.prizeType!=='diamond'&&!r.claimed).length)
const claims=computed(()=>props.data.rounds.filter(r=>r.result==='won'&&r.confirmedAt!=null&&r.prizeType!=='diamond'&&(allClaims.value||!r.claimed)))
const time=(n:number|null)=>n===null?tr('运行中','Running'):new Date(n).toLocaleString(props.language)
const name=(url:string)=>props.data.rooms.find(r=>r.url===url)?.name||url
const reports=computed(()=>props.data.reports||[])
const api=window.api
</script>
<template>
  <details v-if="part==='claims'" class="surface review-disclosure claims-disclosure" :open="pending>0">
    <summary><strong>{{tr('领取待办','Reward claims')}}</strong><span :class="pending?'claim-count':'subtle'">{{pending?tr(`${pending} 项待处理`,`${pending} to handle`):tr('暂无待处理奖励','No pending claims')}}</span></summary>
    <div class="disclosure-body">
      <div class="section-heading"><p class="microcopy">{{tr('全部运行的领取待办。领取与收货资料在抖音处理；标记只表示你已处理。','Claims across all runs. Handle delivery details in Douyin; marking a claim only records your acknowledgement.')}}</p><label><input type="checkbox" v-model="allClaims" /> {{tr('显示已处理','Show handled')}}</label></div>
      <p v-if="!claims.length" class="subtle">{{tr('当前列表为空','This list is empty')}}</p>
      <article v-for="r in claims" :key="r.key" class="claim-item">
        <strong>{{name(r.roomUrl)}} · {{r.prizeName||tr('中奖奖励','Reward')}}</strong><p>{{time(r.drawAt)}} · {{r.claimDueAt?`${tr('领取截止','Claim by')} ${time(r.claimDueAt)}`:tr('领取期限未识别，请在抖音确认','Deadline unknown; check in Douyin')}}</p>
        <div class="button-row"><button class="button small" :disabled="busy[`claim-open:${r.key}`]" @click="onAction(`claim-open:${r.key}`,()=>api.insights.openClaim(r.key))">{{tr('打开直播间查看','Open room to review')}}</button><button class="button small" :disabled="busy[`claim:${r.key}`]" @click="onAction(`claim:${r.key}`,()=>api.insights.claim(r.key,!r.claimed))">{{r.claimed?tr('恢复为待处理','Mark unhandled'):tr('已完成领取信息处理','Mark claim handled')}}</button></div>
      </article>
    </div>
  </details>
  <div v-else class="record-archives">
    <details class="surface review-disclosure report-archive">
      <summary><strong>{{tr('每次运行报告','Run reports')}}</strong><span class="subtle">{{tr(`共 ${reports.length} 次`,`${reports.length} runs`)}}</span></summary>
      <div class="disclosure-body">
        <p v-if="!reports.length" class="subtle">{{tr('下一次启动后自动生成报告；旧记录不推测归入运行。','Reports begin with your next run; older records are not assigned by inference.')}}</p>
        <details v-for="r in reports.slice((reportPage-1)*10,reportPage*10)" :key="r.id" class="run-report">
          <summary><span class="report-title">{{time(r.startedAt)}}<small>{{r.endedAt===null?tr('运行中','Running'):r.reason}}</small></span><span class="report-summary-count">{{r.confirmed}} {{tr('次确认','confirmed')}} <b>{{r.spent}} {{tr('钻','diamonds')}}</b></span></summary>
          <OutcomeBar :won="r.won" :lost="r.lost" :unknown="r.unknown" :pending="r.pending" :language="language" />
          <p class="microcopy">{{tr('结束','Ended')}} {{time(r.endedAt)}} · {{tr('预算轮次','Budget cycle')}} {{r.budgetCycle+1}} · {{r.source}}</p>
          <div class="report-facts"><span>{{tr('活跃','Active')}} {{(r.activeMs/60000).toFixed(1)}} {{tr('分钟','minutes')}}</span><span v-if="r.endedAt!==null">{{tr('总历时','Elapsed')}} {{((r.endedAt-r.startedAt)/60000).toFixed(1)}} {{tr('分钟','minutes')}}</span><span>{{tr('确认','Confirmed')}} {{r.confirmed}}</span><span>{{tr('中奖','Won')}} {{r.won}}</span><span>{{tr('未中奖','Not won')}} {{r.lost}}</span><span>{{tr('未知','Unknown')}} {{r.unknown}}</span><span>{{tr('待结束','Pending')}} {{r.pending}}</span><span>{{tr('支出','Spent')}} {{r.spent}} / {{tr('占额','Reserved')}} {{r.reserved}} {{tr('钻','diamonds')}}</span></div>
          <p v-for="(count,reason) in r.skipReasons" :key="reason" class="microcopy">{{tr('跳过','Skipped')}} {{count}} {{tr('次','times')}}：{{reason}}</p>
        </details>
        <div v-if="reports.length>10" class="button-row"><button class="button small" :disabled="reportPage<=1" @click="reportPage--">{{tr('上页报告','Previous reports')}}</button><span>{{reportPage}}</span><button class="button small" :disabled="reportPage*10>=reports.length" @click="reportPage++">{{tr('下页报告','Next reports')}}</button></div>
      </div>
    </details>
    <details class="surface review-disclosure"><summary><strong>{{tr('预算轮次历史','Budget cycle history')}}</strong><span class="subtle">{{tr('保留完整账本','Full ledger retained')}}</span></summary><div class="disclosure-body"><p class="microcopy">{{tr('已用与预留按原轮次归属。重置不删除旧账本。','Spent and reserved amounts stay in their original cycle. Resets preserve the ledger.')}}</p><div class="budget-cycles"><div v-for="c in data.cycles||[]" :key="c.cycle" class="budget-cycle"><strong>{{tr('轮次','Cycle')}} {{c.cycle+1}}{{c.cycle===data.budget.cycle?tr(' · 当前',' · Current'):''}}</strong><small>{{tr('支出','Spent')}} {{c.spent}} {{tr('钻 / 预留','diamonds / reserved')}} {{c.reserved}} {{tr('钻','diamonds')}}</small><small>{{tr('确认参与','Confirmed')}} {{c.confirmed}}</small></div></div></div></details>
  </div>
</template>
