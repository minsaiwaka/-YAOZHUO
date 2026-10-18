// Browser storage semantics exercised with an isolated, transactional IDB mock.
// No real browser profile, document, database or localStorage is opened.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const ts = require('typescript')
const filename = path.resolve(__dirname, '../../src/caseboard/storage.ts')
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const plain = value => JSON.parse(JSON.stringify(value))
const encoded = key => JSON.stringify(key)

function mockIDB() {
  const data = new Map(), puts = [], deletes = [], transactions = []
  let opened = false, opens = 0, failWrite = false
  const api = {
    data, puts, deletes,
    get opens() { return opens },
    failNextWrite() { failWrite = true },
    set(key, value) { data.set(encoded(key), structuredClone(value)) },
    get(key) { return data.get(encoded(key)) },
    open() {
      opens++
      const request = {}
      const db = {
        closed: false,
        createObjectStore() {},
        close() { this.closed = true; this.onclose?.() },
        transaction(_name, mode) {
          if (this.closed) throw new Error('InvalidStateError')
          let active = false, finished = false, pending = 0, working
          const waiting = []
          const tx = {
            error: null,
            objectStore() { return store },
            start() {
              active = true; working = new Map(data)
              for (const action of waiting.splice(0)) queueMicrotask(action)
              check()
            },
          }
          function finish(error) {
            if (finished) return
            finished = true
            if (error) { tx.error = error; tx.onerror?.(); tx.onabort?.() }
            else {
              if (mode === 'readwrite') { data.clear(); for (const [key, value] of working) data.set(key, value) }
              tx.oncomplete?.()
            }
            transactions.shift()
            transactions[0]?.start()
          }
          function check() { setImmediate(() => { if (active && !finished && !pending) finish() }) }
          function request(action) {
            if (finished) throw new Error('TransactionInactiveError')
            const result = {}; pending++
            const run = () => {
              if (finished) return
              try { result.result = action(); result.onsuccess?.() }
              catch (error) { result.error = error; result.onerror?.(); finish(error) }
              pending--; check()
            }
            if (active) queueMicrotask(run); else waiting.push(run)
            return result
          }
          const store = {
            get(key) { return request(() => structuredClone(working.get(encoded(key)))) },
            put(value, key) {
              const captured = structuredClone(value)
              puts.push({ key: structuredClone(key), value: captured })
              return request(() => {
                if (failWrite) { failWrite = false; throw new Error('Synthetic quota failure') }
                working.set(encoded(key), captured); return key
              })
            },
            delete(key) { deletes.push(structuredClone(key)); return request(() => { working.delete(encoded(key)) }) },
          }
          transactions.push(tx)
          if (transactions.length === 1) tx.start()
          return tx
        },
      }
      api.lastConnection = db
      queueMicrotask(() => {
        request.result = db
        if (!opened) { opened = true; request.onupgradeneeded?.() }
        request.onsuccess?.()
      })
      return request
    },
  }
  return api
}

function harness() {
  const idb = mockIDB(), values = new Map(), writes = []
  let failSetting = false, now = 0, nextTimer = 0
  const timers = new Map()
  const window = new EventTarget(), document = new EventTarget()
  document.visibilityState = 'visible'
  const localStorage = {
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { if (failSetting) throw new Error('Synthetic storage failure'); values.set(key, String(value)); writes.push({ key, value }) },
  }
  const module = { exports: {} }
  const context = { module, exports: module.exports, indexedDB: idb, localStorage, crypto, queueMicrotask, window, document,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, due: now + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
  }
  vm.runInNewContext(compiled, context, { filename })
  return { api: module.exports, idb, values, writes, window, document,
    failSettings(value) { failSetting = value },
    tick(duration) {
      now += duration
      for (;;) {
        const ready = [...timers].find(([, timer]) => timer.due <= now)
        if (!ready) break
        timers.delete(ready[0]); ready[1].callback()
      }
    },
  }
}
const image = 'data:image/png;base64,' + 'a'.repeat(2 * 1024 * 1024)
const board = (x = 1, url = image) => ({ layout: { person: { x, y: 2 } }, items: [{ id: 'image-1', type: 'image', title: '合成圖片', dataUrl: url, x, y: 2, width: 100, height: 100, evidenceIds: ['original-1'] }], zoom: 1 })

test('one reusable IDB connection restores datasets, separated image boards and old inline board format', async () => {
  const h = harness(), dataset = { schemaVersion: 1, id: 'synthetic', messages: [] }
  await h.api.storeDataset(dataset)
  assert.deepEqual(plain(await h.api.readDataset()), dataset)
  await h.api.storeBoard('a', board())
  assert.deepEqual(plain(await h.api.readBoard('a')), board())
  assert.equal(h.idb.opens, 1)
  const metadata = h.idb.get('board:a')
  assert.equal(metadata.storageVersion, 2)
  assert.deepEqual(metadata.images, ['image-1'])
  assert.equal(JSON.stringify(metadata).includes('data:image'), false)
  assert.equal(h.idb.get(['board-image', 'a', 'image-1']), image)
  h.idb.set('board:legacy', board(7))
  assert.deepEqual(plain(await h.api.readBoard('legacy')), board(7))
  await h.api.storeBoard('legacy', board(8))
  assert.deepEqual(plain(await h.api.readBoard('legacy')), board(8))
  h.idb.lastConnection.onversionchange()
  assert.deepEqual(plain(await h.api.readBoard('a')), board())
  assert.equal(h.idb.opens, 2)
})

test('moving and resizing write small metadata only; image removal is isolated to its own board', async () => {
  const h = harness()
  await h.api.storeBoard('a', board())
  await h.api.storeBoard('b', board(4))
  const imagePuts = () => h.idb.puts.filter(put => Array.isArray(put.key))
  assert.equal(imagePuts().length, 2)
  for (let index = 2; index < 10; index++) await h.api.storeBoard('a', board(index))
  assert.equal(imagePuts().length, 2, 'the 2 MiB image must not be cloned into repeated puts')
  await h.api.storeBoard('a', { ...board(10), items: [] })
  assert.equal(h.idb.get(['board-image', 'a', 'image-1']), undefined)
  assert.equal(h.idb.get(['board-image', 'b', 'image-1']), image)
  assert.deepEqual(h.idb.deletes, [['board-image', 'a', 'image-1']])
  assert.deepEqual(plain(await h.api.readBoard('b')), board(4))
})

test('fast saves coalesce in key order, capture mutable fields and survive switching boards before completion', async () => {
  const h = harness(), jobs = []
  for (let index = 0; index < 20; index++) jobs.push(h.api.storeBoard('a', board(index)))
  const other = board(88)
  jobs.push(h.api.storeBoard('b', other))
  other.items[0].x = -1; other.layout.person.x = -1; other.items[0].evidenceIds.push('later-mutation')
  const switchedBack = h.api.readBoard('a')
  await Promise.all(jobs)
  assert.deepEqual(plain(await switchedBack), board(19))
  assert.deepEqual(plain(await h.api.readBoard('b')), board(88))
  assert.equal(h.idb.puts.filter(put => put.key === 'board:a').length, 1)
})

test('aborted board writes leave committed images intact and a subsequent retry writes changed bytes', async () => {
  const h = harness()
  await h.api.storeBoard('a', board())
  h.idb.failNextWrite()
  await assert.rejects(h.api.storeBoard('a', board(2, image + 'new')), /Synthetic quota/)
  assert.deepEqual(plain(await h.api.readBoard('a')), board())
  await h.api.storeBoard('a', board(2, image + 'new'))
  assert.deepEqual(plain(await h.api.readBoard('a')), board(2, image + 'new'))
  assert.equal(h.idb.puts.filter(put => Array.isArray(put.key) && put.value === image + 'new').length, 2)
})

test('a changed persisted revision invalidates stale in-memory image comparisons', async () => {
  const h = harness()
  await h.api.storeBoard('a', board())
  const changed = structuredClone(h.idb.get('board:a')); changed.revision = 'other-tab'
  h.idb.set('board:a', changed)
  h.idb.set(['board-image', 'a', 'image-1'], 'data:image/png;base64,other-tab')
  await h.api.storeBoard('a', board(3))
  assert.deepEqual(plain(await h.api.readBoard('a')), board(3))
  assert.equal(h.idb.puts.filter(put => Array.isArray(put.key)).length, 2)
})

test('settings merge 300 ms typing, flush synchronously on hide and retain the final value after a recoverable failure', () => {
  const h = harness()
  for (let index = 0; index < 20; index++) h.api.scheduleSetting('notes', { a: `文字 ${index}` })
  h.tick(299); assert.equal(h.writes.length, 0)
  assert.deepEqual(plain(h.api.readSetting('notes', {})), { a: '文字 19' })
  h.tick(1); assert.equal(h.writes.length, 1)
  assert.equal(h.values.get('yaozhuo:notes'), JSON.stringify({ a: '文字 19' }))
  h.api.scheduleSetting('notes', { a: '關閉前的最終內容' })
  h.window.dispatchEvent(new Event('pagehide'))
  assert.equal(h.values.get('yaozhuo:notes'), JSON.stringify({ a: '關閉前的最終內容' }))
  h.api.scheduleSetting('notes', { a: '背景前的最終內容' })
  h.document.visibilityState = 'hidden'; h.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(h.values.get('yaozhuo:notes'), JSON.stringify({ a: '背景前的最終內容' }))
  let failures = 0
  h.failSettings(true); h.api.scheduleSetting('notes', { a: '失敗後仍保留' }, () => failures++)
  h.tick(300); assert.equal(failures, 1)
  assert.deepEqual(plain(h.api.readSetting('notes', {})), { a: '失敗後仍保留' })
  h.failSettings(false); h.window.dispatchEvent(new Event('pagehide'))
  assert.equal(h.values.get('yaozhuo:notes'), JSON.stringify({ a: '失敗後仍保留' }))
  h.api.scheduleSetting('notes', { a: '舊定時內容' }); h.api.storeSetting('notes', { a: '新導入內容' }); h.tick(300)
  assert.equal(h.values.get('yaozhuo:notes'), JSON.stringify({ a: '新導入內容' }))
})
