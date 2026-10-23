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

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

const browserManager = new BrowserManager()
const authService = new AuthService(browserManager)
const roomManager = new RoomManager(browserManager)
const discoveryService = new DiscoveryService(browserManager)
const statsService = new StatsService()
const autoRunner = new AutoRunner(discoveryService, roomManager, statsService, {execution,repository,sessionEngine,policy,haltPages,assertActive,paymentReason,store,now:Date.now,setTimer:fn=>setInterval(fn,1000),clearTimer:timer=>clearInterval(timer)})
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
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
  )
  tray = new Tray(icon)
  tray.setToolTip('抖音福袋助手')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示窗口',
        click: () => {
          mainWindow?.show()
          mainWindow?.focus()
        }
      },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

app.whenReady().then(() => {
  logInfo('app', `ready, userData=${app.getPath('userData')}`)
  electronApp.setAppUserModelId('com.luckbag.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  setupTray()

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
