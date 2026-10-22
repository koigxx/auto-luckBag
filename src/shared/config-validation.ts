import { AppConfig } from './config'
import { validatePolicy } from './policy'
export function validateConfigPatch(input:unknown):Partial<AppConfig> {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('配置必须为对象')
  const raw=input as Record<string,unknown>,patch:Partial<AppConfig>={}
  const writable=['language','fudaiTypes','diamondBudget','allowDiamondProfit','debugLogs','scanIntervalSeconds','enterBeforeSeconds','candidatePoolLimit','policy']
  for(const [key,value] of Object.entries(raw)) {
    if(!writable.includes(key))throw new Error(`只读或未知配置：${key}`)
    if(key==='policy')patch.policy=validatePolicy(value)
    else if(key==='language') {if(!['zh-CN','en-US'].includes(String(value)))throw new Error('无效语言');patch.language=value as AppConfig['language']}
    else if(key==='fudaiTypes') {
      if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['all','physical','diamond'].includes(k))||['all','physical','diamond'].some(k=>typeof(value as any)[k]!=='boolean'))throw new Error('无效福袋类型')
      patch.fudaiTypes=value as AppConfig['fudaiTypes']
    } else if(['allowDiamondProfit','debugLogs'].includes(key)){if(typeof value!=='boolean')throw new Error('无效开关');(patch as any)[key]=value}
    else {
      const [min,max]=key==='diamondBudget'?[0,100000]:key==='candidatePoolLimit'?[1,5]:key==='enterBeforeSeconds'?[30,600]:[30,3600]
      if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new Error(`无效数值：${key}`)
      ;(patch as any)[key]=value
    }
  }
  return patch
}
