import { RoomProfile,RoundRecord,Payment,RiskRecord,DecisionRecord,SessionRecord } from './policy'
export interface Insights {
  reports?:ReturnType<typeof import('./review').runReports>
  cycles?:ReturnType<typeof import('./review').budgetCycles>
  alerts?:import('./policy').UserAlert[]
  rooms:RoomProfile[];rounds:RoundRecord[];payments:Payment[];risks:RiskRecord[];decisions:DecisionRecord[];session:SessionRecord
  budget:{spent:number;lifetimeSpent?:number;cycle?:number;hasActivity?:boolean;reserved:number;awards:number;credit:number;effective:number;remaining:number;dailyRemaining:number}
  legacy:Record<string,unknown>
  metrics:{visits:number;confirmed:number;reuse:number;unknown:number;reusePerPayment:number;costPerRound:number;activeMinutes:number}
}
