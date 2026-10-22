import { RunStats } from './store'
import { FudaiGrabResult } from './fudai-service'
import { repository } from './runtime'
export class StatsService {
  private update:((stats:RunStats)=>void)|null=null
  setOnUpdate(fn:(stats:RunStats)=>void):void{this.update=fn}
  getStats():RunStats {
    if(repository.read().activeAccount)return repository.stats()
    return {participated:0,physicalWins:0,diamondWins:0,diamondWonAmount:0,couponWins:0,lastStartedAt:null,lastStoppedAt:null}
  }
  publish():void{this.update?.(this.getStats())}
  markStarted():void{this.publish()}
  markStopped():void{this.publish()}
  recordParticipation(_result:FudaiGrabResult):void{this.publish()}
  reset():RunStats{repository.change(a=>{a.statsSince=Date.now()});this.publish();return this.getStats()}
}
