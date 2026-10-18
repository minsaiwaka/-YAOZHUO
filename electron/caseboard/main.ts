import { app, BrowserWindow, dialog, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeArchiveService } from './native-client'
import { generateSummary } from './ai-client'
import type { CaseboardBridge, ConnectionOptions, LoadOptions, NativeOpenOptions, NativeAutoOptions } from '../../src/caseboard/types'

const projectRoot = resolve(__dirname, '..')
// Bundled assets remain inside app.asar; mutable data must use a user-owned path.
const dataRoot = app.isPackaged ? join(app.getPath('appData'), '謠诼') : join(projectRoot, '.caseboard-data')
// The bundled reader owns its snapshots; no external application or HTTP API is used.
app.setName('謠诼')
for (const directory of [dataRoot, join(dataRoot, 'session'), join(dataRoot, 'crashes'), join(dataRoot, 'logs')]) mkdirSync(directory, { recursive: true })
app.setPath('userData', dataRoot)
app.setPath('sessionData', join(dataRoot, 'session'))
app.setPath('crashDumps', join(dataRoot, 'crashes'))
app.setAppLogsPath(join(dataRoot, 'logs'))
// A physical worker entry avoids depending on Node's worker loader understanding asar.
const keyHelperName = process.platform === 'win32' ? 'yaozhuo-key-reader.exe' : 'yaozhuo-key-reader'
const keyHelperPath = app.isPackaged ? process.platform === 'darwin' ? resolve(projectRoot, '../../Helpers', keyHelperName) : resolve(projectRoot, '../key-reader', keyHelperName) : join(projectRoot, 'resources/caseboard/key-reader', process.platform, keyHelperName)
const createArchive = () => new NativeArchiveService({ workerPath: join(app.isPackaged ? `${projectRoot}.unpacked` : projectRoot, 'dist-caseboard-electron', 'native-worker.js'), dataRoot, documents: app.getPath('documents'), keyHelperPath, decryptProtected: ciphertext => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储不可用')
  return safeStorage.decryptString(ciphertext)
} })
let archive = createArchive()

let window: BrowserWindow | null = null
let activeLoad: AbortController | null = null
let activeSummary: AbortController | null = null
const rendererFile = join(projectRoot, 'caseboard-dist', 'caseboard.html')
const devUrl = !app.isPackaged && process.env.VITE_DEV_SERVER_URL ? new URL('caseboard.html', process.env.VITE_DEV_SERVER_URL.endsWith('/') ? process.env.VITE_DEV_SERVER_URL : `${process.env.VITE_DEV_SERVER_URL}/`).href : ''

function trusted(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('此页面无权调用档案工具')
  const address = event.senderFrame?.url || ''
  try {
    if (devUrl ? new URL(address).origin === new URL(devUrl).origin && new URL(address).pathname === new URL(devUrl).pathname
      : new URL(address).protocol === 'file:' && resolve(fileURLToPath(address.split('#')[0])) === resolve(rendererFile)) return
  } catch { /* A closed or navigated frame must never acquire file/network capabilities. */ }
  throw new Error('此页面无权调用档案工具')
}

ipcMain.handle('caseboard:discover', async event => { trusted(event); return archive.discover() })
ipcMain.handle('caseboard:auto-setup', async (event, options: NativeAutoOptions) => {
  trusted(event)
  if (activeLoad) throw new Error('已有读取任务，请等待完成或先取消')
  const controller = new AbortController(); activeLoad = controller
  try { return await archive.autoSetup(options, controller.signal, progress => { if (!event.sender.isDestroyed()) event.sender.send('caseboard:progress', progress) }) }
  finally { if (activeLoad === controller) activeLoad = null }
})
ipcMain.handle('caseboard:choose-folder', async event => {
  trusted(event)
  const result = await dialog.showOpenDialog(window!, { title: '选择微信账号资料目录', properties: ['openDirectory', 'dontAddToRecent'] })
  return result.canceled ? {} : { path: result.filePaths[0] }
})
ipcMain.handle('caseboard:close-connection', async (event, options: ConnectionOptions) => { trusted(event); await archive.close(options) })
ipcMain.handle('caseboard:catalog', async (event, options: NativeOpenOptions) => {
  trusted(event)
  if (activeLoad) throw new Error('已有读取任务，请等待完成或先取消')
  const controller = new AbortController()
  activeLoad = controller
  try { return await archive.open({ ...options, clientId: 'desktop' }, controller.signal, progress => { if (!event.sender.isDestroyed()) event.sender.send('caseboard:progress', progress) }) }
  finally { if (activeLoad === controller) activeLoad = null }
})
ipcMain.handle('caseboard:load', async (event, options: LoadOptions) => {
  trusted(event)
  if (activeLoad) throw new Error('已有读取任务，请等待完成或先取消')
  const controller = new AbortController()
  activeLoad = controller
  try {
    return await archive.load(options, controller.signal, progress => {
      if (!event.sender.isDestroyed()) event.sender.send('caseboard:progress', progress)
    })
  } finally {
    if (activeLoad === controller) activeLoad = null
  }
})
ipcMain.handle('caseboard:cancel-load', async event => { trusted(event); activeLoad?.abort() })
ipcMain.handle('caseboard:media', async (event, options: Parameters<CaseboardBridge['media']>[0]) => {
  trusted(event)
  return archive.media(options)
})
ipcMain.handle('caseboard:summarize', async (event, options: Parameters<CaseboardBridge['summarize']>[0]) => {
  trusted(event)
  if (activeSummary) throw new Error('已有 AI 整理任务，请等待完成或先取消')
  const controller = new AbortController()
  activeSummary = controller
  try {
    return await generateSummary(options, controller.signal, progress => {
      if (!event.sender.isDestroyed()) event.sender.send('caseboard:summary-progress', progress)
    })
  } finally {
    if (activeSummary === controller) activeSummary = null
  }
})
ipcMain.handle('caseboard:cancel-summary', async event => { trusted(event); activeSummary?.abort() })
ipcMain.handle('caseboard:save-file', async (event, options: Parameters<CaseboardBridge['saveFile']>[0]) => {
  trusted(event)
  if (!options || !['md', 'json', 'html'].includes(options.extension) || typeof options.content !== 'string' || typeof options.name !== 'string') throw new Error('只支持 Markdown、JSON 或 HTML 文本导出')
  const name = basename(options.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || '謠诼-关系与记忆档案'
  const fileName = `${name.replace(/\.(md|json|html)$/i, '')}.${options.extension}`
  const directory = app.isPackaged ? join(app.getPath('documents'), '謠诼') : join(projectRoot, 'outputs')
  mkdirSync(directory, { recursive: true })
  const result = await dialog.showSaveDialog(window!, {
    title: '保存謠诼档案', defaultPath: join(directory, fileName),
    filters: [{ name: { md: 'Markdown 文档', json: 'JSON 档案', html: 'HTML 报告' }[options.extension], extensions: [options.extension] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  })
  if (result.canceled || !result.filePath) return { saved: false }
  let target = result.filePath
  if (!extname(target)) target += `.${options.extension}`
  if (extname(target).toLowerCase() !== `.${options.extension}`) throw new Error(`请选择 .${options.extension} 文件扩展名`)
  await writeFile(target, options.content, 'utf8')
  return { saved: true, path: target }
})

function createWindow(): void {
  const current = new BrowserWindow({
    title: '謠诼 · 关系与记忆档案', width: 1400, height: 900, minWidth: 1080, minHeight: 700,
    backgroundColor: '#e4f0e9', autoHideMenuBar: true,
    icon: join(projectRoot, 'caseboard-dist', 'caseboard', 'icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  })
  window = current
  current.on('page-title-updated', event => event.preventDefault())
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  current.webContents.on('will-navigate', event => event.preventDefault())
  current.on('closed', () => {
    activeLoad?.abort(); activeSummary?.abort()
    const closedArchive = archive
    void closedArchive.dispose()
    // macOS keeps the app alive after the last window closes.
    if (process.platform === 'darwin' && !quitting) archive = createArchive()
    if (window === current) window = null
  })
  if (devUrl) void current.loadURL(devUrl)
  else void current.loadFile(rendererFile)
}

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
let quitting = false
app.on('before-quit', event => {
  activeLoad?.abort(); activeSummary?.abort()
  if (!quitting) { event.preventDefault(); quitting = true; void archive.dispose().finally(() => app.quit()) }
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
