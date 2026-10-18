import type { BoardDocument, CaseDataset } from './types'

const databaseName = 'yaozhuo-caseboard-local-v1'
let connection: IDBDatabase | undefined
let opening: Promise<IDBDatabase> | undefined
function database(): Promise<IDBDatabase> {
  if (connection) return Promise.resolve(connection)
  if (opening) return opening
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('documents')
    request.onsuccess = () => {
      const db = request.result
      connection = db
      opening = undefined
      const forget = () => { if (connection === db) connection = undefined }
      db.onclose = forget
      db.onversionchange = () => { forget(); db.close() }
      resolve(db)
    }
    request.onerror = () => { opening = undefined; reject(request.error) }
  }).catch(error => { opening = undefined; throw error })
  return opening
}

export async function readDataset(): Promise<CaseDataset | null> {
  const db = await database()
  return await new Promise((resolve, reject) => {
    const tx = db.transaction('documents', 'readonly')
    const request = tx.objectStore('documents').get('active')
    tx.oncomplete = () => resolve(request.result || null)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}
export async function storeDataset(value: CaseDataset): Promise<void> {
  const db = await database()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('documents', 'readwrite')
    tx.objectStore('documents').put(value, 'active')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

type StoredBoard = { storageVersion: 2; revision: string; document: BoardDocument; images: string[] }
type ImageCache = { revision: string; images: Map<string, string> }
const imageCaches = new Map<string, ImageCache>()
function rememberImages(key: string, value: ImageCache): void {
  imageCaches.delete(key)
  imageCaches.set(key, value)
  // Retain the current/recent board, rather than every image ever visited.
  while (imageCaches.size > 2) imageCaches.delete(imageCaches.keys().next().value!)
}
const imageKey = (board: string, item: string): IDBValidKey => ['board-image', board, item]
const storedBoard = (value: unknown): value is StoredBoard => !!value && typeof value === 'object' &&
  (value as StoredBoard).storageVersion === 2 && typeof (value as StoredBoard).revision === 'string' &&
  Array.isArray((value as StoredBoard).images) && Array.isArray((value as StoredBoard).document?.items)

type BoardJob = { value: BoardDocument; resolve: Array<() => void>; reject: Array<(error: unknown) => void> }
type BoardQueue = { next?: BoardJob; running: boolean; drained: Promise<void>; finish: () => void }
const boardQueues = new Map<string, BoardQueue>()

export async function readBoard(key: string): Promise<BoardDocument | null> {
  // Switching away and immediately back must observe the last queued draft.
  await boardQueues.get(key)?.drained
  const db = await database()
  return await new Promise((resolve, reject) => {
    const tx = db.transaction('documents', 'readonly'), store = tx.objectStore('documents')
    const request = store.get(`board:${key}`)
    let value: BoardDocument | null = null, saved: StoredBoard | undefined
    const images = new Map<string, string>()
    request.onsuccess = () => {
      if (!request.result) return
      if (!storedBoard(request.result)) { value = request.result as BoardDocument; return }
      saved = request.result
      value = saved.document
      for (const id of saved.images) {
        const image = store.get(imageKey(key, id))
        image.onsuccess = () => { if (typeof image.result === 'string') images.set(id, image.result) }
      }
    }
    tx.oncomplete = () => {
      if (saved && value) {
        if (saved.images.some(id => !images.has(id))) { reject(new Error('畫布圖片資料不完整，請重新導入保存的線索板。')); return }
        value = { ...value, items: value.items.map(item => images.has(item.id) ? { ...item, dataUrl: images.get(item.id)! } : item) }
        rememberImages(key, { revision: saved.revision, images })
      }
      resolve(value)
    }
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

async function commitBoard(key: string, value: BoardDocument): Promise<void> {
  const db = await database()
  const images = new Map<string, string>()
  const document: BoardDocument = { ...value, items: value.items.map(item => {
    if (!item.dataUrl) return item
    if (images.has(item.id) && images.get(item.id) !== item.dataUrl) throw new Error('畫布包含識別碼相同但內容不同的圖片，請重新導入。')
    images.set(item.id, item.dataUrl)
    const { dataUrl: _dataUrl, ...metadata } = item
    return metadata
  }) }
  const saved: StoredBoard = { storageVersion: 2, revision: crypto.randomUUID(), document, images: [...images.keys()] }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('documents', 'readwrite'), store = tx.objectStore('documents')
    const previous = store.get(`board:${key}`)
    const write = (priorImages: Map<string, string>, priorIds: string[]) => {
      for (const [id, url] of images) if (priorImages.get(id) !== url) store.put(url, imageKey(key, id))
      for (const id of priorIds) if (!images.has(id)) store.delete(imageKey(key, id))
      store.put(saved, `board:${key}`)
    }
    previous.onsuccess = () => {
      if (!storedBoard(previous.result)) { write(new Map(), []); return }
      const prior = previous.result
      const cache = imageCaches.get(key)
      if (cache?.revision === prior.revision) { write(cache.images, prior.images); return }
      // Another tab may have saved the same board. Reconcile its revision in
      // this transaction before using an in-memory image equality shortcut.
      const priorImages = new Map<string, string>()
      let remaining = prior.images.length
      if (!remaining) { write(priorImages, []); return }
      for (const id of prior.images) {
        const image = store.get(imageKey(key, id))
        image.onsuccess = () => {
          if (typeof image.result === 'string') priorImages.set(id, image.result)
          if (!--remaining) write(priorImages, prior.images)
        }
      }
    }
    tx.oncomplete = () => { rememberImages(key, { revision: saved.revision, images }); resolve() }
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

async function drainBoard(key: string, queue: BoardQueue): Promise<void> {
  if (queue.running) return
  queue.running = true
  while (queue.next) {
    const job = queue.next
    queue.next = undefined
    try { await commitBoard(key, job.value); for (const resolve of job.resolve) resolve() }
    catch (error) { for (const reject of job.reject) reject(error) }
  }
  boardQueues.delete(key)
  queue.finish()
}

export function storeBoard(key: string, value: BoardDocument): Promise<void> {
  // Strings are immutable: capture small editable fields without cloning each
  // multi-megabyte data URL on every move, resize or keystroke.
  const captured = { ...value, layout: Object.fromEntries(Object.entries(value.layout).map(([id, position]) => [id, { ...position }])), items: value.items.map(item => ({ ...item, ...(item.evidenceIds ? { evidenceIds: [...item.evidenceIds] } : {}) })) }
  let queue = boardQueues.get(key)
  if (!queue) {
    let finish!: () => void
    const drained = new Promise<void>(resolve => { finish = resolve })
    queue = { running: false, drained, finish }
    boardQueues.set(key, queue)
    queueMicrotask(() => { void drainBoard(key, queue!) })
  }
  return new Promise((resolve, reject) => {
    if (queue!.next) { queue!.next.value = captured; queue!.next.resolve.push(resolve); queue!.next.reject.push(reject) }
    else queue!.next = { value: captured, resolve: [resolve], reject: [reject] }
  })
}

type PendingSetting = { value: unknown; onFailure?: () => void; timer?: ReturnType<typeof setTimeout> }
const pendingSettings = new Map<string, PendingSetting>()
let settingListeners = false
function writeSetting(key: string, value: unknown): boolean {
  try { localStorage.setItem(`yaozhuo:${key}`, JSON.stringify(value)); return true } catch { return false }
}
function flushSetting(key: string): void {
  const pending = pendingSettings.get(key)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingSettings.delete(key)
  if (!writeSetting(key, pending.value)) {
    // Retain the current value for a later visibility/pagehide retry.
    pending.timer = undefined
    pendingSettings.set(key, pending)
    try { pending.onFailure?.() } catch { /* A UI callback cannot block other drafts. */ }
  }
}
function flushSettings(): void { for (const key of [...pendingSettings.keys()]) flushSetting(key) }
export function scheduleSetting(key: string, value: unknown, onFailure?: () => void): void {
  if (!settingListeners && typeof window !== 'undefined' && typeof document !== 'undefined') {
    settingListeners = true
    window.addEventListener('pagehide', flushSettings)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSettings() })
  }
  clearTimeout(pendingSettings.get(key)?.timer)
  const pending: PendingSetting = { value, onFailure }
  pending.timer = setTimeout(() => flushSetting(key), 300)
  pendingSettings.set(key, pending)
}
export function readSetting<T>(key: string, fallback: T): T {
  if (pendingSettings.has(key)) return (pendingSettings.get(key)!.value ?? fallback) as T
  try { return JSON.parse(localStorage.getItem(`yaozhuo:${key}`) || 'null') ?? fallback } catch { return fallback }
}
export function storeSetting(key: string, value: unknown): boolean {
  clearTimeout(pendingSettings.get(key)?.timer)
  pendingSettings.delete(key)
  return writeSetting(key, value)
}
