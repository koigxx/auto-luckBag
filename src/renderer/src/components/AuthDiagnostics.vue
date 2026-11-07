<script setup lang="ts">
import { computed } from 'vue'
import type { AuthDiagnostics } from '../../../shared/auth'
const props=defineProps<{diagnostics?:AuthDiagnostics;language:string;busy:boolean;running:boolean}>()
const emit=defineEmits<{retry:[];login:[]}>()
const tr=(zh:string,en:string)=>props.language==='en-US'?en:zh
const steps=[{key:'browser',zh:'浏览器启动',en:'Browser startup'},{key:'page',zh:'页面加载',en:'Page load'},{key:'evidence',zh:'本人登录证据',en:'Sign-in evidence'},{key:'identity',zh:'账号一致性',en:'Account consistency'}] as const
const label=(value:string)=>({passed:tr('已确认','Confirmed'),failed:tr('未通过','Failed'),pending:tr('等待检查','Pending'),unknown:tr('尚未确认','Unconfirmed')}[value]||tr('尚未检查','Not checked'))
const explanation=computed(()=>{
  if(props.diagnostics?.challenge)return tr('页面需要人工验证。请在浏览器处理；如有异常待办，还需在运行记录中检查并完成。','The page needs manual verification. Resolve it in the browser, then complete any issue checks in Records.')
  return ({'no-session':['没有保存的登录会话，请打开浏览器登录。','No saved session. Open the browser to sign in.'],expired:['登录信息已失效，请重新登录。','The saved session expired. Sign in again.'],'no-evidence':['尚未收到足够的本人登录证据。可重试校验，或打开浏览器检查登录。','Not enough sign-in evidence. Retry or inspect sign-in in the browser.'],'browser-error':['浏览器未能正常启动，请停止任务后重试。','The browser could not start. Stop tasks and retry.'],'page-error':['页面未能完成加载，请检查网络后重试。','Page loading failed. Check your connection and retry.'],closed:['登录窗口已关闭，尚未完成确认。请重新打开并保持窗口打开。','The sign-in window closed before confirmation. Reopen it and keep it open.'],'account-changed':['检查期间账号发生变化，请重新登录确认当前账号。','The account changed during verification. Sign in again.'],connected:['已确认本人登录与账号身份。下次启动仍会按规则校验。','Sign-in and account identity confirmed. Startup checks still apply.'],checking:['正在检查，以下结果随实际页面反馈更新。','Checks update as page evidence arrives.']} as Record<string,string[]>)[props.diagnostics?.reason||'checking']?.[props.language==='en-US'?1:0]
})
</script>
<template>
  <details class="auth-diagnostics">
    <summary>{{tr('登录检查详情','Sign-in check details')}}</summary>
    <template v-if="diagnostics">
      <p class="microcopy">{{diagnostics.mode==='manual'?tr('人工登录检查','Manual sign-in check'):tr('保存会话校验','Saved session check')}} · {{new Date(diagnostics.updatedAt).toLocaleTimeString(language)}}</p>
      <ul class="diagnostic-steps"><li v-for="step in steps" :key="step.key"><span>{{tr(step.zh,step.en)}}</span><strong :class="diagnostics[step.key]">{{label(diagnostics[step.key])}}</strong></li></ul>
      <p class="microcopy" role="status">{{explanation}}</p>
    </template>
    <p v-else class="microcopy">{{tr('尚无检查明细，可重新校验或打开登录窗口。','No check details yet. Retry verification or open sign-in.')}}</p>
    <div class="button-row"><button class="button small" :disabled="busy || running" @click="emit('retry')">{{tr('重新校验登录','Recheck sign-in')}}</button><button class="button small" :disabled="busy || running" @click="emit('login')">{{tr('打开登录窗口','Open sign-in window')}}</button></div>
    <p v-if="running" class="microcopy">{{tr('停止运行后可重新检查或登录。','Stop the run before rechecking or signing in.')}}</p>
  </details>
</template>
