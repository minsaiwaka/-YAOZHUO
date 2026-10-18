export interface BoardPoint { x: number; y: number }
interface Obstacle { left: number; right: number; top: number; bottom: number }

/** Reuse the node bounds while locating the few labels actually shown on screen. */
export function createLabelObstacles(positions: Record<string, BoardPoint>, centerId?: string) {
  const cellSize = 192
  const cells = new Map<string, Obstacle[]>()
  for (const [id, point] of Object.entries(positions)) {
    const width = id === centerId ? 168 : 148
    const height = id === centerId ? 152 : 128
    const obstacle = { left: point.x - width / 2, right: point.x + width / 2, top: point.y - height / 2, bottom: point.y + height / 2 }
    for (let x = Math.floor(obstacle.left / cellSize); x <= Math.floor(obstacle.right / cellSize); x++) {
      for (let y = Math.floor(obstacle.top / cellSize); y <= Math.floor(obstacle.bottom / cellSize); y++) {
        const key = `${x},${y}`
        const cell = cells.get(key)
        if (cell) cell.push(obstacle)
        else cells.set(key, [obstacle])
      }
    }
  }
  return {
    clear(point: BoardPoint, width: number): boolean {
      const bounds = { left: point.x - width / 2 - 9, right: point.x + width / 2 + 9, top: point.y - 17, bottom: point.y + 17 }
      for (let x = Math.floor(bounds.left / cellSize); x <= Math.floor(bounds.right / cellSize); x++) {
        for (let y = Math.floor(bounds.top / cellSize); y <= Math.floor(bounds.bottom / cellSize); y++) {
          for (const obstacle of cells.get(`${x},${y}`) || []) {
            if (bounds.left <= obstacle.right && bounds.right >= obstacle.left && bounds.top <= obstacle.bottom && bounds.bottom >= obstacle.top) return false
          }
        }
      }
      return true
    },
  }
}

export function placeEdgeLabel(start: BoardPoint, control: BoardPoint, end: BoardPoint, width: number, obstacles: ReturnType<typeof createLabelObstacles>): BoardPoint {
  const candidates = [.5, .35, .65, .25, .75].map(t => ({
    x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * control.x + t ** 2 * end.x,
    y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * control.y + t ** 2 * end.y,
  }))
  for (const candidate of candidates) if (obstacles.clear(candidate, width)) return candidate
  for (const shift of [-35, 35, -70, 70, -105, 105]) {
    const candidate = { x: candidates[0].x, y: candidates[0].y + shift }
    if (obstacles.clear(candidate, width)) return candidate
  }
  return candidates[0]
}

/** Last input wins within one frame. flush() is used before pointer-up commits. */
export function createFrameQueue<T>(apply: (value: T) => void, request: (run: () => void) => number, cancel: (id: number) => void) {
  let frame: number | undefined
  let pending: { value: T } | undefined
  const flush = () => {
    if (frame !== undefined) cancel(frame)
    frame = undefined
    const next = pending
    pending = undefined
    if (next) apply(next.value)
  }
  return {
    push(value: T) {
      pending = { value }
      if (frame === undefined) frame = request(flush)
    },
    flush,
    cancel() {
      if (frame !== undefined) cancel(frame)
      frame = undefined
      pending = undefined
    },
  }
}
