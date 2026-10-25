import { app, BrowserWindow, screen, ipcMain } from 'electron'
import type { AuthService } from './auth-service'
import { repository } from './runtime'
import { pendingAlerts,sortAlerts } from '../shared/review'
import type { UserAlert } from '../shared/policy'
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
export function setupAlerts(main:BrowserWindow,auth:AuthService):void {
  let popup:BrowserWindow|null=null,shown='',account='',lastLogin='',lastPayload=''
  let loginAlert:UserAlert|null=null
  const dismiss=(id:string)=>{if(loginAlert?.id===id)loginAlert.dismissedAt=Date.now();else if(account&&repository.read().activeAccount===account)repository.dismissAlert(id);popup?.close();popup=null;shown=''}
  const tick=()=>{
    const current=repository.read().activeAccount||''
    if(current!==account){popup?.close();popup=null;shown='';lastPayload='';account=current||''}
    const status=auth.getStatus()
    if(status.state==='expired' && lastLogin!=='expired')loginAlert={id:`login:${Date.now()}`,kind:'login',title:'登录已失效',message:'请重新登录抖音，检查后手动启动运行。',at:Date.now(),dismissedAt:null}
    if(status.state==='connected'||status.state==='signed-out')loginAlert=null
    lastLogin=status.state
    if(current)for(const n of pendingAlerts(repository.account()))repository.alert(n)
    const items=sortAlerts([...(loginAlert?[loginAlert]:[]),...(current?repository.account().alerts||[]:[])])
    const payload=JSON.stringify(items)
    if(payload!==lastPayload){lastPayload=payload;if(!main.isDestroyed())main.webContents.send('alerts:update',items)}
    const next=items[0]
    if(!next||main.isVisible()&&!main.isMinimized()){popup?.close();popup=null;shown='';return}
    if(shown===next.id&&popup)return
    popup?.close();shown=next.id
    popup=createPopup(next,()=>dismiss(next.id),()=>{
      if(main.isMinimized())main.restore();main.show();main.focus();main.webContents.send('navigate:records',next.kind);dismiss(next.id)
    })
  }
  ipcMain.handle('alerts:dismissTransient',(_event,id:string)=>{if(loginAlert?.id===id){loginAlert.dismissedAt=Date.now();return {success:true}}return {success:false,error:'提醒已变化'}})
  const timer=setInterval(tick,1500)
  app.once('before-quit',()=>{clearInterval(timer);popup?.close()})
}
function createPopup(n:UserAlert,close:()=>void,open:()=>void):BrowserWindow {
  const area=screen.getPrimaryDisplay().workArea
  const win=new BrowserWindow({width:380,height:220,x:area.x+area.width-396,y:area.y+area.height-236,
    show:false,frame:false,resizable:false,skipTaskbar:true,alwaysOnTop:true,
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
  body{margin:0;padding:20px;font:14px 'Segoe UI','Microsoft YaHei',sans-serif;color:#242731;background:#fff;border:1px solid #e7e9ee;height:178px}small{color:#687181}h2{font-size:17px;margin:12px 0 8px}p{font-size:13px;line-height:1.6;margin:0;height:62px;overflow:auto}nav{display:flex;gap:20px;margin-top:12px}a{color:#b41d43;text-decoration:none}a:focus{outline:2px solid #d91f4b}</style><small>福袋助手</small><h2>${escape(n.title)}</h2><p>${escape(n.message)}</p><nav><a href="https://notice.invalid/open">${n.kind==='login'?'返回登录':n.kind==='risk'?'查看异常待办':'查看记录'}</a><a href="https://notice.invalid/close">稍后查看</a></nav></html>`
  win.webContents.on('will-navigate',(event,url)=>{event.preventDefault();if(url==='https://notice.invalid/open')open();else if(url==='https://notice.invalid/close')close()})
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}))
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(()=>{})
  win.once('ready-to-show',()=>{if(!win.isDestroyed())win.showInactive()})
  return win
}
