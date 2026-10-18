import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { BoardGraph, BoardItem, BoardLayout, BoardNode, DossierProfile } from './types'
import PixelSprite from './PixelSprite'
import { relationWidth } from './pixel-characters'
import { createFrameQueue, createLabelObstacles, placeEdgeLabel } from './board-geometry'
import './PixelBoard.css'

interface PixelBoardProps {
  profiles?: Record<string, DossierProfile>
  graph: BoardGraph
  centerId: string
  selectedId: string | null
  selectedEdgeId?: string | null
  onSelectNode: (id: string) => void
  onSelectEdge: (id: string) => void
  onCenter: (id: string) => void
  query?: string
  layout?: BoardLayout
  onLayoutChange?: (layout: BoardLayout) => void
  items?: BoardItem[]
  onItemsChange?: (items: BoardItem[]) => void
  onOpenEvidence?: (id: string) => void
}
type Point = { x: number; y: number }
type CanvasSize = { width: number; height: number }
type Viewport = Point & { scale: number }
type Drag = { type: 'node' | 'pan' | 'item' | 'resize'; id?: string; pointerId: number; scope: string; inverse?: DOMMatrix; start: Point; origin: Point; moved: boolean; scale: number; latest?: Point }
const WIDTH = 1100
const HEIGHT = 750
const NODE_WIDTH = 148
const NODE_HEIGHT = 128
const CENTER_WIDTH = 168
const CENTER_HEIGHT = 152
const EMPTY_ITEMS: BoardItem[] = []
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

function preferredScale(size: CanvasSize): number {
  return clamp(Math.min(size.width / 820, size.height / 450), .66, 1)
}

function createLayout(nodes: BoardNode[], centerId: string, size: CanvasSize): Record<string, Point> {
  const result: Record<string, Point> = {}
  const center = nodes.find(node => node.id === centerId) || nodes[0]
  if (!center) return result
  result[center.id] = { x: WIDTH / 2, y: HEIGHT / 2 - 8 }
  const others = nodes.filter(node => node.id !== center.id)
  const scale = preferredScale(size)
  let index = 0
  let ring = 0
  while (index < others.length) {
    const count = Math.min(others.length - index, 12 + ring * 8)
    const radiusX = Math.max(220, (size.width / scale - NODE_WIDTH - 28) / 2) + ring * 205
    const radiusY = Math.max(154, (size.height / scale - NODE_HEIGHT - 24) / 2) + ring * 165
    if (ring === 0 && count >= 7 && count <= 10) {
      // Flatten the oval into top/bottom rows and two side seats. A mathematically
      // even ellipse packs its side cards on top of one another in short windows.
      // This single orbit keeps 7–10 cards legible without hiding a ninth card on
      // a distant second ring.
      const topCount = Math.ceil((count - 2) / 2)
      const bottomCount = count - topCount - 2
      const orbit: Point[] = [{ x: -radiusX, y: 0 }]
      const row = (rowCount: number, side: -1 | 1) => {
        for (let slot = 0; slot < rowCount; slot++) {
          const x = rowCount === 1 ? 0 : -radiusX * .75 + slot / (rowCount - 1) * radiusX * 1.5
          orbit.push({ x, y: side * (radiusY - Math.abs(x) / radiusX * 9) })
        }
      }
      row(topCount, -1)
      orbit.push({ x: radiusX, y: 0 })
      row(bottomCount, 1)
      for (const point of orbit) result[others[index++].id] = { x: Math.round(WIDTH / 2 + point.x), y: Math.round(HEIGHT / 2 - 8 + point.y) }
      ring++
      continue
    }
    for (let slot = 0; slot < count; slot++) {
      const angle = -Math.PI / 2 + (slot / count) * Math.PI * 2 + (ring % 2 ? Math.PI / count : 0)
      result[others[index++].id] = {
        x: Math.round(WIDTH / 2 + Math.cos(angle) * radiusX),
        y: Math.round(HEIGHT / 2 - 8 + Math.sin(angle) * radiusY),
      }
    }
    ring++
  }
  return result
}

function focusViewport(positions: Record<string, Point>, centerId: string, size: CanvasSize): Viewport {
  const center = positions[centerId] || { x: WIDTH / 2, y: HEIGHT / 2 - 8 }
  const scale = preferredScale(size)
  return { scale, x: size.width / 2 - center.x * scale, y: size.height / 2 - center.y * scale }
}

function fitViewport(positions: Record<string, Point>, centerId: string, size: CanvasSize, items: BoardItem[] = []): Viewport {
  const bounds = Object.entries(positions).map(([id, point]) => ({
    left: point.x - (id === centerId ? CENTER_WIDTH : NODE_WIDTH) / 2,
    right: point.x + (id === centerId ? CENTER_WIDTH : NODE_WIDTH) / 2,
    top: point.y - (id === centerId ? CENTER_HEIGHT : NODE_HEIGHT) / 2,
    bottom: point.y + (id === centerId ? CENTER_HEIGHT : NODE_HEIGHT) / 2,
  }))
  for (const item of items) bounds.push({ left: item.x, right: item.x + item.width + 8, top: item.y, bottom: item.y + item.height + 8 })
  if (!bounds.length) return focusViewport(positions, centerId, size)
  const left = Math.min(...bounds.map(item => item.left)) - 12
  const right = Math.max(...bounds.map(item => item.right)) + 12
  const top = Math.min(...bounds.map(item => item.top)) - 12
  const bottom = Math.max(...bounds.map(item => item.bottom)) + 12
  const scale = clamp(Math.min(1.2, (size.width - 20) / (right - left), (size.height - 24) / (bottom - top)), .1, 1.2)
  return { x: size.width / 2 - (left + right) / 2 * scale, y: size.height / 2 - (top + bottom) / 2 * scale, scale }
}

function edgeAnchor(point: Point, other: Point, isCenter: boolean): Point {
  const dx = other.x - point.x
  const dy = other.y - point.y
  if (!dx && !dy) return point
  const width = (isCenter ? CENTER_WIDTH : NODE_WIDTH) / 2 + 5
  const height = (isCenter ? CENTER_HEIGHT : NODE_HEIGHT) / 2 + 5
  const ratio = Math.min(dx ? width / Math.abs(dx) : Infinity, dy ? height / Math.abs(dy) : Infinity)
  return { x: point.x + dx * ratio, y: point.y + dy * ratio }
}

function truncate(value: string, max: number) { return value.length > max ? `${value.slice(0, max)}…` : value }


interface BoardActions {
  beginDrag: (event: ReactPointerEvent<Element>, id?: string, type?: 'item' | 'resize') => void
  selectNode: (id: string, keyboard?: boolean) => void
  selectEdge: (id: string) => void
  centerNode: (id: string, keyboard?: boolean) => void
  editItem: (id: string, patch: Partial<BoardItem>, commit?: boolean) => void
  deleteItem: (id: string) => void
  openEvidence: (id: string) => void
}

const NodeCard = memo(function NodeCard({ node, profile, point, index, isCenter, selected, matched, patternId, actions }: {
  node: BoardNode; profile?: DossierProfile; point: Point; index: number; isCenter: boolean; selected: boolean; matched: boolean; patternId: string; actions: BoardActions
}) {
  const width = isCenter ? CENTER_WIDTH : NODE_WIDTH
  const height = isCenter ? CENTER_HEIGHT : NODE_HEIGHT
  return <g transform={`translate(${point.x - width / 2} ${point.y - height / 2})`} className={`cb-map-node${isCenter ? ' is-center' : ''}${selected ? ' is-selected' : ''}${matched ? ' is-match' : ''}`} role="button" tabIndex={0} aria-label={`${node.name}${isCenter ? '，中心人物' : node.kind === 'group' ? '，群聊' : '，聯絡人'}，${node.messageCount} 條消息，單擊查看檔案，雙擊設為中心`} onPointerDown={event => actions.beginDrag(event, node.id)} onClick={event => { event.stopPropagation(); actions.selectNode(node.id) }} onDoubleClick={event => { event.stopPropagation(); actions.centerNode(node.id) }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); actions.selectNode(node.id, true) }; if (event.key === 'c' || event.key === 'C') actions.centerNode(node.id, true) }}>
            <rect className="cb-map-node-shadow" x="5" y="6" width={width} height={height} />
            <path className="cb-map-node-paper" d={`M4 0h${width - 8}v4h4v${height - 8}h-4v4H4v-4H0V4h4Z`} />
            <rect className="cb-map-node-photo" x="9" y="9" width={width - 18} height={isCenter ? 88 : 69} />
            <rect x="9" y="9" width={width - 18} height={isCenter ? 88 : 69} fill={`url(#${patternId}-dither)`} />
            <path className="cb-map-node-horizon" d={isCenter ? `M10 80h${width - 20}v16H10Z` : `M10 64h${width - 20}v13H10Z`} />
            <svg x={(width - (isCenter ? 57 : 43)) / 2} y={isCenter ? 17 : 13} width={isCenter ? 57 : 43} height={isCenter ? 76 : 60} overflow="visible"><PixelSprite seed={node.id} variant={profile?.avatarVariant} kind={profile?.avatarVariant !== undefined && node.kind === 'group' ? 'person' : node.kind} size={isCenter ? 57 : 43} /></svg>
            <text className="cb-map-node-number" x="15" y="22">{isCenter ? 'SUBJECT' : `NO.${String(index + 1).padStart(2, '0')}`}</text>
            {isCenter && <><path className="cb-map-node-corner" d={`M${width - 29} 10h18v18h-4V14h-14Z`} /><rect className="cb-map-node-pin" x={width / 2 - 4} y="-4" width="8" height="8" /></>}
            <text className="cb-map-node-name" x={width / 2} y={isCenter ? 119 : 101} textAnchor="middle">{truncate(profile?.displayName || node.name, 8)}</text>
            <text className="cb-map-node-meta" x={width / 2} y={isCenter ? 137 : 117} textAnchor="middle">{isCenter ? '中心人物' : node.kind === 'group' ? '共同群聊' : '關聯人物'} · {node.messageCount.toLocaleString()} 條</text>
            {selected && <><path className="cb-map-selection" d={`M-5 12V-5h17M${width - 12} -5h17v17M-5 ${height - 12}v17h17M${width - 12} ${height + 5}h17v-17`} /><rect className="cb-map-node-selected-dot" x={width - 19} y={height - 19} width="5" height="5" /></>}
            <title>{node.name}{node.alias ? `（${node.alias}）` : ''} · {node.messageCount} 條消息</title>
          </g>
})

const ItemCard = memo(function ItemCard({ item, actions }: { item: BoardItem; actions: BoardActions }) {
  return <foreignObject x={item.x} y={item.y} width={item.width + 8} height={item.height + 8} className={`cb-map-item-object cb-map-item-object--${item.type}`}>
          <div className={`cb-map-item cb-map-item--${item.type}`} style={{ width: item.width, height: item.height }} onPointerDown={event => event.stopPropagation()}>
            <div className="cb-map-item-header" role="button" tabIndex={0} aria-label={`拖動${item.type === 'note' ? '便箋' : '圖片'}：${item.title}，方向鍵微調位置`} onPointerDown={event => actions.beginDrag(event, item.id, 'item')} onKeyDown={event => {
              const movement: Record<string, Point> = { ArrowLeft: { x: -8, y: 0 }, ArrowRight: { x: 8, y: 0 }, ArrowUp: { x: 0, y: -8 }, ArrowDown: { x: 0, y: 8 } }
              const delta = movement[event.key]
              if (delta) { event.preventDefault(); actions.editItem(item.id, { x: item.x + delta.x * (event.shiftKey ? 4 : 1), y: item.y + delta.y * (event.shiftKey ? 4 : 1) }, true) }
            }}>
              <span className="cb-map-item-pin" aria-hidden="true" /><span className="cb-map-item-title" title={item.title}>{item.title || (item.type === 'note' ? '線索便箋' : '影像線索')}</span>
              <button className="cb-map-item-delete" type="button" aria-label={`刪除${item.title || '這張線索卡'}`} title="移除線索卡" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); actions.deleteItem(item.id) }}>×</button>
            </div>
            {item.type === 'note' ? <textarea className="cb-map-item-note" aria-label={`編輯便箋：${item.title}`} placeholder="寫下你的線索…" value={item.text || ''} onChange={event => actions.editItem(item.id, { text: event.target.value }, true)} onBlur={event => actions.editItem(item.id, { text: event.target.value }, true)} onPointerDown={event => event.stopPropagation()} /> : <div className="cb-map-item-image" onPointerDown={event => actions.beginDrag(event, item.id, 'item')}>
              {item.dataUrl ? <img src={item.dataUrl} alt={item.title || '釘在畫布上的圖片線索'} draggable={false} /> : <span>暫無影像</span>}
            </div>}
            <div className="cb-map-item-footer"><button type="button" aria-pressed={item.linkedToCenter !== false} aria-label={`${item.linkedToCenter !== false ? '取消' : '建立'}${item.title}與中心人物的連線`} onClick={() => actions.editItem(item.id, { linkedToCenter: item.linkedToCenter === false }, true)}>{item.linkedToCenter !== false ? '◆ 已連中心' : '◇ 連到中心'}</button>{item.evidenceIds?.length ? <button type="button" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); actions.openEvidence(item.evidenceIds![0]) }} aria-label={`查看${item.title}的來源消息`}>來源 · {item.evidenceIds.length}</button> : <span>手動線索</span>}</div>
            <button className="cb-map-item-resize" type="button" aria-label={`調整${item.title || '線索卡'}大小，方向鍵調整寬高`} title="拖動調整尺寸" onPointerDown={event => actions.beginDrag(event, item.id, 'resize')} onClick={event => event.stopPropagation()} onKeyDown={event => {
              if (!event.key.startsWith('Arrow')) return
              event.preventDefault()
              const step = event.shiftKey ? 32 : 8
              actions.editItem(item.id, { width: Math.max(120, item.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)), height: Math.max(100, item.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0)) }, true)
            }}><span aria-hidden="true" /></button>
          </div>
        </foreignObject>
})

function PixelBoard({ profiles, graph, centerId, selectedId, selectedEdgeId, onSelectNode, onSelectEdge, onCenter, query = '', layout: savedLayout, onLayoutChange, items = EMPTY_ITEMS, onItemsChange, onOpenEvidence }: PixelBoardProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const captureRef = useRef<Element | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const suppressClickRef = useRef(false)
  const patternId = useId().replace(/:/g, '')
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 700, height: 354 })
  const graphKey = useMemo(() => JSON.stringify([centerId, graph.nodes.map(node => node.id)]), [centerId, graph.nodes])
  const graphKeyRef = useRef(graphKey)
  graphKeyRef.current = graphKey
  const defaultLayout = useMemo(() => createLayout(graph.nodes, centerId, canvasSize), [graphKey, canvasSize.width, canvasSize.height])
  const layout = useMemo(() => {
    const next = { ...defaultLayout }
    for (const id of Object.keys(next)) {
      const point = savedLayout?.[id]
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) next[id] = point
    }
    return next
  }, [defaultLayout, savedLayout])
  const [manualPositions, setManualPositions] = useState<{ key: string; points: Record<string, Point> }>({ key: '', points: {} })
  const positions = useMemo(() => manualPositions.key === graphKey ? { ...layout, ...manualPositions.points } : layout, [layout, manualPositions, graphKey])
  const positionsRef = useRef(positions)
  positionsRef.current = positions
  const [itemOverrides, setItemOverrides] = useState<Record<string, Partial<BoardItem>>>({})
  const displayItems = useMemo(() => items.map(item => {
    const patch = itemOverrides[item.id]
    if (!patch && item.width >= 120 && item.height >= 100) return item
    return { ...item, ...patch, width: Math.max(120, patch?.width ?? item.width), height: Math.max(100, patch?.height ?? item.height) }
  }), [items, itemOverrides])
  const itemsRef = useRef(displayItems)
  itemsRef.current = displayItems
  const [viewport, setViewport] = useState<Viewport>(() => focusViewport(layout, centerId, canvasSize))
  const viewportRef = useRef(viewport)
  const [isDragging, setIsDragging] = useState(false)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  const [focusedEdgeId, setFocusedEdgeId] = useState<string | null>(null)
  const actualCenter = graph.nodes.some(node => node.id === centerId) ? centerId : graph.nodes[0]?.id
  const obstacles = useMemo(() => createLabelObstacles(positions, actualCenter), [positions, actualCenter])
  const applyDragRef = useRef<(point: Point) => void>(() => {})
  applyDragRef.current = applyDrag
  const dragFrame = useMemo(() => createFrameQueue<Point>(point => applyDragRef.current(point), run => requestAnimationFrame(run), id => cancelAnimationFrame(id)), [])
  const viewportFrame = useMemo(() => createFrameQueue<Viewport>(next => setViewport(next), run => requestAnimationFrame(run), id => cancelAnimationFrame(id)), [])
  const callbacks = useRef<BoardActions>(null!)
  callbacks.current = { beginDrag, selectNode: (id, keyboard) => keyboard ? onSelectNode(id) : selectNode(id), selectEdge: onSelectEdge, centerNode: (id, keyboard) => { if (keyboard || !suppressClickRef.current) onCenter(id) }, editItem, deleteItem: id => onItemsChange?.(itemsRef.current.filter(item => item.id !== id)), openEvidence: id => onOpenEvidence?.(id) }
  const actions = useMemo<BoardActions>(() => ({
    beginDrag: (...args) => callbacks.current.beginDrag(...args),
    selectNode: (...args) => callbacks.current.selectNode(...args),
    selectEdge: id => callbacks.current.selectEdge(id),
    centerNode: (...args) => callbacks.current.centerNode(...args),
    editItem: (...args) => callbacks.current.editItem(...args),
    deleteItem: id => callbacks.current.deleteItem(id),
    openEvidence: id => callbacks.current.openEvidence(id),
  }), [])
  const edgeLanes = useMemo(() => {
    const pairs = new Map<string, string[]>()
    for (const edge of graph.edges) {
      const pair = JSON.stringify([edge.source, edge.target].sort())
      if (!pairs.has(pair)) pairs.set(pair, [])
      pairs.get(pair)!.push(edge.id)
    }
    const result = new Map<string, number>()
    for (const ids of pairs.values()) ids.forEach((id, index) => result.set(id, (index - (ids.length - 1) / 2) * 44))
    return result
  }, [graph.edges])

  // A pixel-sized viewBox avoids the second shrink caused by a fixed 1100×750
  // SVG inside a short, wide desktop canvas. All dragging stays in board units.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const measure = () => {
      const bounds = svg.getBoundingClientRect()
      const next = { width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)) }
      setCanvasSize(previous => previous.width === next.width && previous.height === next.height ? previous : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(svg)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    // A queued move belongs to the person graph on which the gesture began.
    // Switching person, resizing or unmounting must never commit it elsewhere.
    cancelDrag()
    viewportFrame.cancel()
    const next = focusViewport(layout, centerId, canvasSize)
    viewportRef.current = next
    setViewport(next)
    setHoveredEdgeId(null)
    setFocusedEdgeId(null)
  }, [graphKey, canvasSize.width, canvasSize.height])
  useEffect(() => { if (!dragRef.current) setManualPositions(previous => Object.keys(previous.points).length ? { key: '', points: {} } : previous) }, [savedLayout])
  useEffect(() => { if (!dragRef.current) setItemOverrides(previous => Object.keys(previous).length ? {} : previous) }, [items])
  useEffect(() => {
    const point = selectedId ? positionsRef.current[selectedId] : undefined
    if (!point || dragRef.current) return
    const current = viewportRef.current
    const x = point.x * current.scale + current.x, y = point.y * current.scale + current.y
    if (x < 80 || x > canvasSize.width - 80 || y < 90 || y > canvasSize.height - 90) showViewport({ ...current, x: canvasSize.width / 2 - point.x * current.scale, y: canvasSize.height / 2 - point.y * current.scale })
  }, [selectedId])
  useEffect(() => () => { dragFrame.cancel(); viewportFrame.cancel(); releaseCapture() }, [dragFrame, viewportFrame])
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && dragRef.current) { event.preventDefault(); cancelDrag() } }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [])

  // Native non-passive wheel handling prevents the surrounding page from scrolling.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (!dragRef.current) zoom(event.deltaY > 0 ? .9 : 1.1, localPoint(event.clientX, event.clientY))
    }
    svg.addEventListener('wheel', handleWheel, { passive: false })
    return () => svg.removeEventListener('wheel', handleWheel)
  }, [])

  function localPoint(clientX: number, clientY: number, inverse = svgRef.current?.getScreenCTM()?.inverse()): Point {
    return inverse ? { x: inverse.a * clientX + inverse.c * clientY + inverse.e, y: inverse.b * clientX + inverse.d * clientY + inverse.f } : { x: clientX, y: clientY }
  }

  function beginDrag(event: ReactPointerEvent<Element>, id?: string, type?: 'item' | 'resize') {
    if (event.button !== 0 || dragRef.current) return
    event.stopPropagation()
    viewportFrame.flush()
    const inverse = svgRef.current?.getScreenCTM()?.inverse()
    const start = localPoint(event.clientX, event.clientY, inverse)
    const item = type ? itemsRef.current.find(entry => entry.id === id) : undefined
    if (type && !item) return
    const currentViewport = viewportRef.current
    const origin = item ? type === 'resize' ? { x: item.width, y: item.height } : { x: item.x, y: item.y } : id ? positionsRef.current[id] : { x: currentViewport.x, y: currentViewport.y }
    if (!origin) return
    dragRef.current = { type: type || (id ? 'node' : 'pan'), id, pointerId: event.pointerId, scope: graphKeyRef.current, inverse, start, origin, moved: false, scale: currentViewport.scale }
    suppressClickRef.current = false
    captureRef.current = event.currentTarget
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveDrag(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragFrame.push(localPoint(event.clientX, event.clientY, drag.inverse))
  }

  function applyDrag(next: Point) {
    const drag = dragRef.current
    if (!drag || drag.scope !== graphKeyRef.current) return
    const delta = { x: next.x - drag.start.x, y: next.y - drag.start.y }
    if (!drag.moved && Math.abs(delta.x) + Math.abs(delta.y) > 4) { drag.moved = true; setIsDragging(true) }
    if (!drag.moved) return
    if (drag.type === 'node' && drag.id) {
      const id = drag.id
      const point = { x: drag.origin.x + delta.x / drag.scale, y: drag.origin.y + delta.y / drag.scale }
      drag.latest = point
      positionsRef.current = { ...positionsRef.current, [id]: point }
      setManualPositions(previous => ({ key: drag.scope, points: { ...(previous.key === drag.scope ? previous.points : {}), [id]: point } }))
    } else if ((drag.type === 'item' || drag.type === 'resize') && drag.id) {
      const id = drag.id
      const point = { x: drag.origin.x + delta.x / drag.scale, y: drag.origin.y + delta.y / drag.scale }
      const patch = drag.type === 'resize' ? { width: Math.max(120, point.x), height: Math.max(100, point.y) } : point
      drag.latest = point
      itemsRef.current = itemsRef.current.map(item => item.id === id ? { ...item, ...patch } : item)
      setItemOverrides(previous => ({ ...previous, [id]: { ...previous[id], ...patch } }))
    } else {
      const nextViewport = { scale: drag.scale, x: drag.origin.x + delta.x, y: drag.origin.y + delta.y }
      viewportRef.current = nextViewport
      setViewport(nextViewport)
    }
  }

  function endDrag(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.scope !== graphKeyRef.current) { cancelDrag(false); return }
    // Pointer-up may arrive before the browser paints the queued final move.
    dragFrame.push(localPoint(event.clientX, event.clientY, drag.inverse))
    dragFrame.flush()
    suppressClickRef.current = !!drag?.moved
    if (drag?.moved && drag.id && drag.latest) {
      if (drag.type === 'node') onLayoutChange?.({ ...positionsRef.current, [drag.id]: drag.latest })
      if (drag.type === 'item' || drag.type === 'resize') {
        const patch = drag.type === 'resize' ? { width: Math.max(120, drag.latest.x), height: Math.max(100, drag.latest.y) } : drag.latest
        onItemsChange?.(itemsRef.current.map(item => item.id === drag.id ? { ...item, ...patch } : item))
      }
    }
    dragRef.current = null
    setIsDragging(false)
    releaseCapture(event.pointerId)
  }

  function releaseCapture(pointerId = dragRef.current?.pointerId) {
    const capture = captureRef.current
    captureRef.current = null
    if (capture && pointerId !== undefined && capture.hasPointerCapture(pointerId)) capture.releasePointerCapture(pointerId)
  }

  function cancelDrag(restore = true) {
    dragFrame.cancel()
    const drag = dragRef.current
    dragRef.current = null
    releaseCapture(drag?.pointerId)
    suppressClickRef.current = false
    if (restore && drag?.moved && drag.scope === graphKeyRef.current) {
      if (drag.type === 'node' && drag.id) {
        positionsRef.current = { ...positionsRef.current, [drag.id]: drag.origin }
        setManualPositions(previous => ({ key: drag.scope, points: { ...(previous.key === drag.scope ? previous.points : {}), [drag.id!]: drag.origin } }))
      } else if (drag.id && (drag.type === 'item' || drag.type === 'resize')) {
        const patch = drag.type === 'resize' ? { width: drag.origin.x, height: drag.origin.y } : drag.origin
        itemsRef.current = itemsRef.current.map(item => item.id === drag.id ? { ...item, ...patch } : item)
        setItemOverrides(previous => ({ ...previous, [drag.id!]: { ...previous[drag.id!], ...patch } }))
      } else {
        const next = { ...drag.origin, scale: drag.scale }
        viewportRef.current = next
        setViewport(next)
      }
    }
    if (drag) setIsDragging(false)
  }

  function zoom(factor: number, point: Point = { x: canvasSize.width / 2, y: canvasSize.height / 2 }) {
    const previous = viewportRef.current
    const scale = clamp(previous.scale * factor, .1, 2.5)
    const ratio = scale / previous.scale
    const next = { scale, x: point.x - (point.x - previous.x) * ratio, y: point.y - (point.y - previous.y) * ratio }
    viewportRef.current = next
    viewportFrame.push(next)
  }

  function showViewport(next: Viewport) {
    viewportFrame.cancel()
    viewportRef.current = next
    setViewport(next)
  }

  function selectNode(id: string) {
    if (suppressClickRef.current) { suppressClickRef.current = false; return }
    onSelectNode(id)
  }

  function editItem(id: string, patch: Partial<BoardItem>, commit = false) {
    if (!itemsRef.current.some(item => item.id === id)) return
    const next = itemsRef.current.map(item => item.id === id ? { ...item, ...patch } : item)
    itemsRef.current = next
    setItemOverrides(previous => ({ ...previous, [id]: { ...previous[id], ...patch } }))
    if (commit) onItemsChange?.(next)
  }

  function tidyLayout() {
    setManualPositions({ key: graphKey, points: defaultLayout })
    onLayoutChange?.({ ...defaultLayout })
    showViewport(focusViewport(defaultLayout, centerId, canvasSize))
  }

  const normalizedQuery = query.trim().toLowerCase()
  // Keep every node in the model; only offscreen drawing is skipped on large boards.
  const visibleBounds = graph.nodes.length > 80 ? { left: (-viewport.x - 220) / viewport.scale, right: (canvasSize.width - viewport.x + 220) / viewport.scale, top: (-viewport.y - 220) / viewport.scale, bottom: (canvasSize.height - viewport.y + 220) / viewport.scale } : null
  const drawingNodes = useMemo(() => !visibleBounds ? graph.nodes : graph.nodes.filter(node => {
    const point = positions[node.id]
    return node.id === selectedId || node.id === actualCenter || point && point.x >= visibleBounds.left && point.x <= visibleBounds.right && point.y >= visibleBounds.top && point.y <= visibleBounds.bottom
  }), [graph.nodes, positions, selectedId, actualCenter, visibleBounds?.left, visibleBounds?.right, visibleBounds?.top, visibleBounds?.bottom])
  // Pan and zoom only change the enclosing transform; they reuse the whole
  // scene. Moving one card also reuses every other card and portrait.
  const nodeScene = useMemo(() => drawingNodes.map((node, index) => {
    const point = positions[node.id]
    return point ? <NodeCard key={node.id} node={node} profile={profiles?.[node.id]} point={point} index={index} isCenter={node.id === actualCenter} selected={selectedId === node.id} matched={!!normalizedQuery && `${node.name} ${node.alias || ''}`.toLowerCase().includes(normalizedQuery)} patternId={patternId} actions={actions} /> : null
  }), [drawingNodes, positions, actualCenter, selectedId, normalizedQuery, patternId, actions])
  const itemScene = useMemo(() => displayItems.map(item => <ItemCard key={item.id} item={item} actions={actions} />), [displayItems, actions])
  const manualLines = useMemo(() => {
    const center = positions[actualCenter]
    if (!center) return null
    return displayItems.filter(item => item.linkedToCenter !== false).map(item => {
      const target = { x: item.x + item.width / 2, y: item.y + item.height / 2 }
      const start = edgeAnchor(center, target, true)
      const dx = center.x - target.x, dy = center.y - target.y
      const ratio = Math.min(dx ? item.width / 2 / Math.abs(dx) : Infinity, dy ? item.height / 2 / Math.abs(dy) : Infinity)
      const end = !dx && !dy ? target : { x: target.x + dx * ratio, y: target.y + dy * ratio }
      return <path key={item.id} className="cb-map-manual-line" d={`M${start.x} ${start.y} L${end.x} ${end.y}`}><title>{item.title} · 手動連到中心，不計入自動關係強度</title></path>
    })
  }, [positions, actualCenter, displayItems])
  const edgeScene = useMemo(() => graph.edges.map((edge, index) => {
          const source = positions[edge.source]
          const target = positions[edge.target]
          if (!source || !target || edge.source === edge.target) return null
          if (visibleBounds && (Math.max(source.x, target.x) + 80 < visibleBounds.left || Math.min(source.x, target.x) - 80 > visibleBounds.right || Math.max(source.y, target.y) + 80 < visibleBounds.top || Math.min(source.y, target.y) - 80 > visibleBounds.bottom)) return null
          const start = edgeAnchor(source, target, edge.source === actualCenter)
          const end = edgeAnchor(target, source, edge.target === actualCenter)
          const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
          const label = truncate(edge.label, 16)
          const labelWidth = Math.max(64, label.length * 13 + 18)
          const active = selectedEdgeId === edge.id
          const related = selectedId === edge.source || selectedId === edge.target
          const connected = edge.source === actualCenter || edge.target === actualCenter
          const lane = edgeLanes.get(edge.id) || 0
          const offset = lane || (connected ? 0 : (index % 2 ? -12 : 12))
          const distance = Math.hypot(end.x - start.x, end.y - start.y) || 1
          const direction = edge.source < edge.target ? 1 : -1
          const control = { x: mid.x - (end.y - start.y) / distance * offset * direction, y: mid.y + (end.x - start.x) / distance * offset * direction }
          const showLabel = active || hoveredEdgeId === edge.id || focusedEdgeId === edge.id
          const labelPoint = showLabel ? placeEdgeLabel(start, control, end, labelWidth, obstacles) : mid
          const path = `M${start.x} ${start.y} Q${control.x} ${control.y} ${end.x} ${end.y}`
          return <g key={edge.id} className={`cb-map-edge cb-map-edge--${edge.kind}${active ? ' is-selected' : ''}${related ? ' is-related' : ''}`} role="button" tabIndex={0} aria-label={`${edge.label}，${edge.evidenceIds.length} 條證據，查看關係證據`} onPointerEnter={() => setHoveredEdgeId(edge.id)} onPointerLeave={() => setHoveredEdgeId(current => current === edge.id ? null : current)} onFocus={() => setFocusedEdgeId(edge.id)} onBlur={() => setFocusedEdgeId(current => current === edge.id ? null : current)} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); actions.selectEdge(edge.id) }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); actions.selectEdge(edge.id) } }}>
            <title>{edge.label} · {edge.evidenceIds.length} 條消息依據，點擊查看</title>
            <path className="cb-map-edge-hit" d={path} />
            <path className="cb-map-edge-line" d={path} strokeWidth={relationWidth(edge.strength) + (active ? .6 : 0)} />
            {showLabel && <><rect className="cb-map-edge-label-bg" x={labelPoint.x - labelWidth / 2} y={labelPoint.y - 11} width={labelWidth} height="23" />
            <text className="cb-map-edge-label" x={labelPoint.x} y={labelPoint.y + 5} textAnchor="middle">{label}</text></>}
          </g>
        }), [graph.edges, positions, actualCenter, selectedId, selectedEdgeId, edgeLanes, obstacles, hoveredEdgeId, focusedEdgeId, actions, visibleBounds?.left, visibleBounds?.right, visibleBounds?.top, visibleBounds?.bottom])

  return <div className={`cb-map${isDragging ? ' cb-map--dragging' : ''}`}>
    <div className="cb-map-caption"><span className="cb-map-caption-mark">✦</span> RELATION MAP <span className="cb-map-caption-count">{String(graph.nodes.length).padStart(2, '0')} NODES</span></div>
    <svg ref={svgRef} className="cb-map-canvas" viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`} role="group" aria-label="人物關係線索板，可拖動人物和畫布、滾輪縮放" onPointerDown={event => beginDrag(event)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={event => { if (dragRef.current?.pointerId === event.pointerId) cancelDrag() }} onLostPointerCapture={event => { if (dragRef.current?.pointerId === event.pointerId) cancelDrag() }}>
      <defs>
        <pattern id={`${patternId}-grid`} width="24" height="24" patternUnits="userSpaceOnUse"><rect x="1" y="1" width="2" height="2" fill="#8eafa0" opacity=".25" /></pattern>
        <pattern id={`${patternId}-dither`} width="8" height="8" patternUnits="userSpaceOnUse"><rect width="3" height="3" fill="#739d88" opacity=".2" /><rect x="4" y="4" width="3" height="3" fill="#739d88" opacity=".2" /></pattern>
      </defs>
      <rect width={canvasSize.width} height={canvasSize.height} fill={`url(#${patternId}-grid)`} />
      <g className="cb-map-scenery" fill="#739d88" opacity=".28" shapeRendering="crispEdges" pointerEvents="none">
        <path d="M66 590h18v-3h8v3h6v6h7v7h-7v16H76v-16H66Zm9-3v-7h4v7Zm13-3v-7h4v7Z" />
        <rect x="52" y="621" width="71" height="3" /><rect x="70" y="627" width="4" height="3" /><rect x="104" y="627" width="4" height="3" />
        <path d="M987 112h11V98h4v14h11v4h-11v23h-4v-23h-11Z" /><path d="M981 136h36v3h-36Zm2 7h3v3h-3Zm26 0h3v3h-3Z" />
        <path d="M86 120h20v3H86Zm-6 6h32v3H80Zm6 6h20v3H86Z" /><rect x="91" y="116" width="10" height="3" />
        <rect x="982" y="614" width="42" height="3" /><rect x="989" y="606" width="3" height="8" /><rect x="1014" y="602" width="3" height="12" />
      </g>
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
        {edgeScene}
        {manualLines}
        {nodeScene}
        {itemScene}
      </g>
    </svg>
    {!graph.nodes.length && !displayItems.length && <div className="cb-map-empty"><PixelSprite seed="empty-board" kind="group" size={56} /><strong>這份關係圖還沒有線索</strong><span>選擇一位中心人物，或調整檢索條件。</span></div>}
    <div className="cb-map-legend" aria-label="關係圖例"><span><i className="cb-map-legend-direct" />直接對話</span><span><i className="cb-map-legend-mention" />第三方提及</span><span><i className="cb-map-legend-group" />共同群聊</span></div>
    <div className="cb-map-help">線越粗 = 記錄越多 · 點線看依據 · 手動素材使用點線</div>
    <div className="cb-map-tools" aria-label="畫布縮放控制"><button type="button" className="cb-map-tidy" onClick={tidyLayout} aria-label="整理人物布局，保留圖片和便箋" title="整理人物布局，保留圖片和便箋">整理</button><button type="button" onClick={() => zoom(.8)} aria-label="縮小關係圖" title="縮小">−</button><output aria-live="polite">{Math.round(viewport.scale * 100)}%</output><button type="button" onClick={() => zoom(1.25)} aria-label="放大關係圖" title="放大">+</button><button type="button" className="cb-map-focus" onClick={() => showViewport(focusViewport(positionsRef.current, centerId, canvasSize))} aria-label="聚焦中心人物，保持卡片清晰" title="聚焦中心人物">中心</button><button type="button" className="cb-map-reset" onClick={() => showViewport(fitViewport(positionsRef.current, centerId, canvasSize, itemsRef.current))} aria-label="適配全部人物和素材，保留所有位置" title="適配全部人物和素材">全部</button></div>
  </div>
}

export default memo(PixelBoard)
