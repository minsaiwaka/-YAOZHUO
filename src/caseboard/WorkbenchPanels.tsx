import { useMemo, useState, type ReactNode } from 'react'
import { PixelSprite } from './PixelSprite'
import { characterDesigns } from './pixel-characters'
import { kindLabels, scopeLabels } from './scope-statistics'
import type { BoardGraph, BoardItem, ConversationScope, Evidence, PersonInsights, StatisticsCollection } from './types'

export function PagedList<T>({ items, size = 25, label, children }: { items: readonly T[]; size?: number; label: string; children: (item: T, index: number) => ReactNode }) {
  const [requested, setPage] = useState(1)
  const pages = Math.max(1, Math.ceil(items.length / size)), page = Math.min(requested, pages)
  return <><div className="list-count">{label} · 共 {items.length.toLocaleString('zh-CN')} 項{items.length > size && ` · 顯示 ${(page - 1) * size + 1}–${Math.min(page * size, items.length)}`}</div>{items.slice((page - 1) * size, page * size).map((item, index) => children(item, (page - 1) * size + index))}{!items.length && <p className="empty-note">當前範圍沒有記錄。</p>}{pages > 1 && <div className="list-pagination" aria-label={`${label}分頁`}><button disabled={page === 1} onClick={() => setPage(page - 1)}>← 上一頁</button><span>第 {page} / {pages} 頁</span><button disabled={page === pages} onClick={() => setPage(page + 1)}>下一頁 →</button></div>}</>
}

export function CharacterGallery({ initiallyOpen = false, pageSize = 12, wide = false }: { initiallyOpen?: boolean; pageSize?: number; wide?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  return <div className={`character-library${wide ? ' character-library-wide' : ''}`}><button className="pixel-btn" aria-expanded={open} onClick={() => setOpen(value => !value)}>人物圖鑑 · {characterDesigns.length} 款 {open ? '↑' : '↓'}</button>{open && <><p className="step-help tiny">200 款像素造型，包含不同發型、衣裝與配飾。點人物卷宗的照片可自行更換；外觀僅作裝飾。</p><div className="character-gallery"><PagedList items={characterDesigns} size={pageSize} label="像素人物圖鑑">{design => <div className="character-entry" key={design.id} aria-label={`第 ${design.id + 1} 位：${design.name}`}><PixelSprite seed="character-catalogue" variant={design.id} size={wide ? 38 : 30} /><small>{String(design.id + 1).padStart(2, '0')} · {design.name}</small></div>}</PagedList></div></>}</div>
}

export function ClueInventory({ graph, insights, items, onNode, onEdge, onEvidence, onArrange }: { graph: BoardGraph; insights: PersonInsights; items: BoardItem[]; onNode: (id: string) => void; onEdge: (id: string) => void; onEvidence: (id: string) => void; onArrange: () => void }) {
  const [tab, setTab] = useState<'relations' | 'people' | 'messages' | 'media' | 'manual'>('relations')
  const [query, setQuery] = useState('')
  const names = useMemo(() => new Map(graph.nodes.map(node => [node.id, node.name])), [graph.nodes])
  const search = query.trim().toLowerCase()
  const relations = useMemo(() => graph.edges.filter(edge => `${names.get(edge.source)} ${names.get(edge.target)} ${edge.label}`.toLowerCase().includes(search)), [graph.edges, names, search])
  const people = useMemo(() => graph.nodes.filter(node => `${node.name} ${node.alias || ''} ${node.id}`.toLowerCase().includes(search)), [graph.nodes, search])
  const messages = useMemo(() => insights.relatedMessages.filter(message => `${message.content} ${message.sessionName} ${message.senderName}`.toLowerCase().includes(search)), [insights.relatedMessages, search])
  const media = useMemo(() => messages.filter(message => message.kind !== 'text'), [messages])
  const manual = useMemo(() => items.filter(item => `${item.title} ${item.text || ''}`.toLowerCase().includes(search)), [items, search])
  const record = (message: Evidence) => <button key={message.id} className="inventory-row" onClick={() => onEvidence(message.id)}><span><b>{message.sessionName} · {message.senderName}</b><small>{new Date(message.timestamp).toLocaleString('zh-CN')} · {kindLabels[message.kind]} · {message.id}</small><p>{message.content.slice(0, 200)}{message.content.length > 200 ? '…（點開看完整原文）' : ''}</p></span><i>原文 ↗</i></button>
  return <div className="scroll-page inventory-page"><div className="page-intro"><small>COMPLETE CLUE INDEX</small><h3>全部線索，逐項列明</h3><p>以下保留日期與人工排除後的全部相關線索，不受畫布關係開關、關鍵詞或釘選開關影響。所有線索均可翻頁查看。</p></div><div className="inventory-totals"><span>{graph.nodes.length} 人物與群聊</span><span>{graph.edges.length} 條關係</span><span>{insights.relatedMessages.length} 條相關記錄</span><span>{items.length} 張手動素材</span></div><label className="form-label">在完整清單中檢索<input aria-label="檢索完整線索清單" value={query} onChange={event => setQuery(event.target.value)} placeholder="姓名、會話、原文關鍵詞…" /></label><div className="scope-tabs">{([['relations', '關係'], ['people', '人物與群'], ['messages', '全部原文'], ['media', '媒體記錄'], ['manual', '手動素材']] as const).map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>
    {tab === 'relations' && <PagedList key={`relations:${search}`} items={relations} label="關係線索">{edge => <button key={edge.id} className="inventory-row" onClick={() => onEdge(edge.id)}><span><b>{names.get(edge.source)} ↔ {names.get(edge.target)}</b><small>{edge.label} · {edge.evidenceIds.length} 條消息依據 · 頻次 {edge.strength}</small>{!edge.evidenceIds.length && <small>僅成員記錄，無消息依據</small>}</span><i>查看依據 ↗</i></button>}</PagedList>}
    {tab === 'people' && <PagedList key={`people:${search}`} items={people} label="人物與群聊">{node => <button key={node.id} className="inventory-row" onClick={() => onNode(node.id)}><PixelSprite seed={node.id} kind={node.kind} size={26} /><span><b>{node.name}</b><small>{node.kind === 'group' ? '群聊' : node.kind === 'self' ? '本機帳號' : '聯絡人'} · {node.id}</small></span><i>在畫布定位 ↗</i></button>}</PagedList>}
    {tab === 'messages' && <PagedList key={`messages:${search}`} items={messages} label="全部相關原文">{record}</PagedList>}
    {tab === 'media' && <PagedList key={`media:${search}`} items={media} label="相關媒體記錄">{record}</PagedList>}
    {tab === 'manual' && <><PagedList key={`manual:${search}`} items={manual} label="手動素材">{item => <div key={item.id} className="inventory-row"><span><b>{item.title}</b><small>{item.type === 'note' ? '便箋' : '圖片'} · {item.linkedToCenter !== false ? '已連到中心' : '未連到中心'} · 人工記錄</small><p>{item.text?.slice(0, 300)}</p></span><button className="text-btn" onClick={onArrange}>編排 ↗</button></div>}</PagedList><p className="form-help">手動連線與自動檢索結果分開標注，不加入自動關係頻次。</p></>}
  </div>
}

export function ScopeTabs({ value, onChange }: { value: ConversationScope; onChange: (value: ConversationScope) => void }) {
  return <div className="scope-tabs" aria-label="報告統計範圍">{(['all', 'private', 'group'] as const).map(scope => <button key={scope} aria-pressed={value === scope} onClick={() => onChange(scope)}>{scopeLabels[scope]}</button>)}</div>
}
export function StatisticsPanel({ statistics, scope, onScope, onEvidence, onReport }: { statistics?: StatisticsCollection; scope: ConversationScope; onScope: (scope: ConversationScope) => void; onEvidence: (id: string) => void; onReport: (format: 'html' | 'md') => void }) {
  if (!statistics) return <div className="scroll-page"><p>正在背景統計…</p></div>
  const value = statistics[scope], total = Math.max(1, value.messages), maxHour = Math.max(1, ...value.hours)
  return <div className="scroll-page statistics-page"><div className="page-intro"><small>OBSERVED INTERACTION / THREE SCOPES</small><h3>私聊、群聊與全部記錄</h3><p>從與中心人物相關的已載入原文統計，含直接對話、本人發言、第三方提及及相鄰上下文。私聊包含其他私聊中的提及；群聊僅計相關消息，並非整群歷史。</p></div><div className="statistics-overview">{(['all', 'private', 'group'] as const).map(id => <button key={id} aria-pressed={scope === id} onClick={() => onScope(id)}><small>{scopeLabels[id]}</small><b>{statistics[id].messages.toLocaleString('zh-CN')}</b><span>{statistics[id].sessions} 個會話</span></button>)}</div><ScopeTabs value={scope} onChange={onScope} /><p className="form-help">私聊 {statistics.private.messages} + 群聊 {statistics.group.messages} = 全部 {statistics.all.messages}。日期與排除設定適用於統計；畫布檢索與釘選不改變報告口徑。</p><div className="dossier-actions"><button className="pixel-btn gold" onClick={() => onReport('html')}>導出{scope === 'all' ? '三種範圍' : scope === 'private' ? '私聊' : '群聊'}報告 ↗</button><button className="pixel-btn" onClick={() => onReport('md')}>Markdown</button></div>
    <div className="stat-facts"><span>稱呼命中 <b>{value.mentions}</b></span><span>歧義待核 <b>{value.ambiguous}</b></span><span>活躍日 <b>{value.days}</b></span><span>{value.first !== undefined ? `${new Date(value.first).toLocaleDateString('zh-CN')} — ${new Date(value.last!).toLocaleDateString('zh-CN')}` : '暫無記錄'}</span></div>
    <div className="section-title"><h4>發送比例</h4><span>中心與本機帳號相同時只計一次</span></div><div className="stat-bars">{[['中心人物', value.centerSent], ['本機帳號', value.ownerSent], ['其他人', value.otherSent]].map(([label, count]) => <div key={label}><span>{label}</span><i><b style={{ width: `${Number(count) / total * 100}%` }} /></i><small>{count} · {(Number(count) / total * 100).toFixed(1)}%</small></div>)}</div>
    <div className="section-title"><h4>消息類型</h4><span>{value.messages} 條</span></div><div className="stat-facts">{value.kinds.map(row => <span key={row.kind}>{kindLabels[row.kind]} <b>{row.count}</b> · {(row.count / total * 100).toFixed(1)}%</span>)}</div>
    <div className="section-title"><h4>消息時段分布</h4><span>本機時區 · 每條計一次</span></div><div className="hour-chart" role="img" aria-label={`每小時消息數：${value.hours.map((count, hour) => `${hour}時${count}條`).join('，')}`}>{value.hours.map((count, hour) => <div key={hour} title={`${hour}:00 — ${count} 條`}><small>{count || ''}</small><i style={{ height: `${Math.max(2, count / maxHour * 82)}px` }} /><span>{hour}</span></div>)}</div>
    <div className="section-title"><h4>相關高頻話題</h4><span>本地詞頻 · 原文可核對</span></div><div className="topic-grid">{value.topics.map(topic => <button key={topic.label} onClick={() => onEvidence(topic.evidenceIds[0])}><b>{topic.label}</b><span>{topic.count} 條依據 ↗</span></button>)}</div>
    <div className="section-title"><h4>各會話內容總計</h4><span>逐項列舉全部會話</span></div><PagedList key={scope} items={value.conversations} label="會話統計">{row => <div key={row.id} className="inventory-row"><span><b>{row.name}</b><small>{row.id} · 中心發送 {row.centerSent} · 本機帳號發送 {row.ownerSent}</small></span><strong>{row.count} 條</strong></div>}</PagedList><p className="form-help">線寬和數量只描述可見記錄的頻次，不能據此判定親密程度。未載入的內容不參與統計。</p>
  </div>
}
