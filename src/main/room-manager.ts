import { Page } from 'playwright'
import { BrowserManager } from './browser-manager'
import { FudaiGrabResult, FudaiService } from './fudai-service'
import { store } from './store'
import { logError, logInfo } from './logger'

export type RoomStatus = 'loading' | 'monitoring' | 'grabbing' | 'error' | 'idle'

export interface Room {
  id: string
  url: string
  name: string
  page: Page | null
  status: RoomStatus
  fudaiCount: number
  hasFanBadge: boolean
  countdownText: string
  remainingSeconds: number | null
  drawAt: number | null
  fudaiService: FudaiService | null
}

export interface RoomMetadata {
  countdownText?: string
  remainingSeconds?: number | null
  drawAt?: number | null
}

export class RoomManager {
  private static readonly MAX_ROOMS = 5
  private rooms: Map<string, Room> = new Map()
  private autoCloseTimers: Map<string, NodeJS.Timeout> = new Map()
  private browserManager: BrowserManager
  private onRoomUpdate: ((room: Room) => void) | null = null
  private onLog: ((roomId: string, message: string) => void) | null = null
  private onRoomRemoved: ((roomId: string) => void) | null = null
  private onFudaiGrabbed: ((room: Room, result: FudaiGrabResult) => void) | null = null

  constructor(browserManager: BrowserManager) {
    this.browserManager = browserManager
  }

  setCallbacks(
    onRoomUpdate: (room: Room) => void,
    onLog: (roomId: string, message: string) => void,
    onFudaiGrabbed?: (room: Room, result: FudaiGrabResult) => void,
    onRoomRemoved?: (roomId: string) => void
  ): void {
    this.onRoomUpdate = onRoomUpdate
    this.onLog = onLog
    this.onFudaiGrabbed = onFudaiGrabbed || null
    this.onRoomRemoved = onRoomRemoved || null
  }

  async addRoom(url: string, name?: string, metadata: RoomMetadata = {}): Promise<Room> {
    const normalizedUrl = this.normalizeRoomUrl(url)
    if (this.rooms.size >= RoomManager.MAX_ROOMS) {
      throw new Error(`最多同时监控 ${RoomManager.MAX_ROOMS} 个直播间`)
    }
    if (this.hasRoom(normalizedUrl)) {
      throw new Error('该直播间已经在监控列表中')
    }

    const id = this.generateId()
    const roomName = name || this.extractRoomName(normalizedUrl)
    const room: Room = {
      id,
      url: normalizedUrl,
      name: roomName,
      page: null,
      status: 'loading',
      fudaiCount: 0,
      hasFanBadge: false,
      countdownText: metadata.countdownText || '',
      remainingSeconds:
        typeof metadata.drawAt === 'number' && metadata.drawAt > 0
          ? Math.max(0, Math.ceil((metadata.drawAt - Date.now()) / 1000))
          : metadata.remainingSeconds ?? null,
      drawAt: metadata.drawAt ?? null,
      fudaiService: null
    }

    this.rooms.set(id, room)
    logInfo('room', `添加直播间请求: ${roomName} ${normalizedUrl}`)
    this.notifyUpdate(room)

    this.loadRoom(room).catch((e) => {
      room.status = 'error'
      this.log(id, `加载失败: ${e.message}`)
      logError('room', `load failed: ${room.url}`, e)
      this.notifyUpdate(room)
    })

    return room
  }

  async addRoomFromPage(page: Page, url: string, name?: string, metadata: RoomMetadata = {}): Promise<Room> {
    const normalizedUrl = this.normalizeRoomUrl(url)
    if (this.rooms.size >= RoomManager.MAX_ROOMS) {
      throw new Error(`最多同时监控 ${RoomManager.MAX_ROOMS} 个直播间`)
    }
    if (this.hasRoom(normalizedUrl)) {
      throw new Error('该直播间已经在监控列表中')
    }

    const id = this.generateId()
    const roomName = name || this.extractRoomName(normalizedUrl)
    const room: Room = {
      id,
      url: normalizedUrl,
      name: roomName,
      page,
      status: 'monitoring',
      fudaiCount: 0,
      hasFanBadge: false,
      countdownText: metadata.countdownText || '',
      remainingSeconds:
        typeof metadata.drawAt === 'number' && metadata.drawAt > 0
          ? Math.max(0, Math.ceil((metadata.drawAt - Date.now()) / 1000))
          : metadata.remainingSeconds ?? null,
      drawAt: metadata.drawAt ?? null,
      fudaiService: null
    }

    this.rooms.set(id, room)
    this.log(id, `已接管验证中的直播间: ${room.name}`)
    this.notifyUpdate(room)
    await this.startFudaiMonitoring(room)
    return room
  }

  async restoreSavedRooms(): Promise<void> {
    const savedRooms = store.get('rooms')
    for (const savedRoom of savedRooms) {
      if (this.rooms.size >= RoomManager.MAX_ROOMS) {
        this.log('system', `已达到 ${RoomManager.MAX_ROOMS} 个直播间上限，停止恢复剩余房间`)
        return
      }

      try {
        await this.addRoom(savedRoom.url, savedRoom.name)
      } catch (e: any) {
        this.log('system', `恢复直播间失败: ${savedRoom.url}，${e.message}`)
      }
    }
  }

  clearSavedRooms(): void {
    store.set('rooms', [])
  }

  async removeRoom(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId)
    if (!room) return

    const timer = this.autoCloseTimers.get(roomId)
    if (timer) {
      clearTimeout(timer)
      this.autoCloseTimers.delete(roomId)
    }

    if (room.fudaiService) {
      room.fudaiService.stopMonitoring()
      room.fudaiService = null
    }
    if (room.page && !room.page.isClosed()) {
      await room.page.close()
    }

    this.rooms.delete(roomId)
    this.onRoomRemoved?.(roomId)
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId)
  }

  getAllRooms(): Room[] {
    return Array.from(this.rooms.values())
  }

  getRoomPublicInfo(roomId: string): Omit<Room, 'page' | 'fudaiService'> | undefined {
    const room = this.rooms.get(roomId)
    if (!room) return undefined
    return this.toPublicRoom(room)
  }

  getAllRoomsPublicInfo(): Omit<Room, 'page' | 'fudaiService'>[] {
    return this.getAllRooms().map((room) => this.toPublicRoom(room))
  }

  hasRoom(url: string): boolean {
    try {
      const normalizedUrl = this.normalizeRoomUrl(url)
      return this.getAllRooms().some((room) => room.url === normalizedUrl)
    } catch {
      return false
    }
  }

  hasCapacity(): boolean {
    return this.rooms.size < RoomManager.MAX_ROOMS
  }

  async closeAllRooms(): Promise<void> {
    for (const id of Array.from(this.rooms.keys())) {
      await this.removeRoom(id)
    }
  }

  private async loadRoom(room: Room): Promise<void> {
    const context = await this.browserManager.getContext()
    const page = await context.newPage()
    room.page = page
    this.notifyUpdate(room)

    await this.browserManager.getLiveRoomEnterNavQueue().run(
      'room:enter',
      () => page.goto(room.url, { waitUntil: 'domcontentloaded', timeout: 30000 }),
      (message) => this.log(room.id, message)
    )
    this.log(room.id, `已进入直播间: ${room.name}`)
    logInfo('room', `entered: ${room.name} ${room.url}`)

    room.status = 'monitoring'
    this.notifyUpdate(room)

    await this.startFudaiMonitoring(room)
  }

  private async startFudaiMonitoring(room: Room): Promise<void> {
    if (!room.page) {
      throw new Error('直播间页面不存在')
    }
    const fudaiService = new FudaiService(room.page, room.id, {
      onFudaiDetected: (info) => {
        this.log(room.id, `检测到福袋: ${info.type}`)
        this.updateRoomFudaiTiming(room, info.remainingSeconds, info.drawAt)
        room.status = 'grabbing'
        this.notifyUpdate(room)
      },
      onFudaiInfoUpdated: (info) => {
        this.updateRoomFudaiTiming(room, info.remainingSeconds, info.drawAt)
      },
      onFudaiGrabbed: (info, result) => {
        room.fudaiCount++
        this.log(room.id, `参与福袋成功: ${info.type}`)
        this.updateRoomFudaiTiming(room, info.remainingSeconds, info.drawAt)
        if (result.won && (result.prizeType === 'physical' || result.prizeType === 'diamond')) {
          this.log(room.id, `识别到中奖: ${result.prizeType}`)
        } else if (result.prizeType === 'coupon') {
          this.log(room.id, '识别到优惠券，不计入中奖合计')
        }
        this.onFudaiGrabbed?.(room, result)
        room.status = 'monitoring'
        this.notifyUpdate(room)
      },
      onFudaiSkipped: (reason) => {
        this.log(room.id, `跳过福袋: ${reason}`)
        room.status = 'monitoring'
        this.notifyUpdate(room)
      },
      onFanBadgeAdded: (cost) => {
        room.hasFanBadge = true
        this.recordPreferredRoom(room)
        this.log(room.id, `已加入粉丝团，花费 ${cost} 钻石`)
        this.notifyUpdate(room)
      },
      onLog: (message) => this.log(room.id, message)
    })

    room.fudaiService = fudaiService
    await fudaiService.startMonitoring()
  }

  private updateRoomFudaiTiming(room: Room, remainingSeconds: number | null | undefined, drawAt?: number | null): void {
    const nextDrawAt = typeof drawAt === 'number' && drawAt > 0 ? drawAt : null
    const nextRemaining =
      nextDrawAt !== null
        ? Math.max(0, Math.ceil((nextDrawAt - Date.now()) / 1000))
        : typeof remainingSeconds === 'number'
          ? Math.floor(remainingSeconds)
          : null
    if (nextRemaining === null || nextRemaining <= 0) return
    if (typeof room.remainingSeconds === 'number' && room.remainingSeconds > 0 && nextRemaining > room.remainingSeconds + 60) {
      this.log(room.id, `忽略疑似下一轮福袋倒计时：当前=${room.remainingSeconds}秒，新检测=${nextRemaining}秒`)
      return
    }
    room.remainingSeconds = nextRemaining
    if (nextDrawAt !== null) room.drawAt = nextDrawAt
    else if (typeof remainingSeconds === 'number') room.drawAt = Date.now() + nextRemaining * 1000
    this.scheduleAutoCloseAfterDraw(room.id, room.name, Math.max(10, room.remainingSeconds + 5))
    this.notifyUpdate(room)
  }

  private scheduleAutoCloseAfterDraw(roomId: string, roomName: string, delaySeconds: number): void {
    const existing = this.autoCloseTimers.get(roomId)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      void (async () => {
        if (!this.rooms.has(roomId)) return
        this.log(roomId, `福袋开奖等待结束，关闭直播间: ${roomName}`)
        await this.removeRoom(roomId).catch((e: any) => {
          this.log(roomId, `关闭开奖后直播间失败: ${e.message}`)
        })
      })()
    }, delaySeconds * 1000)

    timer.unref?.()
    this.autoCloseTimers.set(roomId, timer)
    this.log(roomId, `已安排开奖后自动关闭，约 ${delaySeconds} 秒后执行`)
  }

  private recordPreferredRoom(room: Room): void {
    const preferredRooms = store.get('preferredRooms') || []
    const nextRooms = [
      { id: room.id, url: room.url, name: room.name },
      ...preferredRooms.filter((item) => item.url !== room.url)
    ].slice(0, 50)
    store.set('preferredRooms', nextRooms)
  }

  private toPublicRoom(room: Room): Omit<Room, 'page' | 'fudaiService'> {
    return {
      id: room.id,
      url: room.url,
      name: room.name,
      status: room.status,
      fudaiCount: room.fudaiCount,
      hasFanBadge: room.hasFanBadge,
      countdownText: room.countdownText,
      remainingSeconds: room.remainingSeconds,
      drawAt: room.drawAt
    }
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 7)
  }

  private extractRoomName(url: string): string {
    const match = url.match(/live\.douyin\.com\/([A-Za-z0-9_-]+)/)
    return match ? `直播间 ${match[1]}` : '直播间'
  }

  private normalizeRoomUrl(url: string): string {
    const trimmed = url.trim()
    if (!trimmed) throw new Error('直播间 URL 不能为空')

    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new Error('请输入完整的直播间 URL，例如 https://live.douyin.com/123456')
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('直播间 URL 必须以 http:// 或 https:// 开头')
    }
    if (!parsed.hostname.endsWith('douyin.com')) {
      throw new Error('仅支持抖音直播间 URL')
    }
    if (!parsed.pathname || parsed.pathname === '/') {
      throw new Error('直播间 URL 缺少房间路径')
    }

    parsed.hash = ''
    parsed.search = ''
    return parsed.toString()
  }

  private notifyUpdate(room: Room): void {
    this.onRoomUpdate?.(room)
  }

  private log(roomId: string, message: string): void {
    logInfo(`room:${roomId}`, message)
    this.onLog?.(roomId, message)
  }
}
