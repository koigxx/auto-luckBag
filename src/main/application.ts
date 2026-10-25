import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { BrowserManager } from './browser-manager'
import { AuthService } from './auth-service'
import { RoomManager } from './room-manager'
import { DiscoveryService } from './discovery-service'
import { StatsService } from './stats-service'
import { AutoRunner } from './auto-runner'
import { setupIpcHandlers } from './ipc-handlers'
import { setupAppMenu } from './app-menu'
import { installPipeErrorGuards, logInfo } from './logger'
import { execution,repository,sessionEngine,policy,haltPages,assertActive,paymentReason } from './runtime'
import { store } from './store'
import { setupAlerts } from './user-alerts'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

const browserManager = new BrowserManager()
const authService = new AuthService(browserManager)
const roomManager = new RoomManager(browserManager)
const discoveryService = new DiscoveryService(browserManager)
const statsService = new StatsService()
const autoRunner = new AutoRunner(discoveryService, roomManager, statsService, {execution,repository,sessionEngine,policy,haltPages,assertActive,paymentReason,store,now:Date.now,setTimer:fn=>setInterval(fn,1000),clearTimer:timer=>clearInterval(timer)})
roomManager.setUnexpectedClose(()=>{if(autoRunner.getState().running)void autoRunner.stop('参与页面意外关闭，请检查后手动启动')})
browserManager.setDisconnected(()=>{if(autoRunner.getState().running)void autoRunner.stop('工作浏览器意外关闭，请检查后手动启动')})
autoRunner.setResumeCheck(() => authService.validateSession())

installPipeErrorGuards()

function createWindow(): void {
  logInfo('app', 'creating main window')
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: '抖音福袋助手',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  setupIpcHandlers(
    mainWindow,
    browserManager,
    authService,
    roomManager,
    discoveryService,
    statsService,
    autoRunner
  )
  setupAppMenu(mainWindow)

  roomManager.clearSavedRooms()
}

function setupTray(): void {
  const pixels=Buffer.alloc(32*32*4)
  for(let y=0;y<32;y++)for(let x=0;x<32;x++){
    const i=(y*32+x)*4,white=(x>=14&&x<=17&&y>=6&&y<=27)||(y>=12&&y<=15&&x>=5&&x<=26)
    pixels[i]=white?255:75;pixels[i+1]=white?255:31;pixels[i+2]=white?255:217;pixels[i+3]=(x<3||x>28||y<3||y>28)?0:255
  }
  const icon = nativeImage.createFromBitmap(pixels,{width:32,height:32})
  tray = new Tray(icon)
  let previousStatus=''
  const updateTray=()=>{
    const state=autoRunner.getState()
    const labels:Record<string,string>={running:'运行中',draining:'收尾中',resting:'休息中','resume-check':'恢复检查',blocked:'异常已停止',stopped:'已停止'}
    const status=labels[state.status]||state.status
    if(previousStatus===status)return
    previousStatus=status
    tray?.setToolTip(`福袋助手 · ${status}`)
    tray?.setContextMenu(Menu.buildFromTemplate([
      {label:`当前：${status}`,enabled:false},
      {label:'显示窗口',click:()=>{mainWindow?.show();mainWindow?.focus()}},
      {label:'收尾后停止',enabled:state.running,click:()=>{void autoRunner.finishCurrent()}},
      {label:'立即停止',enabled:state.running,click:()=>{void autoRunner.stop()}},
      {type:'separator'},
      {label:'退出',click:()=>{isQuitting=true;app.quit()}}
    ]))
  }
  updateTray()
  const timer=setInterval(updateTray,3000)
  app.once('before-quit',()=>clearInterval(timer))
  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

app.on('second-instance',()=>{if(mainWindow?.isMinimized())mainWindow.restore();mainWindow?.show();mainWindow?.focus()})

app.whenReady().then(() => {
  logInfo('app', `ready, userData=${app.getPath('userData')}`)
  electronApp.setAppUserModelId('com.luckbag.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  setupTray()
  setupAlerts(mainWindow!,authService)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
  if (isQuitting) app.quit()
})

let cleanupComplete = false
app.on('before-quit', async (event) => {
  if (cleanupComplete) return
  event.preventDefault()
  if (isQuitting && cleanupStarted) return
  cleanupStarted = true
  isQuitting = true
  logInfo('app', 'before quit, cleanup start')
  await autoRunner.stop('应用退出')
  await roomManager.closeAllRooms()
  await discoveryService.close()
  await authService.saveSession().catch(() => logInfo('auth', 'session save failed; retaining previous login file'))
  await browserManager.close()
  logInfo('app', 'cleanup done')
  cleanupComplete = true
  app.quit()
})
let cleanupStarted = false
