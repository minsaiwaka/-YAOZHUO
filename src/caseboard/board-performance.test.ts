import test from 'node:test'
import assert from 'node:assert/strict'
import { createFrameQueue, createLabelObstacles, placeEdgeLabel } from './board-geometry'
import type { BoardPoint } from './board-geometry'

function clock() {
  let nextId = 0
  const callbacks = new Map<number, () => void>()
  return {
    request: (callback: () => void) => { callbacks.set(++nextId, callback); return nextId },
    cancel: (id: number) => { callbacks.delete(id) },
    pending: () => callbacks.size,
    paint: () => { const next = [...callbacks.values()]; callbacks.clear(); for (const callback of next) callback() },
  }
}

test('高頻拖動事件在一幀內合併，保留最後位置而非丟失終點', () => {
  const browser = clock()
  const applied: BoardPoint[] = []
  const queue = createFrameQueue<BoardPoint>(point => applied.push(point), browser.request, browser.cancel)
  for (let index = 0; index < 240; index++) queue.push({ x: index, y: index * 2 })
  assert.equal(browser.pending(), 1)
  assert.deepEqual(applied, [])
  browser.paint()
  assert.deepEqual(applied, [{ x: 239, y: 478 }])
  queue.push({ x: 241, y: 482 })
  browser.paint()
  assert.deepEqual(applied, [{ x: 239, y: 478 }, { x: 241, y: 482 }])
})

test('放開指針前同步提交最新一幀，原排程不會再次提交', () => {
  const browser = clock()
  const applied: number[] = []
  const queue = createFrameQueue<number>(point => applied.push(point), browser.request, browser.cancel)
  queue.push(12)
  queue.push(25)
  queue.flush()
  assert.deepEqual(applied, [25])
  assert.equal(browser.pending(), 0)
  browser.paint()
  queue.flush()
  assert.deepEqual(applied, [25])
})

test('取消拖動或切換人物後丟棄舊幀，後續手勢可繼續', () => {
  const browser = clock()
  const applied: string[] = []
  const queue = createFrameQueue<string>(scope => applied.push(scope), browser.request, browser.cancel)
  queue.push('舊人物')
  queue.cancel()
  assert.equal(browser.pending(), 0)
  browser.paint()
  queue.flush()
  assert.deepEqual(applied, [])
  queue.push('新人物')
  browser.paint()
  assert.deepEqual(applied, ['新人物'])
})

test('繪製中產生的新輸入排入下一幀，不被前一幀清除', () => {
  const browser = clock()
  const applied: number[] = []
  const queue = createFrameQueue<number>(value => { applied.push(value); if (value === 1) queue.push(2) }, browser.request, browser.cancel)
  queue.push(1)
  browser.paint()
  assert.deepEqual(applied, [1])
  assert.equal(browser.pending(), 1)
  browser.paint()
  assert.deepEqual(applied, [1, 2])
})

function oldPlacement(start: BoardPoint, control: BoardPoint, end: BoardPoint, width: number, positions: Record<string, BoardPoint>, centerId?: string) {
  const nodes = Object.entries(positions)
  const candidates = [.5, .35, .65, .25, .75].map(t => ({ x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * control.x + t ** 2 * end.x, y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * control.y + t ** 2 * end.y }))
  const clear = (candidate: BoardPoint) => nodes.every(([id, point]) => Math.abs(candidate.x - point.x) > width / 2 + (id === centerId ? 168 : 148) / 2 + 9 || Math.abs(candidate.y - point.y) > 17 + (id === centerId ? 152 : 128) / 2)
  const onLine = candidates.find(clear)
  if (onLine) return onLine
  for (const shift of [-35, 35, -70, 70, -105, 105]) { const point = { x: candidates[0].x, y: candidates[0].y + shift }; if (clear(point)) return point }
  return candidates[0]
}

test('標籤空間索引與原避讓規則一致，包括負座標、中心卡和緊貼邊界', () => {
  const positions: Record<string, BoardPoint> = { center: { x: 0, y: 0 }, left: { x: -400, y: 80 }, far: { x: 1e7, y: -1e7 } }
  const boundaries = createLabelObstacles(positions, 'center')
  assert.equal(boundaries.clear({ x: 125, y: 0 }, 64), false)
  assert.equal(boundaries.clear({ x: 125.001, y: 0 }, 64), true)
  assert.equal(boundaries.clear({ x: 0, y: 93 }, 64), false)
  assert.equal(boundaries.clear({ x: 0, y: 93.001 }, 64), true)
  for (let index = 0; index < 1200; index++) positions[`n${index}`] = { x: index % 40 * 220 - 4400, y: Math.floor(index / 40) * 190 - 2850 }
  const obstacles = createLabelObstacles(positions, 'center')
  let seed = 1729
  const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 2 ** 32 }
  for (let index = 0; index < 500; index++) {
    const start = { x: random() * 10000 - 5000, y: random() * 8000 - 4000 }
    const end = { x: random() * 10000 - 5000, y: random() * 8000 - 4000 }
    const control = { x: (start.x + end.x) / 2 + random() * 300, y: (start.y + end.y) / 2 + random() * 300 }
    const width = 64 + Math.floor(random() * 180)
    assert.deepEqual(placeEdgeLabel(start, control, end, width, obstacles), oldPlacement(start, control, end, width, positions, 'center'))
  }
})

test('空畫布和所有候選點被遮擋時仍保留可定位的關係標籤', () => {
  const start = { x: -200, y: 0 }, end = { x: 200, y: 0 }, control = { x: 0, y: 0 }
  assert.deepEqual(placeEdgeLabel(start, control, end, 64, createLabelObstacles({})), { x: 0, y: 0 })
  const positions: Record<string, BoardPoint> = {}
  for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) positions[`${x}/${y}`] = { x: x * 74, y: y * 64 }
  assert.deepEqual(placeEdgeLabel(start, control, end, 220, createLabelObstacles(positions)), { x: 0, y: 0 })
})
