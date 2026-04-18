import { app, BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron'
import { store } from './store'

type MenuLanguage = 'zh-CN' | 'en-US'

const labels: Record<MenuLanguage, Record<string, string>> = {
  'zh-CN': {
    file: '文件',
    close: '关闭窗口',
    quit: '退出',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    view: '视图',
    reload: '重新加载',
    forceReload: '强制重新加载',
    devTools: '开发者工具',
    resetZoom: '重置缩放',
    zoomIn: '放大',
    zoomOut: '缩小',
    toggleFullscreen: '全屏',
    window: '窗口',
    minimize: '最小化',
    help: '帮助',
    about: '关于抖音福袋助手'
  },
  'en-US': {
    file: 'File',
    close: 'Close Window',
    quit: 'Quit',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    view: 'View',
    reload: 'Reload',
    forceReload: 'Force Reload',
    devTools: 'Developer Tools',
    resetZoom: 'Reset Zoom',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    toggleFullscreen: 'Toggle Full Screen',
    window: 'Window',
    minimize: 'Minimize',
    help: 'Help',
    about: 'About Douyin Lucky Bag Assistant'
  }
}

export function setupAppMenu(mainWindow?: BrowserWindow | null): void {
  const language = store.get('language') as MenuLanguage
  const t = labels[language] || labels['zh-CN']

  const template: MenuItemConstructorOptions[] = [
    {
      label: t.file,
      submenu: [
        {
          label: t.close,
          accelerator: 'CmdOrCtrl+W',
          click: () => mainWindow?.hide()
        },
        { type: 'separator' },
        {
          label: t.quit,
          accelerator: 'CmdOrCtrl+Q',
          click: () => app.quit()
        }
      ]
    },
    {
      label: t.edit,
      submenu: [
        { label: t.undo, role: 'undo' },
        { label: t.redo, role: 'redo' },
        { type: 'separator' },
        { label: t.cut, role: 'cut' },
        { label: t.copy, role: 'copy' },
        { label: t.paste, role: 'paste' },
        { type: 'separator' },
        { label: t.selectAll, role: 'selectAll' }
      ]
    },
    {
      label: t.view,
      submenu: [
        { label: t.reload, role: 'reload' },
        { label: t.forceReload, role: 'forceReload' },
        { label: t.devTools, role: 'toggleDevTools' },
        { type: 'separator' },
        { label: t.resetZoom, role: 'resetZoom' },
        { label: t.zoomIn, role: 'zoomIn' },
        { label: t.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: t.toggleFullscreen, role: 'togglefullscreen' }
      ]
    },
    {
      label: t.window,
      submenu: [
        { label: t.minimize, role: 'minimize' },
        {
          label: t.close,
          click: () => mainWindow?.hide()
        }
      ]
    },
    {
      label: t.help,
      submenu: [
        {
          label: t.about,
          click: () => {
            mainWindow?.webContents.send('log:add', {
              roomId: 'system',
              message: t.about,
              time: Date.now()
            })
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
