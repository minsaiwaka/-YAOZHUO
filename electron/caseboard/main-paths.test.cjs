// Execute the real entry against Electron API doubles, without starting a GUI or
// writing files. Both Windows and macOS path grammars exercise the packaged layout.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const fixtures = [
  { name: 'Windows development', packaged: false, paths: path.win32, directory: 'C:\\work\\app\\dist-caseboard-electron', appData: 'C:\\Users\\fixture\\AppData\\Roaming', documents: 'C:\\Users\\fixture\\Documents', data: 'C:\\work\\app\\.caseboard-data', output: 'C:\\work\\app\\outputs' },
  { name: 'Windows installed asar', packaged: true, paths: path.win32, directory: 'C:\\Apps\\Yaozhuo\\resources\\app.asar\\dist-caseboard-electron', appData: 'C:\\Users\\fixture\\AppData\\Roaming', documents: 'C:\\Users\\fixture\\Documents', data: 'C:\\Users\\fixture\\AppData\\Roaming\\謠诼', output: 'C:\\Users\\fixture\\Documents\\謠诼' },
  { name: 'macOS development', packaged: false, paths: path.posix, directory: '/work/app/dist-caseboard-electron', appData: '/Users/fixture/Library/Application Support', documents: '/Users/fixture/Documents', data: '/work/app/.caseboard-data', output: '/work/app/outputs' },
  { name: 'macOS installed app bundle', packaged: true, paths: path.posix, directory: '/Applications/謠诼.app/Contents/Resources/app.asar/dist-caseboard-electron', appData: '/Users/fixture/Library/Application Support', documents: '/Users/fixture/Documents', data: '/Users/fixture/Library/Application Support/謠诼', output: '/Users/fixture/Documents/謠诼' },
]
for (const fixture of fixtures) test(`${fixture.name}: writable data and exports are outside bundled assets`, async () => {
  const settings = new Map(), handlers = new Map(), created = []
  let window, loadedFile, loadedUrl, saveOptions, archiveOptions
  const renderer = fixture.paths.resolve(fixture.directory, '../caseboard-dist/caseboard.html')
  const electron = {
    app: { isPackaged: fixture.packaged, getPath: name => name === 'appData' ? fixture.appData : fixture.documents, setName() {}, setPath: (name, value) => settings.set(name, value), setAppLogsPath: value => settings.set('logs', value), whenReady: () => Promise.resolve(), on() {}, quit() {} },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    dialog: { showSaveDialog: async (_window, options) => { saveOptions = options; return { canceled: true } } },
    BrowserWindow: class {
      constructor(options) {
        window = this; this.options = options
        this.webContents = { mainFrame: { url: fixture.packaged ? 'file:///fixture.html' : 'http://127.0.0.1:3999/caseboard.html' }, setWindowOpenHandler() {}, on() {} }
      }
      on() {}
      loadURL(value) { loadedUrl = value; return Promise.resolve() }
      loadFile(value) { loadedFile = value; return Promise.resolve() }
      static getAllWindows() { return [] }
    },
  }
  const dependencies = {
    electron, 'node:fs': { mkdirSync: directory => created.push(directory) }, 'node:fs/promises': { writeFile: async () => {} },
    'node:path': fixture.paths, 'node:url': { fileURLToPath: () => renderer }, './native-client': { NativeArchiveService: class { constructor(options) { archiveOptions = options } dispose() { return Promise.resolve() } } }, './ai-client': {},
  }
  vm.runInNewContext(source, { exports: {}, URL, __dirname: fixture.directory, process: { env: { VITE_DEV_SERVER_URL: 'http://127.0.0.1:3999/' }, platform: fixture.paths === path.posix ? 'darwin' : 'win32' }, require: name => dependencies[name] })
  await Promise.resolve()
  assert.equal(settings.get('userData'), fixture.data)
  assert.equal(settings.get('sessionData'), fixture.paths.join(fixture.data, 'session'))
  assert.equal(settings.get('crashDumps'), fixture.paths.join(fixture.data, 'crashes'))
  assert.equal(settings.get('logs'), fixture.paths.join(fixture.data, 'logs'))
  assert.equal(window.options.webPreferences.preload, fixture.paths.join(fixture.directory, 'preload.js'))
  const projectRoot = fixture.paths.resolve(fixture.directory, '..')
  assert.equal(archiveOptions.workerPath, fixture.paths.join(fixture.packaged ? `${projectRoot}.unpacked` : projectRoot, 'dist-caseboard-electron', 'native-worker.js'))
  const mac = fixture.paths === path.posix
  const helperName = mac ? 'yaozhuo-key-reader' : 'yaozhuo-key-reader.exe'
  assert.equal(archiveOptions.keyHelperPath, fixture.packaged ? fixture.paths.resolve(projectRoot, mac ? '../../Helpers' : '../key-reader', helperName) : fixture.paths.join(projectRoot, 'resources/caseboard/key-reader', mac ? 'darwin' : 'win32', helperName))
  if (fixture.packaged) { assert.equal(loadedFile, renderer); assert.equal(loadedUrl, undefined) }
  else assert.equal(loadedUrl, 'http://127.0.0.1:3999/caseboard.html')
  await handlers.get('caseboard:save-file')({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, { name: 'poster', extension: 'json', content: '{}' })
  assert.equal(saveOptions.defaultPath, fixture.paths.join(fixture.output, 'poster.json'))
  if (fixture.packaged) assert(created.every(directory => !directory.includes('app.asar') && !directory.includes('.app/Contents')))
})

for (const fixture of fixtures.filter(value => value.paths === path.posix)) test(`${fixture.name}: closing and activating replaces the disposed archive`, async () => {
  const appEvents = new Map(), handlers = new Map(), archives = [], windows = [], liveWindows = new Set()
  const renderer = fixture.paths.resolve(fixture.directory, '../caseboard-dist/caseboard.html')
  let quitCalls = 0
  class Archive {
    constructor() { this.id = archives.length; this.disposed = false; archives.push(this) }
    dispose() { this.disposed = true; return Promise.resolve() }
    autoSetup(_options, signal) {
      assert.equal(this.disposed, false, 'the activated window must use a live archive')
      this.signal = signal
      if (this.id === 0) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic cancelled operation')), { once: true }))
      return Promise.resolve({ status: 'ready', archiveId: this.id })
    }
  }
  const electron = {
    app: {
      isPackaged: fixture.packaged,
      getPath: name => name === 'appData' ? fixture.appData : fixture.documents,
      setName() {}, setPath() {}, setAppLogsPath() {},
      whenReady: () => Promise.resolve(), on: (name, callback) => appEvents.set(name, callback),
      quit: () => { quitCalls++ },
    },
    safeStorage: { isEncryptionAvailable: () => true, decryptString: () => 'synthetic' },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    dialog: {},
    BrowserWindow: class {
      constructor() {
        this.events = new Map()
        this.webContents = { mainFrame: { url: fixture.packaged ? 'file:///fixture.html' : 'http://127.0.0.1:3999/caseboard.html' }, setWindowOpenHandler() {}, on() {}, isDestroyed: () => false, send() {} }
        windows.push(this); liveWindows.add(this)
      }
      on(name, callback) { this.events.set(name, callback) }
      loadURL() { return Promise.resolve() }
      loadFile() { return Promise.resolve() }
      static getAllWindows() { return [...liveWindows] }
    },
  }
  const dependencies = {
    electron, 'node:fs': { mkdirSync() {} }, 'node:fs/promises': { writeFile: async () => {} },
    'node:path': fixture.paths, 'node:url': { fileURLToPath: () => renderer },
    './native-client': { NativeArchiveService: Archive }, './ai-client': {},
  }
  vm.runInNewContext(source, { exports: {}, URL, AbortController, __dirname: fixture.directory, process: { env: { VITE_DEV_SERVER_URL: 'http://127.0.0.1:3999/' }, platform: 'darwin' }, require: name => dependencies[name] })
  await Promise.resolve()
  const eventFor = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame })
  assert.equal(archives.length, 1); assert.equal(windows.length, 1)
  const pending = handlers.get('caseboard:auto-setup')(eventFor(windows[0]), {})
  const cancelled = assert.rejects(pending, /synthetic cancelled operation/)
  liveWindows.delete(windows[0]); windows[0].events.get('closed')()
  await cancelled
  assert.equal(archives[0].signal.aborted, true)
  assert.equal(archives[0].disposed, true)
  assert.equal(archives.length, 2); assert.equal(archives[1].disposed, false)
  appEvents.get('window-all-closed')()
  assert.equal(quitCalls, 0, 'macOS remains alive with no window')
  appEvents.get('activate')()
  assert.equal(windows.length, 2)
  assert.equal(archives.length, 2, 'activation reuses the replacement archive')
  const result = await handlers.get('caseboard:auto-setup')(eventFor(windows[1]), {})
  assert.equal(result.status, 'ready'); assert.equal(result.archiveId, 1)
  assert.equal(archives[1].signal.aborted, false)
  // An explicit quit disposes the replacement and does not create another one
  // when the reopened window subsequently closes.
  let prevented = false
  appEvents.get('before-quit')({ preventDefault() { prevented = true } })
  assert.equal(prevented, true); assert.equal(archives[1].disposed, true)
  liveWindows.delete(windows[1]); windows[1].events.get('closed')()
  assert.equal(archives.length, 2)
  await Promise.resolve(); await Promise.resolve()
  assert.equal(quitCalls, 1)
})
