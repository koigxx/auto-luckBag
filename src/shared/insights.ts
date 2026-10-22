import { RoomProfile,RoundRecord,Payment,RiskRecord,DecisionRecord,SessionRecord } from './policy'
export interface Insights {
  rooms:RoomProfile[];rounds:RoundRecord[];payments:Payment[];risks:RiskRecord[];decisions:DecisionRecord[];session:SessionRecord
  budget:{spent:number;reserved:number;awards:number;credit:number;effective:number;remaining:number;dailyRemaining:number}
  legacy:Record<string,unknown>
  metrics:{visits:number;confirmed:number;reuse:number;unknown:number;reusePerPayment:number;costPerRound:number;activeMinutes:number}
}
