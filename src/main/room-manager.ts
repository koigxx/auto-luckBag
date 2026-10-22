import { Page } from 'playwright'
import { BrowserManager } from './browser-manager'
import { FudaiGrabResult,FudaiService } from './fudai-service'
import { Opportunity,normalizeRoomUrl } from '../shared/policy'
import { PassiveObserver } from './passive-observer'
import { assertActive,execution,onHalt,repository,policy,paymentReason,reportRisk,sessionEngine,perform } from './runtime'
import { store } from './store'

export type RoomStatus='loading'|'monitoring'|'grabbing'|'error'|'idle'
export interface Room {id:string;url:string;name:string;page:Page|null;status:RoomStatus;fudaiCount:number;hasFanBadge:boolean;countdownText:string;remainingSeconds:number|null;drawAt:number|null;fudaiService:FudaiService|null;phase:string}
export interface RoomMetadata {drawAt?:number|null;remainingSeconds?:number|null;countdownText?:string;opportunity?:Opportunity;observer?:PassiveObserver}
export class RoomManager {
  private rooms=new Map<string,Room>()
  private update:(room:Room)=>void=()=>{}
  private log:(id:string,message:string)=>void=()=>{}
  private result:(room:Room,result:FudaiGrabResult)=>void=()=>{}
  private removed:(id:string)=>void=()=>{}
  private continuation:(o:Opportunity)=>string|null=()=>null
  constructor(private browser:BrowserManager){onHalt(()=>this.closeAllRooms())}
  setCallbacks(update:(room:Room)=>void,log:(id:string,message:string)=>void,result?:(room:Room,result:FudaiGrabResult)=>void,removed?:(id:string)=>void):void{this.update=update;this.log=log;this.result=result||(()=>{});this.removed=removed||(()=>{})}
  setContinuationCheck(fn:(o:Opportunity)=>string|null):void{this.continuation=fn}
  async addRoom(url:string,name?:string,metadata:RoomMetadata={}):Promise<Room>{return this.create(url,name,metadata)}
  async addRoomFromPage(page:Page,url:string,name?:string,metadata:RoomMetadata={}):Promise<Room>{return this.create(url,name,metadata,page)}
  private async create(input:string,name:string|undefined,metadata:RoomMetadata,page?:Page):Promise<Room> {
    const signal=execution.signal,url=normalizeRoomUrl(input);assertActive(signal,true)
    if(this.rooms.size>=5||this.hasRoom(url))throw new Error('房间已存在或已达 5 个上限')
    const profile=repository.room(url,name)
    if(profile.blocked)throw new Error('该房间已屏蔽')
    const room:Room={id:`room_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,url,name:name||profile.name,page:null,status:'loading',fudaiCount:0,hasFanBadge:false,countdownText:'',remainingSeconds:null,drawAt:metadata.drawAt||null,fudaiService:null,phase:'加载中'}
    this.rooms.set(room.id,room)
    try {
      room.page=page||await this.browser.newManagedPage(signal)
      // Install response/WS observers before navigation; takeover retains the verification observer.
      room.fudaiService=new FudaiService(room.page,url,{
        onUpdate:(o,rounds,phase)=>{if(!this.rooms.has(room.id))return;room.drawAt=o?.drawAt||null;room.fudaiCount=rounds;room.phase=phase;room.status=phase==='完成任务'?'grabbing':'monitoring'},
        onResult:r=>this.result(room,r),onLog:m=>this.log(room.id,m),mayContinue:o=>this.continuation(o)
      },{signal,now:Date.now,repository,policy,paymentReason,reportRisk,perform,assertActive,canFinish:t=>sessionEngine.canFinish(t),getConfig:()=>store.store},metadata.observer)
      room.fudaiService.seed(metadata.opportunity)
      await room.fudaiService.installDomObserver()
      if(!page)await this.browser.navigate(room.page,url,profile.visits.length===0,signal)
      assertActive(signal,true);room.status='monitoring';this.update(room)
      return room
    } catch(error){await this.removeRoom(room.id);throw error}
  }
  async tick():Promise<void> {
    for(const room of this.rooms.values()) {
      if(room.page?.isClosed()){await this.removeRoom(room.id);continue}
      await room.fudaiService?.tick()
      if(room.fudaiService?.doneReason){this.log(room.id,room.fudaiService.doneReason);await this.removeRoom(room.id);continue}
      room.remainingSeconds=room.drawAt?Math.max(0,Math.ceil((room.drawAt-Date.now())/1000)):null
      room.countdownText=room.remainingSeconds===null?'':`${Math.floor(room.remainingSeconds/60)}:${String(room.remainingSeconds%60).padStart(2,'0')}`
      const profile=repository.account().rooms[room.url]
      room.hasFanBadge=profile?.memberKnown===true&&profile.membership==='satisfied'
      this.update(room)
    }
  }
  async removeRoom(id:string):Promise<void> {
    const room=this.rooms.get(id);if(!room)return
    this.rooms.delete(id);room.fudaiService?.stopMonitoring();this.removed(id)
    await room.page?.close().catch(()=>{})
    await room.fudaiService?.waitForIdle()
  }
  async closeAllRooms():Promise<void>{await Promise.allSettled([...this.rooms.keys()].map(id=>this.removeRoom(id)))}
  hasRoom(url:string):boolean{return [...this.rooms.values()].some(r=>r.url===url)}
  getRoom(id:string):Room|undefined{return this.rooms.get(id)}
  getAllRooms():Room[]{return [...this.rooms.values()]}
  getRoomPublicInfo(id:string){const r=this.rooms.get(id);if(!r)return undefined;const {page,fudaiService,...data}=r;return data}
  getAllRoomsPublicInfo(){return [...this.rooms.keys()].map(id=>this.getRoomPublicInfo(id)!)}
  clearSavedRooms():void{store.set('rooms',[])}
}
