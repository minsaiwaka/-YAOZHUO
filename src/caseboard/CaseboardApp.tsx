import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import PixelBoard from './PixelBoard'
import HelpPage, { HelpSidebar, type HelpSection } from './HelpPage'
import { CharacterGallery, ClueInventory, PagedList, ScopeTabs, StatisticsPanel } from './WorkbenchPanels'
import { scopeLabels } from './scope-statistics'
import { PixelSprite } from './PixelSprite'
import AISummarySetup from './AISummarySetup'
import { SummaryReport } from './SummaryReport'
import Modal from './Modal'
import { DossierFile, DossierEditor } from './DossierFile'
import { validateProfile } from './dossier-profile'
import { validateStoredSummary } from './ai-selection'
import { useAnalysis } from './useAnalysis'
import type { AnalysisScope } from './analysis-runtime'
import { demoDataset } from './demo'
import { readBoard, readDataset, readSetting, scheduleSetting, storeBoard, storeDataset, storeSetting } from './storage'
import type { AliasMap, BoardDocument, BoardItem, CaseDataset, CaseNotes, ConnectionOptions, ConversationScope, DossierProfile, DossierSummary, Evidence, NativeAutoResult, NativeCatalog, NativeDiscovery, NativeOpenOptions, RelationKind } from './types'

type View = 'board' | 'clues' | 'mentions' | 'timeline' | 'statistics' | 'dossier' | 'help'
const views: { id: View; label: string; icon: string; sub: string }[] = [
  { id: 'board', label: '關係線索板', icon: '⌘', sub: 'RELATIONS' },
  { id: 'clues', label: '完整線索', icon: '◇', sub: 'ALL CLUES' },
  { id: 'statistics', label: '互動統計', icon: '▥', sub: 'STATISTICS' },
  { id: 'mentions', label: '提及與話題', icon: '◇', sub: 'MENTIONS' },
  { id: 'timeline', label: '記憶時間線', icon: '≡', sub: 'TIMELINE' },
  { id: 'dossier', label: '人物卷宗', icon: '▤', sub: 'DOSSIER' },
]
const relationLabels: Record<RelationKind, string> = { direct: '直接對話', mention: '被提及', 'shared-group': '共同群聊', reply: '引用回覆' }
const dateOnly = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
const dateTime = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const date = (timestamp: number, full = false) => (full ? dateTime : dateOnly).format(timestamp)
const number = (value: number) => value.toLocaleString('zh-CN')
const chooseCenter = (data: CaseDataset) => data.people.find(person => person.name === '林知夏')?.id || data.people.find(person => person.kind === 'person')?.id || data.ownerId
const setupSteps = ['接入資料', '選擇中心人物', '設定稱呼', '篩查線索', '編排線索板', '保存與導出']
const stepSubtitles = ['DATA SOURCE', 'CENTER PERSON', 'NAMES & ALIASES', 'FOLLOW THE CLUES', 'ARRANGE THE BOARD', 'SAVE THE MEMORIES']
const demoMedia: Record<string, string> = { 'demo:book': `${import.meta.env.BASE_URL}caseboard/demo-book.png`, 'demo:cat': `${import.meta.env.BASE_URL}caseboard/demo-cat.png`, 'demo:coffee': `${import.meta.env.BASE_URL}caseboard/demo-coffee.png` }
const EMPTY_IDS: string[] = []
const emptyBoard = (): BoardDocument => ({ layout: {}, items: [] })
function validateBoard(value: unknown): BoardDocument {
  const board = value as Partial<BoardDocument> | null
  const result = emptyBoard()
  const finite = (number: unknown, fallback: number, min: number, max: number) => typeof number === 'number' && Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
  if (board?.layout && typeof board.layout === 'object') for (const [key, position] of Object.entries(board.layout).slice(0, 50000)) {
    if (position && typeof position === 'object' && key !== '__proto__') result.layout[key] = { x: finite(position.x, 550, -100000, 100000), y: finite(position.y, 375, -100000, 100000) }
  }
  if (Array.isArray(board?.items) && board.items.length > 500) throw new Error('線索板素材超過 500 張，請分為多份保存')
  if (Array.isArray(board?.items)) for (const item of board.items) {
    if (!item || (item.type !== 'note' && item.type !== 'image')) continue
    const dataUrl = typeof item.dataUrl === 'string' && /^data:image\/(png|jpeg|gif|webp|bmp|avif);base64,[a-z0-9+/=\s]+$/i.test(item.dataUrl) && item.dataUrl.length <= 15 * 1024 * 1024 ? item.dataUrl : undefined
    if (item.type === 'image' && !dataUrl) continue
    const id = typeof item.id === 'string' ? item.id.slice(0, 100) : crypto.randomUUID()
    result.items.push({ id: result.items.some(existing => existing.id === id) ? crypto.randomUUID() : id, type: item.type, linkedToCenter: item.linkedToCenter !== false, title: String(item.title || '線索').slice(0, 200), text: typeof item.text === 'string' ? item.text.slice(0, 20000) : undefined, dataUrl, evidenceIds: Array.isArray(item.evidenceIds) ? item.evidenceIds.filter(id => typeof id === 'string').slice(0, 10000) : undefined, x: finite(item.x, 80, -100000, 100000), y: finite(item.y, 80, -100000, 100000), width: finite(item.width, 200, 120, 1000), height: finite(item.height, 180, 100, 1000) })
  }
  return result
}
const Highlight = memo(function Highlight({ text, aliases }: { text: string; aliases: string[] }) {
  if (!aliases.length) return <>{text}</>
  const expression = new RegExp(`(${[...aliases].sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return <>{text.split(expression).map((part, index) => aliases.some(alias => alias.toLowerCase() === part.toLowerCase()) ? <mark key={index}>{part}</mark> : part)}</>
})

function OriginalText({ text, aliases }: { text: string; aliases: string[] }) {
  const [page, setPage] = useState(0)
  const count = Math.ceil(text.length / 4000)
  return <><p><Highlight text={text.slice(page * 4000, (page + 1) * 4000)} aliases={aliases} /></p>{count > 1 && <div className="list-pagination"><button disabled={!page} onClick={() => setPage(value => value - 1)}>← 上一段</button><small>原文第 {page + 1} / {count} 段 · 共 {number(text.length)} 字元</small><button disabled={page + 1 >= count} onClick={() => setPage(value => value + 1)}>下一段 →</button></div>}</>
}

function EvidenceCard({ message, aliases, onClick, compact = false }: { message: Evidence; aliases: string[]; onClick: () => void; compact?: boolean }) {
  return <button className={`evidence-card ${compact ? 'compact' : ''}`} onClick={onClick}>
    <span className="evidence-meta"><span>{message.sessionName}</span><time>{date(message.timestamp, !compact)}</time></span>
    <span className="evidence-text"><b>{message.senderName}：</b><Highlight text={message.content.slice(0, 1200)} aliases={aliases} />{message.content.length > 1200 && '…（點開查看完整原文）'}</span>
    {!compact && <span className="evidence-foot">{message.kind === 'text' ? '文字記錄' : `${message.kind} 記錄`} <span>查看原文與上下文 ↗</span></span>}
  </button>
}

export default function CaseboardApp() {
  const [dataset, setDataset] = useState<CaseDataset>(demoDataset)
  const [centerId, setCenterId] = useState(chooseCenter(demoDataset))
  const [selectedId, setSelectedId] = useState<string | null>(chooseCenter(demoDataset))
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [view, setView] = useState<View>('board')
  const [focusBoard, setFocusBoard] = useState(false)
  const [helpSection, setHelpSection] = useState<HelpSection>('start')
  const helpReturnView = useRef<View>('board')
  const openHelp = () => { if (view !== 'help') helpReturnView.current = view; setView('help') }
  const closeHelp = () => setView(helpReturnView.current)
  const [conversationScope, setConversationScope] = useState<ConversationScope>('all')
  const [visitedSteps, setVisitedSteps] = useState<number[]>([])
  const [query, setQuery] = useState('')
  const [peopleQuery, setPeopleQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [kindFilters, setKindFilters] = useState<RelationKind[]>(['direct', 'mention', 'shared-group', 'reply'])
  const [overrides, setOverrides] = useState<AliasMap>(() => readSetting('aliases', {}))
  const [notes, setNotes] = useState<CaseNotes>(() => readSetting('notes', {}))
  const [excluded, setExcluded] = useState<Record<string, string[]>>(() => readSetting('excluded', {}))
  const [pins, setPins] = useState<string[]>(() => readSetting('pins', []))
  const [aliasDraft, setAliasDraft] = useState('')
  const [aliasEditing, setAliasEditing] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [evidencePage, setEvidencePage] = useState(1)
  const [mentionPage, setMentionPage] = useState(1)
  const [onlyPinned, setOnlyPinned] = useState(false)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [coverageOpen, setCoverageOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [restored, setRestored] = useState(false)
  const [saving, setSaving] = useState(false)
  const [setupStep, setSetupStep] = useState(1)
  const [palette, setPalette] = useState(() => readSetting('palette', 'paper'))
  const [boardDocument, setBoardDocument] = useState<BoardDocument>(emptyBoard)
  const [boardLoadedKey, setBoardLoadedKey] = useState('')
  const [connection, setConnection] = useState<ConnectionOptions | null>(null)
  const activeConnection = useRef<ConnectionOptions | null>(null)
  const [mediaLoading, setMediaLoading] = useState('')
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [summaryBusy, setSummaryBusy] = useState(false)
  const [profiles, setProfiles] = useState<Record<string, DossierProfile>>(() => Object.fromEntries(Object.entries(readSetting<Record<string, unknown>>('dossier-profiles', {})).map(([key, value]) => [key, validateProfile(value)])))
  const [profileEditId, setProfileEditId] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<Record<string, { fingerprint: string; value: DossierSummary }>>(() => readSetting('summaries', {}))
  const fileInput = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const storageKey = `${dataset.id}:${centerId}`
  const activeScope = useRef(storageKey)
  activeScope.current = storageKey
  const peopleById = useMemo(() => new Map(dataset.people.map(person => [person.id, person])), [dataset])
  const center = peopleById.get(centerId) || dataset.people[0]
  const selected = peopleById.get(selectedId || '') || center
  const datasetProfiles = useMemo(() => Object.fromEntries(dataset.people.flatMap(person => profiles[`${dataset.id}:${person.id}`] ? [[person.id, profiles[`${dataset.id}:${person.id}`]]] : [])), [dataset, profiles])
  const editPerson = profileEditId ? peopleById.get(profileEditId) : undefined
  const saveProfile = (value: DossierProfile) => { if (!editPerson) return; const next = { ...profiles, [`${dataset.id}:${editPerson.id}`]: value }; setProfiles(next); const saved = storeSetting('dossier-profiles', next); setToast(saved ? '人物檔案與照片已保存，線索板已同步' : '已更新顯示，本地保存失敗，請導出 JSON 保留資料') }
  const customAliases = useMemo<AliasMap>(() => Object.fromEntries(dataset.people.filter(person => person.kind !== 'group' && overrides[dataset.id + ':' + person.id]).map(person => [person.id, overrides[dataset.id + ':' + person.id]])), [dataset, overrides])
  const excludedValues = useMemo(() => excluded[storageKey] || EMPTY_IDS, [excluded, storageKey])
  const excludedIds = useMemo(() => new Set(excludedValues), [excludedValues])
  const pinnedIds = useMemo(() => new Set(pins), [pins])
  const manualReportNotes = useMemo(() => [notes[storageKey] || '', ...boardDocument.items.map(item => `${item.type === 'note' ? '便箋' : '圖片'}：${item.title}（${item.linkedToCenter !== false ? '手動連到中心' : '未連到中心'}）${item.text ? '\n' + item.text : ''}${item.evidenceIds?.length ? '\n來源 ID：' + item.evidenceIds.join('、') : ''}`)].filter(Boolean).join('\n\n'), [notes, storageKey, boardDocument.items])
  const reportDataset = useMemo(() => ({ ...dataset, coverage: { ...dataset.coverage, warnings: [...dataset.coverage.warnings, ...(excludedIds.size ? ['人工排除了 ' + excludedIds.size + ' 條候選記錄。'] : []), ...(startDate || endDate ? ['當前日期範圍：' + (startDate || '不限') + ' 至 ' + (endDate || '不限') + '。'] : [])] } }), [dataset, excludedIds, startDate, endDate])
  const analysisScope = useMemo<AnalysisScope>(() => ({ centerId, customAliases, excludedIds: excludedValues, startDate, endDate, query: deferredQuery, kinds: kindFilters, onlyPinned, pins }), [centerId, customAliases, excludedValues, startDate, endDate, deferredQuery, kindFilters, onlyPinned, pins])
  const analysis = useAnalysis(dataset, analysisScope, view === 'dossier', manualReportNotes, reportDataset.coverage.warnings, conversationScope)
  const { insights, graph, visibleMessages, messageById } = analysis
  const aliases = useMemo<AliasMap>(() => ({ ...Object.fromEntries(dataset.people.filter(person => person.kind !== 'group').map(person => [person.id, analysis.aliases[person.id] || [person.name, ...(person.alias ? [person.alias] : [])]])), ...customAliases }), [dataset, analysis.aliases, customAliases])
  const centerAliases = useMemo(() => aliases[centerId] || [center?.name || ''], [aliases, centerId, center?.name])
  const activeEdge = graph.edges.find(edge => edge.id === selectedEdgeId)
  const edgeMessages = useMemo(() => activeEdge ? activeEdge.evidenceIds.flatMap(id => { const message = messageById.get(id); return message ? [message] : [] }).sort((a, b) => b.timestamp - a.timestamp) : [], [activeEdge, messageById])
  const deferredPeopleQuery = useDeferredValue(peopleQuery)
  const people = useMemo(() => { const search = deferredPeopleQuery.toLowerCase(); return dataset.people.filter(person => person.kind !== 'group' && (person.name + ' ' + (person.alias || '') + ' ' + person.id + ' ' + (aliases[person.id] || []).join(' ')).toLowerCase().includes(search)) }, [dataset, aliases, deferredPeopleQuery])
  const uiIndex = useMemo(() => {
    const counts = new Map<string, number>(), sessions = new Map<string, Evidence[]>()
    for (const message of dataset.messages) {
      counts.set(message.senderId, (counts.get(message.senderId) || 0) + 1)
      if (message.senderId !== message.sessionId) counts.set(message.sessionId, (counts.get(message.sessionId) || 0) + 1)
      const list = sessions.get(message.sessionId)
      if (list) list.push(message); else sessions.set(message.sessionId, [message])
    }
    return { counts, sessions, groups: dataset.people.filter(person => person.kind === 'group' && sessions.has(person.id)) }
  }, [dataset])
  const groups = uiIndex.groups
  const recentMessages = useMemo(() => insights.relatedMessages.slice().sort((a, b) => b.timestamp - a.timestamp).slice(0, 3), [insights.relatedMessages])
  const mediaGroups = useMemo(() => {
    const values = new Map<string, { key: string; message: Evidence; evidenceIds: string[] }>()
    for (const message of insights.relatedMessages) {
      if (message.kind !== 'image' && message.kind !== 'emoji') continue
      const key = message.mediaKey || message.mediaUrl || message.id
      const entry = values.get(key)
      if (entry) entry.evidenceIds.push(message.id)
      else values.set(key, { key, message, evidenceIds: [message.id] })
    }
    return [...values.values()].sort((a, b) => b.evidenceIds.length - a.evidenceIds.length)
  }, [insights.relatedMessages])
  const report = analysis.report?.preview || (analysis.error ? '背景分析未能完成，請查看下方提示。' : '正在背景整理卷宗預覽…')
  const aiManualNotes = manualReportNotes
  const summaryFingerprint = useMemo(() => JSON.stringify([dataset.id, dataset.importedAt, dataset.messages.length, centerId, centerAliases, [...excludedIds].sort(), startDate, endDate, aiManualNotes]), [dataset, centerId, centerAliases, excludedIds, startDate, endDate, aiManualNotes])
  const summary = summaries[storageKey]?.fingerprint === summaryFingerprint ? summaries[storageKey].value : null
  const saveSummary = (value: DossierSummary) => { const next = { ...summaries, [storageKey]: { fingerprint: summaryFingerprint, value } }; setSummaries(next); storeSetting('summaries', next); setView('dossier'); setToast(`${center.name} 的綜合資料綜述已生成，請結合原文核對`) }

  useEffect(() => {
    let active = true
    void readDataset().then(value => {
      if (active && value?.schemaVersion === 1 && Array.isArray(value.people) && value.people.length) { setDataset(value); setCenterId(chooseCenter(value)); setSelectedId(chooseCenter(value)) }
    }).catch(() => {}).finally(() => { if (active) setRestored(true) })
    return () => { active = false }
  }, [])
  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(''), 5000); return () => clearTimeout(timeout) }, [toast])
  useEffect(() => {
    let active = true
    setBoardLoadedKey(''); setBoardDocument(emptyBoard())
    void readBoard(storageKey).then(value => { if (active) { setBoardDocument(value || emptyBoard()); setBoardLoadedKey(storageKey) } }).catch(() => { if (active) setToast('畫布草稿未能讀取，已保留原草稿；請重新載入後再編輯。') })
    return () => { active = false }
  }, [storageKey])
  useEffect(() => {
    if (boardLoadedKey !== storageKey) return
    void storeBoard(storageKey, boardDocument).catch(() => setToast('畫布草稿未能保存，請使用“保存線索板”導出。'))
  }, [boardDocument, boardLoadedKey, storageKey])
  useEffect(() => { setEvidencePage(1); setMentionPage(1) }, [centerId, query, onlyPinned, dataset, startDate, endDate])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); (document.getElementById('help-search') || searchInput.current)?.focus() } }
    window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle)
  }, [])
  useEffect(() => () => { if (activeConnection.current) void window.caseboard?.closeConnection(activeConnection.current).catch(() => {}) }, [])
  const applyDataset = async (value: CaseDataset, nextConnection: ConnectionOptions | null = null) => {
    const previousConnection = activeConnection.current
    activeConnection.current = nextConnection
    if (previousConnection && previousConnection.connectionId !== nextConnection?.connectionId) void window.caseboard?.closeConnection(previousConnection).catch(() => {})
    setDataset(value); setProfileEditId(null); setCenterId(chooseCenter(value)); setSelectedId(chooseCenter(value)); setSelectedEdgeId(null); setAliasDraft(''); setAliasEditing(false); setEvidence(null); setConnection(nextConnection); setQuery(''); setStartDate(''); setEndDate(''); setOnlyPinned(false); setView('board'); setSaving(true)
    try { await storeDataset(value); setToast(`已保存 ${number(value.messages.length)} 條記錄到本地檔案`) } catch { setToast('資料已載入，本地存儲未成功；請導出 JSON 保留資料。') } finally { setSaving(false) }
  }
  const changeCenter = useCallback((id: string) => { if (connectionBusy || summaryBusy) { setToast("請先完成或停止當前讀取任務"); return }; setCenterId(id); setSelectedId(id); setSelectedEdgeId(null); setQuery(''); setAliasDraft(''); setAliasEditing(false); setOnlyPinned(false) }, [connectionBusy, summaryBusy])
  const updateNotes = (value: string) => { const next = { ...notes, [storageKey]: value }; setNotes(next); scheduleSetting('notes', next, () => setToast('備註尚未保存，請導出卷宗保留。')) }
  const saveAliases = () => {
    const values = [...new Set([center.name, ...aliasDraft.split(/[,，;；\n]+/).map(value => value.trim()).filter(value => value.length >= 2)])].slice(0, 30)
    const next = { ...overrides, [storageKey]: values }; setOverrides(next); storeSetting('aliases', next); setAliasEditing(false); setToast('檢索稱呼已更新，已重新分析載入範圍內的全部記錄')
  }
  const excludeEvidence = (message: Evidence) => {
    const next = { ...excluded, [storageKey]: [...new Set([...(excluded[storageKey] || []), message.id])] }; setExcluded(next); storeSetting('excluded', next); setEvidence(null); setToast('已從此人物的分析中排除，可在提及頁恢復')
  }
  const togglePin = (id: string) => { const next = pins.includes(id) ? pins.filter(value => value !== id) : [...pins, id]; setPins(next); storeSetting('pins', next) }
  const goToStep = (step: number) => { if (connectionBusy || summaryBusy) return; setVisitedSteps(current => current.includes(setupStep) ? current : [...current, setupStep]); setSetupStep(step); if (step === 1) setView('board'); if (step === 3 || step === 4) setView('mentions'); if (step === 2 || step === 5) setView('board'); if (step === 6) setView('dossier') }
  const addItem = (item: Omit<BoardItem, 'id' | 'x' | 'y'>) => { if (activeScope.current !== storageKey) throw new Error('當前人物已切換，未向新畫布添加舊素材，請重新選擇。'); if (boardDocument.items.length >= 500) { setToast('每張線索板最多 500 張素材，請另建人物檔案'); return }; setBoardDocument(current => ({ ...current, items: [...current.items, { linkedToCenter: true, ...item, id: crypto.randomUUID(), x: 180 + current.items.length % 3 * 170, y: 240 + Math.floor(current.items.length / 3) * 160 }] })); setView('board') }
  const addNote = () => addItem({ type: 'note', title: '手寫線索', text: '點擊這裡，寫下一條線索…', width: 220, height: 150 })
  const addLocalImage = async (file: File) => {
    try {
      if (!/^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(file.type)) throw new Error('請選擇 PNG、JPEG、GIF 或 WebP 圖片')
      if (file.size > 10 * 1024 * 1024) throw new Error('單張圖片不能超過 10MB')
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file) })
      addItem({ type: 'image', title: file.name, dataUrl, width: 200, height: 210 }); setToast('圖片已釘上線索板，可拖動並調整大小')
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)) }
  }
  const pinMedia = async (group: typeof mediaGroups[number]) => {
    setMediaLoading(group.key)
    try {
      let dataUrl = group.message.mediaUrl?.startsWith('data:image/') ? group.message.mediaUrl : ''
      if (demoMedia[group.key]) {
        const response = await fetch(demoMedia[group.key]); const blob = await response.blob()
        dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob) })
      }
      if (!dataUrl && window.caseboard && connection) dataUrl = (await window.caseboard.media({ ...connection, evidence: group.message })).dataUrl
      if (!dataUrl) throw new Error('請先重新讀取這份本機微信資料，或從本地添加圖片。')
      addItem({ type: 'image', title: `${group.message.kind === 'emoji' ? '表情' : '圖片'} · 出現 ${group.evidenceIds.length} 次`, dataUrl, evidenceIds: group.evidenceIds, width: 190, height: 210 }); setToast('素材已釘上線索板，來源記錄也已保留')
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)) } finally { setMediaLoading('') }
  }
  const exportFile = async (extension: 'md' | 'html' | 'json') => {
    const name = `謠诼-${center.name.replace(/[<>:"/\\|?*]/g, '_')}-${extension === 'json' ? '完整線索板' : scopeLabels[conversationScope]}-${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })}.${extension}`
    setSaving(true)
    try {
      const { renderToStaticMarkup } = await import('react-dom/server.browser')
      const portrait = 'data:image/svg+xml;base64,' + btoa(renderToStaticMarkup(<PixelSprite seed={center.id} kind={center.kind === 'group' ? 'person' : center.kind} variant={datasetProfiles[centerId]?.avatarVariant} size={96} />))
      const content = await analysis.exportFile({ profiles: datasetProfiles, portrait, format: extension, note: manualReportNotes, warnings: reportDataset.coverage.warnings, board: boardDocument, summary, fingerprint: summaryFingerprint, conversationScope, personNote: notes[storageKey] || '' })
      if (window.caseboard) { const result = await window.caseboard.saveFile({ name, content, extension }); if (result.saved) setToast(`卷宗已保存：${result.path || name}`) }
      else { const url = URL.createObjectURL(new Blob([content], { type: extension === 'json' ? 'application/json' : extension === 'html' ? 'text/html' : 'text/markdown' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setToast(`已導出 ${name}`) }
    } catch (error) { setToast(`導出失敗：${error instanceof Error ? error.message : String(error)}`) } finally { setSaving(false) }
  }
  const importFile = async (file: File) => {
    try {
      if (file.size > 150 * 1024 * 1024) throw new Error('文件大於 150MB，請拆分後導入')
      setSaving(true)
      const { dataset: imported, meta } = await analysis.importFile(file)
      await applyDataset(imported)
      if (meta && typeof meta === 'object') {
        const importedCenter = imported.people.some(person => person.id === meta.centerId) ? meta.centerId : chooseCenter(imported)
        const key = `${imported.id}:${importedCenter}`
        if (meta.aliases && typeof meta.aliases === 'object') { const next = { ...overrides }; for (const person of imported.people) { const values = meta.aliases[person.id]; if (Array.isArray(values)) next[`${imported.id}:${person.id}`] = values.filter((value: unknown) => typeof value === 'string' && value.length <= 100).slice(0, 30) }; setOverrides(next); storeSetting('aliases', next) }
        if (typeof meta.notes?.[importedCenter] === 'string') { const next = { ...notes, [key]: meta.notes[importedCenter] }; setNotes(next); storeSetting('notes', next) }
        if (Array.isArray(meta.excluded)) { const next = { ...excluded, [key]: meta.excluded.filter((value: unknown) => typeof value === 'string') }; setExcluded(next); storeSetting('excluded', next) }
        if (Array.isArray(meta.pins)) { const next = meta.pins.filter((value: unknown) => typeof value === 'string'); setPins(next); storeSetting('pins', next) }
        if (meta.profiles && typeof meta.profiles === 'object') { const next = { ...profiles }; for (const person of imported.people) if (Object.prototype.hasOwnProperty.call(meta.profiles, person.id)) next[`${imported.id}:${person.id}`] = validateProfile(meta.profiles[person.id]); setProfiles(next); storeSetting('dossier-profiles', next) }
        if (meta.board) { const safe = validateBoard(meta.board); await storeBoard(key, safe); setBoardDocument(safe); setBoardLoadedKey(key) }
        const importedSummary = validateStoredSummary(meta.summary?.value, imported.messages, importedCenter)
        if (importedSummary && typeof meta.summary?.fingerprint === 'string') { const next = { ...summaries, [key]: { fingerprint: meta.summary.fingerprint, value: importedSummary } }; setSummaries(next); storeSetting('summaries', next) }
        if (meta.filters && typeof meta.filters === 'object') { if (typeof meta.filters.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(meta.filters.startDate)) setStartDate(meta.filters.startDate); if (typeof meta.filters.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(meta.filters.endDate)) setEndDate(meta.filters.endDate); if (Array.isArray(meta.filters.kinds)) setKindFilters(meta.filters.kinds.filter((kind: unknown) => typeof kind === 'string' && Object.prototype.hasOwnProperty.call(relationLabels, kind))) }
        setCenterId(importedCenter); setSelectedId(importedCenter)
      }
      setSetupStep(2)
    } catch (error) { setToast(`導入失敗：${error instanceof Error ? error.message : String(error)}`) } finally { setSaving(false) }
  }
  const sourceLabel = dataset.source === 'demo' ? '虛構演示檔案' : dataset.source === 'local' ? '本機微信資料' : '導入的聊天資料'
  const topConversation = insights.conversationMentions[0]
  const hitIds = useMemo(() => new Set(insights.hits.map(hit => hit.evidenceId)), [insights])
  const evidenceContext = useMemo(() => {
    if (!evidence) return []
    const session = (uiIndex.sessions.get(evidence.sessionId) || []).slice().sort((a, b) => a.timestamp - b.timestamp)
    const index = session.findIndex(message => message.id === evidence.id)
    return session.slice(Math.max(0, index - 2), index + 3)
  }, [uiIndex, evidence])

  const selectNode = useCallback((id: string) => { setSelectedId(id); setSelectedEdgeId(null) }, [])
  const updateLayout = useCallback((layout: BoardDocument['layout']) => setBoardDocument(current => ({ ...current, layout: { ...current.layout, ...layout } })), [])
  const updateItems = useCallback((items: BoardItem[]) => setBoardDocument(current => ({ ...current, items })), [])
  const openEvidence = useCallback((id: string) => setEvidence(messageById.get(id) || null), [messageById])
  return <div className={`case-app${view === 'board' && focusBoard ? ' is-board-focused' : ''}${view === 'help' ? ' is-help-open' : ''}${view === 'dossier' ? ' is-dossier-open' : ''}`} data-palette={palette}>
    <aside className="app-sidebar">
      <div className="brand"><span className="brand-symbol">诼</span><div><h1>謠诼</h1><small>YAOZHUO ARCHIVE</small></div></div>
      <div className="workspace-label"><span>▣</span> 我的記憶檔案室 <span className="live-dot" /></div>
      <nav className="workflow-steps" aria-label="設定步驟">{setupSteps.map((label, index) => <button key={label} disabled={connectionBusy || summaryBusy} onClick={() => goToStep(index + 1)} className={view !== 'help' && setupStep === index + 1 ? 'active' : visitedSteps.includes(index + 1) ? 'done' : ''} aria-current={view !== 'help' && setupStep === index + 1 ? 'step' : undefined}><span>{String(index + 1).padStart(2, '0')}</span><b>{label}</b><i>{visitedSteps.includes(index + 1) ? '·' : view !== 'help' && setupStep === index + 1 ? '◂' : ''}</i></button>)}<button className={`help-nav-button${view === 'help' ? ' active' : ''}`} aria-label="07 幫助" aria-current={view === 'help' ? 'page' : undefined} onClick={openHelp}><span>07</span><b>幫助</b><i>?</i></button></nav>
      <div className="workflow-panel" hidden={view === 'help'}><div className="step-context"><small>本次整理對象</small><b>{center.name}</b><span>{sourceLabel} · {insights.relatedMessages.length} 條相關記錄</span></div><div className="step-heading"><small>{stepSubtitles[setupStep - 1]}</small><h3>{setupSteps[setupStep - 1]}</h3></div><p className="step-task">{["選擇來源，讀取並載入所需會話；可先用演示資料走完流程。", "點選一位人物，確認上方顯示的整理對象。", "核對姓名、外號和縮寫，修改後點更新。", "先看完整清單，再核對歧義、原文與日期範圍。", "添加便箋或圖片；卡片底部可切換與中心的連線。", "先選報告範圍，再預覽或導出；JSON 保存完整布局。"][setupStep - 1]}</p>
        {setupStep === 1 && (connectionOpen ? <ConnectionSetup onBusyChange={setConnectionBusy} onClose={() => setConnectionOpen(false)} onLoaded={(value, options) => { void applyDataset(value, options); setConnectionOpen(false); setSetupStep(2) }} /> : <><p className="step-help">從本機微信資料開始，自動識別帳號並填充密鑰；也可以導入已有檔案。</p><div className="source-options"><button className="pixel-btn gold" disabled={connectionBusy || summaryBusy} onClick={() => setConnectionOpen(true)}>⌁ 讀取本機微信資料</button><button className="pixel-btn" disabled={connectionBusy || summaryBusy} onClick={() => fileInput.current?.click()}>↥ 導入 JSON 資料 / 線索板</button><button className="text-btn" disabled={connectionBusy || summaryBusy} onClick={() => { void applyDataset(demoDataset); setSetupStep(2) }}>使用虛構演示檔案 ↗</button></div></>)}
        {setupStep === 2 && <><p className="step-help">選擇這次要了解的人。雙擊畫布人物卡也能切換中心。</p><label className="person-search"><span>⌕</span><input aria-label="搜索人物" placeholder="姓名、備註、縮寫…" value={peopleQuery} onChange={event => setPeopleQuery(event.target.value)} /></label><div className="person-list"><PagedList key={peopleQuery} items={people} size={40} label="可選人物">{person => <button key={person.id} onClick={() => changeCenter(person.id)} className={person.id === centerId ? 'selected' : ''}><span className="mini-avatar"><PixelSprite seed={person.id} variant={datasetProfiles[person.id]?.avatarVariant} kind={person.kind} size={28} /></span><span>{person.name}<small>{person.kind === 'self' ? '當前帳號' : (aliases[person.id] || []).find(alias => /^[a-z]+$/i.test(alias)) || '聯絡人'}</small></span>{person.id === centerId && <i>◆</i>}</button>}</PagedList></div></>}
        {setupStep === 3 && <><p className="step-help">這些稱呼會用於跨會話檢索。請核對多音字縮寫，並補充昵稱和舊備註。</p><div className="alias-chips">{centerAliases.map(alias => <span key={alias}>{alias}</span>)}</div><label className="form-label">姓名 / 外號 / 拼音縮寫<textarea aria-label="編輯檢索稱呼" value={aliasDraft || centerAliases.join('，')} onFocus={() => { if (!aliasDraft) setAliasDraft(centerAliases.join('，')) }} onChange={event => setAliasDraft(event.target.value)} /></label><button className="pixel-btn gold" onClick={saveAliases}>更新稱呼並重新檢索</button><p className="step-help">例如：王小明，wxm，小明，明哥。名字匹配是線索，是否指同一人仍需結合原文判斷。</p></>}
        {setupStep === 4 && <>{startDate && endDate && startDate > endDate && <p className="form-error">開始日期不能晚於結束日期，請調整後繼續。</p>}<p className="step-help">在載入範圍內篩查命中記錄，點開原文核實，可排除與此人無關的消息。</p><div className="scan-stat"><b>{insights.hits.length}</b><span>條稱呼命中</span><small>{insights.hits.filter(hit => hit.ambiguous).length} 條需要核實歧義</small></div><label className="form-label">開始日期<input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label><label className="form-label">結束日期<input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label><button className="pixel-btn gold" onClick={() => setView('clues')}>列出全部線索 ↗</button><button className="pixel-btn" onClick={() => setView('mentions')}>查看提及排行與話題 ↗</button><button className="pixel-btn" onClick={() => setView('timeline')}>逐條核對原文 ↗</button><button className="text-btn" onClick={() => setCoverageOpen(true)}>檢查資料覆蓋範圍 ↗</button>{!!excludedIds.size && <button className="text-btn" onClick={() => { const next = { ...excluded, [storageKey]: [] }; setExcluded(next); storeSetting('excluded', next) }}>恢復已排除的 {excludedIds.size} 條記錄</button>}</>}
        {setupStep === 5 && <><p className="step-help">把記憶釘上來。拖動卡片調整位置，拖動右下角改變素材大小。</p><CharacterGallery /><div className="arrange-actions"><button className="pixel-btn gold" onClick={addNote}>＋ 手寫便箋</button><button className="pixel-btn" onClick={() => imageInput.current?.click()}>＋ 本地圖片 / 表情</button></div><div className="section-title"><h4>常出現的圖片與表情</h4><span>{mediaGroups.length}</span></div><p className="step-help tiny">相同文件標識合並計數。素材點擊後從本機微信資料讀取。</p><div className="media-library"><PagedList items={mediaGroups} size={12} label="相關圖片與表情">{group => <button key={group.key} disabled={!!mediaLoading} onClick={() => void pinMedia(group)}>{demoMedia[group.key] || group.message.mediaUrl?.startsWith('data:image/') ? <img src={demoMedia[group.key] || group.message.mediaUrl} alt="素材縮略圖" /> : <span className="media-placeholder">{group.message.kind === 'emoji' ? '☺' : '▧'}</span>}<span><b>{group.message.kind === 'emoji' ? '表情包' : '聊天圖片'}</b><small>{group.evidenceIds.length} 次 · {group.message.sessionName}</small></span><i>{mediaLoading === group.key ? '…' : '＋'}</i></button>}</PagedList></div></>}
        {setupStep === 6 && <><p className="step-help">保存人物、消息、圖片和便箋的完整資料與布局，下次導入可接著整理。</p><button className="pixel-btn gold" onClick={() => void exportFile('json')}>▣ 保存完整線索板</button><button className="pixel-btn" onClick={() => void storeBoard(storageKey, boardDocument).then(() => setToast('線索板已保存到本地草稿')).catch(() => setToast('本地保存失敗，請導出 JSON'))}>保存本地草稿</button><div className="step-divider" /><AISummarySetup key={storageKey} revision={summaryFingerprint} context={{ centerName: center.name, centerId, ownerId: dataset.ownerId, aliases: centerAliases, messages: insights.relatedMessages, coverageDescription: reportDataset.coverage.description, warnings: reportDataset.coverage.warnings, manualNotes: aiManualNotes }} onGenerated={saveSummary} onBusyChange={setSummaryBusy} /><div className="step-divider" /><label className="form-label">人物檔案<button className="pixel-btn" onClick={() => setView('dossier')}>預覽人物卷宗 ↗</button></label><ScopeTabs value={conversationScope} onChange={setConversationScope} /><button className="pixel-btn" onClick={() => void exportFile('html')}>導出可打印檔案</button><button className="pixel-btn" onClick={() => void exportFile('md')}>導出 Markdown</button><p className="step-help">JSON 保留全部資料、布局與手動連線。HTML / Markdown 用於閱讀、打印和歸檔。</p></>}
      </div>{view === 'help' && <HelpSidebar section={helpSection} onSection={setHelpSection} />}<div className="step-footer">{view === 'help' ? <><span>07 · 幫助{connectionBusy || summaryBusy ? ' · 任務繼續處理中' : ''}</span><button onClick={closeHelp}>返回整理 →</button></> : <><button disabled={setupStep === 1 || connectionBusy || summaryBusy} onClick={() => goToStep(setupStep - 1)}>← 上一步</button><span>{setupStep} / 6</span><button disabled={setupStep === 6 || connectionBusy || summaryBusy || analysis.busy || (!!startDate && !!endDate && startDate > endDate)} onClick={() => goToStep(setupStep + 1)}>確認並繼續 →</button></>}</div><div className="sidebar-bottom"><div className="pixel-shelf"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div><small>本地處理 · 記憶由你保管</small></div>
    </aside>

    <main className="app-main">
      <header className="topbar"><div className="breadcrumb">檔案室 <span>/</span> 人物線索 <span>/</span> <b>{center?.name}</b></div><div className="topbar-actions"><span className={`source-badge ${dataset.source === 'demo' ? 'demo' : ''}`}><i />{sourceLabel}</span><button className="plain-btn palette-switch" onClick={() => { const next = palette === 'paper' ? 'crt' : 'paper'; setPalette(next); storeSetting('palette', next) }}>{palette === 'paper' ? '▣ 夜色 CRT' : '▤ 紙面模式'}</button><button className="pixel-btn small" onClick={() => void exportFile('json')}>▣ 保存線索板</button></div></header>
      <input hidden type="file" accept=".json,application/json" ref={fileInput} onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = '' }} />
      <input hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp" ref={imageInput} onChange={event => { const file = event.target.files?.[0]; if (file) void addLocalImage(file); event.target.value = '' }} />
      <section className="case-header"><div><div className="eyebrow">PERSON FILE <span>·</span> {dataset.source === 'demo' ? 'DEMO 001' : 'LOCAL ARCHIVE'}</div><h2>關於 <span>{center?.name}</span> 的蛛絲馬跡<span className="title-dot">。</span></h2><p>從一次對話出發，找回人與人之間的聯繫。</p></div><div className="case-actions"><span className="archive-stamp">RECOLLECT<br /><strong>謠 / 诼</strong></span><button className="pixel-btn gold" onClick={() => { setView('dossier'); setExportOpen(true) }}>▤ 生成卷宗 <span>↗</span></button></div></section>
      <div className="case-summary"><button onClick={() => setCoverageOpen(true)}><b>{number(dataset.messages.length)}</b><span>已載入消息</span></button><button onClick={() => setView('mentions')}><b>{number(insights.hits.length)}</b><span>提及記錄</span></button><button onClick={() => setView('mentions')}><b>{number(insights.conversationMentions.length)}</b><span>相關會話</span></button><button onClick={() => setView('board')}><b>{number(groups.length)}</b><span>已載入群聊</span></button><div className={`coverage-state ${dataset.coverage.partial ? 'partial' : ''}`}><span>◆</span><div>{dataset.source === 'demo' ? '演示資料 · 全部為虛構內容' : dataset.coverage.partial ? '資料範圍尚不完整' : '已完成所選會話的載入'}<button onClick={() => setCoverageOpen(true)}>查看數據範圍 ↗</button></div></div></div>
      <div className="workspace-toolbar"><div className="view-tabs">{views.map(item => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}>{item.label}{view === item.id && <i />}</button>)}</div><label className="global-search"><span>⌕</span><input ref={searchInput} aria-label="搜索線索關鍵詞" placeholder="檢索人物 / 關鍵詞…" value={query} onChange={event => setQuery(event.target.value)} /><kbd>{/Mac/.test(navigator.platform) ? '⌘ F' : 'Ctrl F'}</kbd></label></div>

      <div className={`workspace-content ${['dossier', 'statistics', 'clues', 'help'].includes(view) ? 'report-workspace' : ''}`}>
        <section className="workspace-primary">
          {(analysis.busy || analysis.error) && <div className="analysis-status" role="status">{analysis.error || '正在背景檢索與整理全部記錄，可繼續操作…'}</div>}
          {view === 'board' && <><div className="board-filter"><span>顯示聯繫</span>{(['direct', 'mention', 'shared-group', 'reply'] as RelationKind[]).map(kind => <button key={kind} aria-pressed={kindFilters.includes(kind)} className={`${kind} ${kindFilters.includes(kind) ? 'on' : ''}`} onClick={() => setKindFilters(current => current.includes(kind) ? current.filter(value => value !== kind) : [...current, kind])}><i />{relationLabels[kind]}</button>)}<button className="board-focus-toggle" aria-pressed={focusBoard} onClick={() => setFocusBoard(value => !value)}>{focusBoard ? '展開概覽' : '專注畫布'}</button></div><PixelBoard profiles={datasetProfiles} key={storageKey} graph={graph} centerId={centerId} selectedId={selectedId} selectedEdgeId={selectedEdgeId} onSelectNode={selectNode} onSelectEdge={setSelectedEdgeId} onCenter={changeCenter} query={deferredQuery} layout={boardDocument.layout} onLayoutChange={updateLayout} items={boardDocument.items} onItemsChange={updateItems} onOpenEvidence={openEvidence} /><div className="canvas-caption"><span>◇ {center?.name} 是這次探索的中心</span><span>拖動畫布與人物 · 滾輪縮放 · 點擊連線看依據</span></div></>}

          {view === 'help' && <HelpPage section={helpSection} busy={connectionBusy || summaryBusy} onStep={goToStep} onView={setView} />}
          {view === 'clues' && <ClueInventory graph={analysis.completeGraph} insights={insights} items={boardDocument.items} onNode={id => { selectNode(id); setView('board'); setQuery(''); setKindFilters(['direct', 'mention', 'shared-group', 'reply']) }} onEdge={id => { setSelectedEdgeId(id); setView('board'); setQuery(''); setKindFilters(['direct', 'mention', 'shared-group', 'reply']) }} onEvidence={openEvidence} onArrange={() => goToStep(5)} />}
          {view === 'statistics' && <StatisticsPanel statistics={analysis.statistics} scope={conversationScope} onScope={setConversationScope} onEvidence={openEvidence} onReport={format => void exportFile(format)} />}

          {view === 'mentions' && <div className="scroll-page mentions-page"><div className="page-intro"><small>FOLLOW THE MENTIONS</small><h3>那些提起 {center?.name} 的對話</h3><p>按你確認的稱呼檢索載入的全部記錄，縮寫和同名命中保留待核實標記。</p></div><div className="alias-panel"><div><b>檢索稱呼</b><span>{centerAliases.join(' / ')}</span></div><button className="text-btn" onClick={() => { setAliasDraft(centerAliases.join('，')); setAliasEditing(true) }}>編輯稱呼 ↗</button></div>
            <div className="insight-callout"><span>“</span><p>{topConversation ? <>在與 <b>{topConversation.name}</b> 的對話中，提及了 <b>{number(topConversation.count)}</b> 次。<br /><small>其中由當前帳號提起 {number(topConversation.selfCount)} 次；每條命中均可查看原文。</small></> : '還沒有發現提及。試試補充姓名、舊備註或聊天時常用的簡稱。'}</p></div>
            <div className="section-title"><h4>在哪些對話裡，經常提起？</h4><span>{insights.conversationMentions.length} 個會話</span></div><div className="mention-ranking">{insights.conversationMentions.slice((mentionPage - 1) * 40, mentionPage * 40).map((item, localIndex) => <button key={item.sessionId} onClick={() => { setQuery(item.name); setView('timeline') }}><span className="rank-index">{String((mentionPage - 1) * 40 + localIndex + 1).padStart(2, '0')}</span><span className="rank-content"><b>{item.name}</b><span className="rank-bar"><i style={{ width: `${Math.max(5, item.count / (topConversation?.count || 1) * 100)}%` }} /></span><small>我提起 {item.selfCount} 次 · 對方 / 群成員提起 {item.count - item.selfCount} 次</small></span><strong>{item.count}<small>次</small></strong><span>↗</span></button>)}</div>
            {insights.conversationMentions.length > 40 && <div className="list-pagination"><button disabled={mentionPage <= 1} onClick={() => setMentionPage(value => value - 1)}>← 上一頁</button><span>{mentionPage} / {Math.ceil(insights.conversationMentions.length / 40)}</span><button disabled={mentionPage * 40 >= insights.conversationMentions.length} onClick={() => setMentionPage(value => value + 1)}>下一頁 →</button></div>}<div className="section-title"><h4>與這個人有關的高頻話題</h4><span>基於相關消息的本地詞頻</span></div><div className="topic-grid">{insights.topics.slice(0, 8).map((topic, index) => <button key={topic.label} onClick={() => { setQuery(topic.label); setView('timeline') }}><small>TOPIC {String(index + 1).padStart(2, '0')}</small><b>{topic.label}</b><span>{topic.count} 條依據 ↗</span></button>)}{!insights.topics.length && <p className="empty-note">相關記錄還不足以提取話題。</p>}</div>
            <div className="section-title"><h4>提及原文</h4><span>名字和縮寫只是線索，原文才是依據</span></div><PagedList key={storageKey + startDate + endDate} items={insights.hits} size={20} label="提及原文">{hit => { const message = messageById.get(hit.evidenceId); return message ? <div className="mention-evidence" key={hit.evidenceId}><span className={hit.ambiguous ? 'candidate-tag' : 'match-tag'}>{hit.ambiguous ? '待核實' : '稱呼命中'} · {hit.matchedAlias}</span><EvidenceCard message={message} aliases={centerAliases} onClick={() => setEvidence(message)} /></div> : null }}</PagedList>
            {!!excludedIds.size && <button className="text-btn restore-btn" onClick={() => { const next = { ...excluded, [storageKey]: [] }; setExcluded(next); storeSetting('excluded', next) }}>已排除 {excludedIds.size} 條候選，點擊全部恢復</button>}
          </div>}

          {view === 'timeline' && <div className="scroll-page timeline-page"><div className="page-intro"><small>PIECES OF MEMORY</small><h3>散落在對話裡的記憶</h3><p>直接對話、稱呼命中與相鄰上下文，共 {number(visibleMessages.length)} 條可查看記錄。</p></div><div className="timeline-controls"><label>從 <input type="date" aria-label="開始日期" value={startDate} onChange={event => setStartDate(event.target.value)} /></label><label>至 <input type="date" aria-label="結束日期" value={endDate} onChange={event => setEndDate(event.target.value)} /></label><button aria-pressed={onlyPinned} className={onlyPinned ? 'on' : ''} onClick={() => setOnlyPinned(value => !value)}>◆ 僅看已釘選</button>{(startDate || endDate || query) && <button onClick={() => { setStartDate(''); setEndDate(''); setQuery('') }}>清除篩選</button>}</div><div className="timeline-list">{visibleMessages.slice((evidencePage - 1) * 35, evidencePage * 35).map(message => <article className="timeline-item" key={message.id}><span className={`timeline-point ${hitIds.has(message.id) ? 'mention' : ''}`} /><div className="timeline-date">{date(message.timestamp)}<small>{new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small></div><div className="timeline-record"><EvidenceCard message={message} aliases={centerAliases} onClick={() => setEvidence(message)} /><button className={`pin-button ${pinnedIds.has(message.id) ? 'pinned' : ''}`} aria-label={`${pinnedIds.has(message.id) ? '取消釘選' : '釘選'}消息 ${message.id}`} onClick={() => togglePin(message.id)}>◆</button></div></article>)}</div>{!visibleMessages.length && <div className="empty-state"><span>◇</span><h4>這裡暫時沒有線索</h4><p>可以換個關鍵詞，或清除日期和釘選篩選。</p><button className="pixel-btn" onClick={() => { setQuery(''); setStartDate(''); setEndDate(''); setOnlyPinned(false) }}>清除篩選</button></div>}{visibleMessages.length > 35 && <div className="list-pagination"><button className="pixel-btn" disabled={evidencePage <= 1} onClick={() => setEvidencePage(value => value - 1)}>← 上一頁</button><span>第 {evidencePage} / {Math.ceil(visibleMessages.length / 35)} 頁 · 全部 {number(visibleMessages.length)} 條</span><button className="pixel-btn" disabled={evidencePage * 35 >= visibleMessages.length} onClick={() => setEvidencePage(value => value + 1)}>下一頁 →</button></div>}</div>}

          {view === 'dossier' && <div className="scroll-page dossier-page"><DossierFile person={center} profile={datasetProfiles[centerId]} aliases={centerAliases} statistics={analysis.statistics} summary={conversationScope === 'all' ? summary : null} sourceLabel={sourceLabel} onEdit={() => setProfileEditId(centerId)} /><ScopeTabs value={conversationScope} onChange={setConversationScope} /><p className="form-help">當前卷宗：{scopeLabels[conversationScope]}。全部報告包含三種範圍的統計；單獨報告只包含所選範圍原文。</p><button className="text-btn" onClick={() => setView('statistics')}>查看圖表與會話總計 ↗</button><div className="dossier-actions"><button className="pixel-btn gold" onClick={() => void exportFile('html')}>導出可打印檔案 ↗</button><button className="pixel-btn" onClick={() => void exportFile('md')}>Markdown</button><button className="pixel-btn" onClick={() => void exportFile('json')}>JSON 資料包</button></div><div className="dossier-ai-entry"><button className="pixel-btn" onClick={() => setSetupStep(6)}>◇ 配置外接 AI 生成綜合資料綜述 ↗</button>{summaries[storageKey] && !summary && <p className="form-help">資料或篩查條件已變更，舊總結需要重新生成。</p>}</div>{conversationScope === 'all' && summary && <SummaryReport summary={summary} onEvidence={id => setEvidence(messageById.get(id) || null)} />}{analysis.report && analysis.report.characters > analysis.report.preview.length && <p className="form-help">預覽顯示前 30,000 字元；HTML / Markdown 導出保留全部原文與證據。</p>}<details className="dossier-originals"><summary>04 原文索引與完整統計 · 展開查閱</summary><pre className="dossier-preview">{report}</pre></details></div>}
        </section>

        <aside className="inspector"><div className="inspector-title"><span>{activeEdge ? '關係依據' : '人物檔案'}</span><small>{activeEdge ? 'EVIDENCE' : 'PERSON FILE'}</small></div>{activeEdge ? <><div className="edge-overview"><span className="match-tag">{relationLabels[activeEdge.kind]}</span><h3>{peopleById.get(activeEdge.source)?.name}<span>↔</span>{peopleById.get(activeEdge.target)?.name}</h3><p>{activeEdge.label}</p><small>{activeEdge.evidenceIds.length} 條消息依據{!activeEdge.evidenceIds.length && ' · 來自已載入的成員關係'}</small></div><div className="inspector-scroll"><PagedList key={selectedEdgeId} items={edgeMessages} size={20} label="關係原文">{message => <EvidenceCard key={message.id} message={message} aliases={centerAliases} onClick={() => setEvidence(message)} compact />}</PagedList>{!edgeMessages.length && <p className="muted">成員關係只表示出現在同一個群，不代表存在私下交往。</p>}</div></> : <><div className="profile-art"><span className="photo-corner tl" /><span className="photo-corner tr" /><PixelSprite seed={selected?.id || 'unknown'} variant={datasetProfiles[selected.id]?.avatarVariant} kind={datasetProfiles[selected.id]?.avatarVariant !== undefined && selected.kind === 'group' ? 'person' : selected?.kind} size={94} /><span className="profile-photo-no">NO. {String(Math.max(0, dataset.people.findIndex(person => person.id === selected?.id)) + 1).padStart(3, '0')}</span></div><div className="profile-name"><h3>{datasetProfiles[selected.id]?.displayName || selected?.name}</h3><span>{selected?.kind === 'self' ? '當前帳號' : selected?.kind === 'group' ? '群聊' : '人物'}</span><small>{selected?.id}</small></div><button className="text-btn edit-inspector-profile" onClick={() => setProfileEditId(selected.id)}>編輯人物檔案 / 更換照片 ↗</button>{selectedId !== centerId && <button className="pixel-btn center-person" onClick={() => changeCenter(selected.id)}>以 {selected.name} 為中心 ↗</button>}
          <div className="profile-fields"><div><span>稱呼線索</span><b>{(aliases[selected?.id] || [selected?.name]).slice(0, 4).join(' / ')}</b></div><div><span>資料來源</span><b>{sourceLabel}</b></div><div><span>關聯消息</span><b>{number(uiIndex.counts.get(selected?.id || '') || 0)} 條已載入記錄</b></div></div>
          {selectedId === centerId && <><button className="edit-alias-btn" onClick={() => { setAliasDraft(centerAliases.join('，')); setAliasEditing(true) }}>＋ 補充外號 / 縮寫</button><div className="note-box"><label htmlFor="person-note">手寫備註 <span>MEMO</span></label><textarea id="person-note" aria-label="人物手寫備註" placeholder="寫下一點你知道的事…" value={notes[storageKey] || ''} onChange={event => updateNotes(event.target.value)} /><small>人工備註會單獨標注在卷宗中</small></div></>}
          <div className="inspector-section"><div className="section-title"><h4>最近的線索</h4><button className="text-btn" onClick={() => setView('timeline')}>全部 ↗</button></div>{recentMessages.map(message => <EvidenceCard key={message.id} message={message} aliases={centerAliases} onClick={() => setEvidence(message)} compact />)}</div><div className="inspector-bottom">◆ 從記錄出發，讓聯繫有據可循。</div></> }</aside>
      </div>
      <footer className="statusbar"><span><i />{!restored ? '正在恢復本地檔案…' : analysis.busy ? '正在背景整理資料…' : saving ? '正在保存本地檔案…' : '檔案已在本地就緒'}</span><span>{dataset.source === 'demo' ? '演示人物與對話均為虛構' : `${dataset.coverage.sessionCount} 個會話 · ${number(dataset.messages.length)} 條消息`} <span>│</span> YAOZHUO v0.4.2</span></footer>
    </main>

    {editPerson && <DossierEditor key={`${dataset.id}:${editPerson.id}`} person={editPerson} profile={datasetProfiles[editPerson.id]} summary={editPerson.id === centerId ? summary : null} onSave={saveProfile} onClose={() => setProfileEditId(null)} />}
    {aliasEditing && <Modal title="這個人，還被怎樣稱呼？" subtitle="NAME / ALIAS / INITIALS" onClose={() => setAliasEditing(false)}><div className="modal-body"><p>姓名與拼音首字母會自動生成。補充外號、英文名、舊備註，用逗號分隔。刪除不適合的自動簡稱，可減少誤匹配。</p><label className="form-label">{center?.name} 的檢索稱呼<textarea autoFocus value={aliasDraft} onChange={event => setAliasDraft(event.target.value)} placeholder="王小明，wxm，小明，明哥" /></label><p className="form-help">縮寫不區分大小寫，匹配完整字母片段；多音字與同名需要你核對原文。</p><button className="pixel-btn gold" onClick={saveAliases}>保存並重新檢索</button></div></Modal>}

    {coverageOpen && <Modal title="這份檔案，覆蓋了哪些資料？" onClose={() => setCoverageOpen(false)}><div className="modal-body coverage-details"><span className="match-tag">{sourceLabel}</span><p>{dataset.coverage.description}</p><dl><dt>載入時間</dt><dd>{date(dataset.importedAt, true)}</dd><dt>實際記錄</dt><dd>{number(dataset.messages.length)} 條 / {dataset.coverage.sessionCount} 個會話</dd><dt>掃描狀態</dt><dd>{dataset.coverage.partial ? '部分資料，存在未完成或截斷' : '所選資料已載入完成'}</dd><dt>分析方式</dt><dd>姓名 / 別名匹配 + 本地話題詞頻</dd></dl>{dataset.coverage.warnings.map((warning, index) => <p className="coverage-warning" key={index}>◇ {warning}</p>)}<p className="form-help">關係僅代表這些記錄支持的聯繫。未出現的對話、未知稱呼和未載入資料無法從這份檔案中判斷。</p></div></Modal>}
    {exportOpen && <Modal title="把記憶，整理成一份卷宗。" subtitle="COMPILE THE DOSSIER" onClose={() => setExportOpen(false)}><div className="modal-body"><p>已匯總 {center?.name} 的直接聯繫、提及排行、高頻話題、原文依據與手寫備註。</p><div className="export-options"><button onClick={() => void exportFile('html')}><span>▤</span><b>可打印檔案</b><small>HTML · 瀏覽器打印可保存 PDF</small><i>↗</i></button><button onClick={() => void exportFile('md')}><span>≡</span><b>Markdown 卷宗</b><small>適合繼續編輯和歸檔</small><i>↗</i></button><button onClick={() => void exportFile('json')}><span>▣</span><b>JSON 資料包</b><small>保存原始資料，支持再次導入</small><i>↗</i></button></div><p className="form-help">所有導出均保存在你選擇的本地位置。</p></div></Modal>}
    {evidence && <Modal title="這一條線索的原文" subtitle={`${evidence.sessionName} / ORIGINAL RECORD`} onClose={() => setEvidence(null)} wide><div className="modal-body evidence-detail"><div className="evidence-identifiers"><span>會話：{evidence.sessionName}</span><span>時間：{date(evidence.timestamp, true)}</span><span>來源 ID：{evidence.originalId || evidence.id}</span></div><div className="context-list">{evidenceContext.map(message => <article key={message.id} className={`${message.id === evidence.id ? 'focused' : ''} ${message.senderId === dataset.ownerId ? 'self' : ''}`}><span>{message.senderName} <small>{date(message.timestamp, true)}</small></span><OriginalText text={message.content} aliases={centerAliases} />{message.id === evidence.id && <small>↑ 當前選中的原始記錄</small>}</article>)}</div><div className="evidence-detail-actions"><button className="pixel-btn" onClick={() => togglePin(evidence.id)}>{pins.includes(evidence.id) ? '取消釘選' : '◆ 釘選這條證據'}</button><button className="plain-btn" onClick={() => excludeEvidence(evidence)}>與此人無關，排除此條</button></div></div></Modal>}
    {toast && <div className="toast" role="status"><span>◆</span>{toast}<button aria-label="關閉提示" onClick={() => setToast('')}>×</button></div>}
  </div>
}

function ConnectionSetup({ onClose, onLoaded, onBusyChange }: { onClose: () => void; onLoaded: (data: CaseDataset, options: ConnectionOptions) => void; onBusyChange: (value: boolean) => void }) {
  const [accountPath, setAccountPath] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [ownerName, setOwnerName] = useState('我')
  const [key, setKey] = useState('')
  const [keyMap, setKeyMap] = useState('')
  const [imageKey, setImageKey] = useState('')
  const [xorKey, setXorKey] = useState('')
  const [discovery, setDiscovery] = useState<NativeDiscovery | null>(null)
  const [autoResult, setAutoResult] = useState<NativeAutoResult | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [catalog, setCatalog] = useState<NativeCatalog | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [maxMessages, setMaxMessages] = useState('0')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [phase, setPhase] = useState<'discover' | 'folder' | 'auto' | 'catalog' | 'load'>('catalog')
  const [error, setError] = useState('')
  const [folderHint, setFolderHint] = useState('')
  const [progress, setProgress] = useState({ sessionsDone: 0, sessionsTotal: 0, messages: 0, sessionName: '' })
  const mounted = useRef(true)
  const busy = useRef(false)
  const reading = useRef(false)
  const liveConnection = useRef<string | null>(null)
  const release = () => {
    const connectionId = liveConnection.current
    liveConnection.current = null
    if (connectionId) void window.caseboard?.closeConnection({ connectionId }).catch(() => {})
  }
  const invalidate = () => { release(); setCatalog(null); setSelected([]); setError('') }
  const invalidateConfiguration = () => { invalidate(); setAutoResult(null) }
  const begin = (nextPhase: typeof phase) => { busy.current = true; setLoading(true); setPhase(nextPhase); setError(''); onBusyChange(true) }
  const finish = () => { busy.current = false; if (mounted.current) { setLoading(false); onBusyChange(false) } }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; if (reading.current) void window.caseboard?.cancelLoad().catch(() => {}); release(); onBusyChange(false) }
  }, [onBusyChange])
  useEffect(() => window.caseboard?.onProgress(value => { if (mounted.current) setProgress(value) }), [])
  // Opening this panel discovers directories only. Process/key access starts
  // exclusively from the explicit automatic-fill button or an account choice.
  useEffect(() => {
    let active = true
    if (window.caseboard) void window.caseboard.discover().then(result => {
      if (!active || !mounted.current) return
      setDiscovery(previous => previous || result)
      setFolderHint(previous => previous || (result.accounts.length > 1 ? '發現多個帳號，請選擇本次要讀取的帳號。' : result.accounts.length ? '已發現帳號目錄，點擊自動識別並填充繼續。' : '未在常見位置發現帳號，可以自動重試或展開手動設定。'))
    }).catch(() => { if (active && mounted.current) setFolderHint('暫未取得帳號目錄，可點擊自動識別或使用手動連接。') })
    return () => { active = false }
  }, [])
  const discover = async () => {
    if (busy.current) return
    if (!window.caseboard) { setFolderHint('瀏覽器預覽無法查找本機目錄，請粘貼帳號路徑；讀取資料庫請使用桌面版。'); return }
    begin('discover')
    try { const result = await window.caseboard.discover(); if (mounted.current) { setDiscovery(result); setFolderHint(result.accounts.length ? '選擇一個帳號目錄，或手動指定其他目錄。' : '沒有在常見位置發現帳號，請選擇文件夾或粘貼路徑。') } }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { finish() }
  }
  const chooseFolder = async () => {
    if (busy.current) return
    if (!window.caseboard) { setFolderHint('瀏覽器預覽無法取得文件夾路徑，請在下方粘貼完整帳號路徑。'); return }
    begin('folder')
    try {
      const result = await window.caseboard.chooseFolder()
      if (mounted.current) {
        if (result.path) { invalidateConfiguration(); setAccountPath(result.path); setFolderHint('已選擇文件夾，請核對帳號信息。') }
        else setFolderHint('未取得文件夾路徑，可在下方直接粘貼完整帳號路徑。')
      }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { finish() }
  }
  const readCatalog = async (configuration: NativeOpenOptions) => {
    const bridge = window.caseboard
    if (!bridge) throw new Error('本機資料讀取服務尚未就緒，請從應用入口打開。')
    const data = await bridge.catalog(configuration)
    if (!mounted.current) { void bridge.closeConnection({ connectionId: data.connectionId }).catch(() => {}); return }
    liveConnection.current = data.connectionId
    setCatalog(data); setSelected(data.sessions.map(session => session.id)); setSearch('')
  }
  const autoFill = async (selectedAccountPath?: string) => {
    if (busy.current) return
    if (!window.caseboard) { setError('本機自動識別需要應用的本地讀取服務，請從項目啟動入口打開。'); return }
    invalidate(); setAutoResult(null); if (selectedAccountPath) setAccountPath(selectedAccountPath); begin('auto'); reading.current = true
    setProgress({ sessionsDone: 0, sessionsTotal: 0, messages: 0, sessionName: '正在識別本機微信與帳號…' })
    try {
      const result = await window.caseboard.autoSetup(selectedAccountPath ? { accountPath: selectedAccountPath } : {})
      if (!mounted.current) return
      setAutoResult(result)
      if (result.accounts.length) setDiscovery(previous => ({ searched: previous?.searched || [], platform: previous?.platform || navigator.platform, accounts: result.accounts }))
      if ((result.status === 'ready' || result.status === 'partial') && result.configuration) {
        const configuration = result.configuration
        setAccountPath(configuration.accountPath); setOwnerId(configuration.ownerId); setOwnerName(configuration.ownerName || '我')
        setKey(configuration.key || ''); setKeyMap(Object.keys(configuration.keys || {}).length ? JSON.stringify(configuration.keys, null, 2) : '')
        setImageKey(configuration.imageKey || ''); setXorKey(configuration.xorKey === undefined ? '' : String(configuration.xorKey))
        setFolderHint('已自動填入本次連接信息。密鑰使用掩碼顯示，不會保存到檔案。')
        setPhase('catalog')
        setProgress(value => ({ ...value, sessionName: '密鑰已驗證，正在創建快照並讀取聯絡人…' }))
        // Use this explicit configuration immediately, not asynchronous React state.
        try { await readCatalog(configuration) }
        catch (error) {
          if (mounted.current) setError(error instanceof Error ? error.message : String(error))
        }
      } else if (result.status === 'select-account') setFolderHint('請選擇一個帳號；選擇後將自動識別並填充該帳號的信息。')
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { reading.current = false; finish() }
  }
  const connect = async () => {
    if (busy.current) return
    setError('')
    if (!accountPath.trim()) { setError('請選擇或粘貼微信帳號目錄。'); return }
    if (!ownerId.trim()) { setError('請填寫當前帳號的微信 wxid，用於識別你發送的消息。'); return }
    if (key.trim() && !/^[a-f\d]{64}$/i.test(key.trim())) { setError('資料庫密鑰須為 64 位十六進制字符；明文資料庫請留空。'); return }
    let keys: Record<string, string> | undefined
    if (keyMap.trim()) {
      try {
        const parsed: unknown = JSON.parse(keyMap)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
        const entries = Object.entries(parsed)
        if (!entries.length || entries.some(([path, value]) => !path.trim() || typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value.trim()))) throw new Error()
        keys = Object.fromEntries(entries.map(([path, value]) => [path.trim(), (value as string).trim()]))
      } catch { setError('每庫密鑰映射須為 JSON 對象，鍵為庫路徑、庫文件名或 16 字節鹽的十六進制，值為 64 位十六進制密鑰。'); return }
    }
    if (xorKey.trim() && (!/^\d+$/.test(xorKey.trim()) || Number(xorKey) > 255)) { setError('圖片 XOR 值須為 0–255 的整數。'); return }
    if (!window.caseboard) { setError('本機資料庫讀取需要桌面版。瀏覽器預覽可繼續使用演示檔案或導入 JSON。'); return }
    invalidate(); begin('catalog'); reading.current = true
    setProgress({ sessionsDone: 0, sessionsTotal: 0, messages: 0, sessionName: '正在創建本機資料庫快照…' })
    try {
      await readCatalog({ ...(autoResult?.configuration?.clientId ? { clientId: autoResult.configuration.clientId } : {}), accountPath: accountPath.trim(), key: key.trim(), ownerId: ownerId.trim(), ownerName: ownerName.trim() || '我', ...(keys ? { keys } : {}), ...(imageKey.trim() ? { imageKey: imageKey.trim() } : {}), ...(xorKey.trim() ? { xorKey: Number(xorKey) } : {}) })
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { reading.current = false; finish() }
  }
  const load = async () => {
    if (busy.current || !window.caseboard || !catalog || !selected.length || !liveConnection.current) return
    const connectionId = liveConnection.current
    begin('load'); reading.current = true
    setProgress({ sessionsDone: 0, sessionsTotal: selected.length, messages: 0, sessionName: '' })
    try {
      const result = await window.caseboard.load({ connectionId, ownerName: ownerName.trim() || '我', sessionIds: selected, maxMessages: Number(maxMessages) })
      if (mounted.current) { reading.current = false; liveConnection.current = null; setKey(''); setKeyMap(''); setImageKey(''); setAutoResult(null); onLoaded(result, { connectionId }) }
    } catch (error) { if (mounted.current) { invalidate(); setError(error instanceof Error ? error.message : String(error)) } }
    finally { reading.current = false; finish() }
  }
  const visibleSessions = catalog?.sessions.filter(session => `${session.name} ${session.id}`.toLowerCase().includes(search.toLowerCase())) || []
  return <div className="connection-setup native-setup">
    <div className="connection-setup-heading"><b>本機微信資料</b><button className="text-btn" disabled={loading} onClick={onClose}>收起 ↑</button></div>
    <button className="pixel-btn gold native-auto-button" disabled={loading} onClick={() => void autoFill(accountPath || undefined)}>{loading && phase === 'auto' ? '正在自動識別與驗證…' : '⌕ 自動識別並填充'}</button>
    {!autoResult && <div className="connection-guide"><span>01</span><p>自動識別資料目錄，優先恢復本機已有連接。需要獲取新密鑰時，請保持微信已登錄。<small>請從你的桌面啟動，使用與微信相同的系統帳戶。原庫只讀。</small></p></div>}
    {loading && phase === 'auto' && <div className="scan-progress native-auto-progress" role="status"><span>{progress.sessionName || '正在識別本機微信帳號…'}</span><small>密鑰僅用於本次連接，不寫入檔案。</small><button className="text-btn" onClick={() => void window.caseboard?.cancelLoad().catch(() => {})}>停止自動識別</button></div>}
    {autoResult && <div className={`native-auto-state ${autoResult.status}`} role="status"><b>{autoResult.configuration && (autoResult.status === 'ready' || autoResult.status === 'partial') ? `已驗證填充 ${autoResult.verifiedDatabases} / ${autoResult.totalDatabases} 個資料庫` : autoResult.status === 'select-account' ? '請選擇要讀取的微信帳號' : autoResult.status === 'needs-wechat' ? '需要先登錄微信' : autoResult.status === 'permission' ? '系統權限限制了自動讀取' : '尚未完成自動識別'}</b><p>{autoResult.message}</p>{autoResult.warnings.map((warning, index) => <small key={index}>◇ {warning}</small>)}{!autoResult.configuration && autoResult.status !== 'select-account' && <button className="text-btn" onClick={() => setManualOpen(true)}>展開手動連接 ↗</button>}</div>}
    {folderHint && <p className="form-help native-folder-hint" role="status">{folderHint}</p>}
    {!catalog && !!discovery?.accounts.length && <div className="native-account-list" aria-label="選擇帳號並自動填充">{discovery.accounts.map(account => <button key={account.path} disabled={loading} className={accountPath === account.path ? 'selected' : ''} onClick={() => void autoFill(account.path)}><span><b>{account.name}</b><small>自動填充 ↗</small></span><code>{account.path}</code><small>微信 {account.version}</small></button>)}</div>}
    <details className="native-manual-settings" open={manualOpen} onToggle={event => setManualOpen(event.currentTarget.open)}>
      <summary>高級：手動連接與密鑰設定</summary>
      <p className="form-help">自動識別受限、帳號目錄自定義或已有密鑰時，可在這裡補充。自動填入的密鑰仍以掩碼顯示。</p>
      <div className="native-discovery-actions"><button className="pixel-btn" disabled={loading} onClick={() => void discover()}>{loading && phase === 'discover' ? '正在發現…' : '重新發現目錄'}</button><button className="pixel-btn" disabled={loading} onClick={() => void chooseFolder()}>{loading && phase === 'folder' ? '正在選擇…' : '▣ 選擇文件夾'}</button></div>
      {discovery && <details className="native-search-paths"><summary>已查找 {discovery.searched.length} 個位置 · {discovery.platform}</summary>{discovery.searched.map(path => <code key={path}>{path}</code>)}</details>}
      <div className="connection-fields">
        <label className="form-label">帳號目錄<input value={accountPath} onChange={event => { invalidateConfiguration(); setAccountPath(event.target.value) }} placeholder="粘貼微信帳號文件夾的完整路徑" disabled={loading} autoComplete="off" spellCheck={false} /></label>
        <label className="form-label">當前帳號的微信 wxid<input value={ownerId} onChange={event => { invalidateConfiguration(); setOwnerId(event.target.value) }} placeholder="wxid_…" disabled={loading} autoComplete="off" spellCheck={false} /></label>
        <label className="form-label">當前帳號的顯示名<input value={ownerName} onChange={event => { invalidateConfiguration(); setOwnerName(event.target.value) }} disabled={loading} /></label>
        <label className="form-label">資料庫密鑰<input type="password" value={key} onChange={event => { invalidateConfiguration(); setKey(event.target.value) }} placeholder="64 位十六進制；明文資料庫留空" disabled={loading} autoComplete="new-password" spellCheck={false} maxLength={64} /><small className="native-key-help">自動填入或手動補充，僅供本次讀取，不保存到檔案。</small></label>
        <details className="native-media-options"><summary>每個資料庫使用不同密鑰</summary><label className="form-label">每庫密鑰映射 JSON<textarea className="native-secret-map" value={keyMap} onChange={event => { invalidateConfiguration(); setKeyMap(event.target.value) }} placeholder="粘貼已有的每庫密鑰 JSON" disabled={loading} autoComplete="off" spellCheck={false} maxLength={2_000_000} /></label><p className="form-help">自動識別會填入已驗證的分庫密鑰。也可手動填寫：鍵為相對庫路徑、庫文件名或 16 字節鹽的十六進制，值為 64 位十六進制密鑰。內容遮擋，僅用於本次讀取。</p></details>
        <details className="native-media-options"><summary>可選：圖片解密參數</summary><label className="form-label">圖片 AES 密鑰<input type="password" value={imageKey} onChange={event => { invalidateConfiguration(); setImageKey(event.target.value) }} placeholder="已有的圖片 AES 密鑰" disabled={loading} autoComplete="new-password" spellCheck={false} /></label><label className="form-label">圖片 XOR 值<input inputMode="numeric" value={xorKey} onChange={event => { invalidateConfiguration(); setXorKey(event.target.value) }} placeholder="0–255" disabled={loading} /></label><p className="form-help">僅在需要解密聊天圖片時填寫；文字記錄無需圖片密鑰。</p></details>
      </div>
      {!catalog && !autoResult?.configuration && <button className="pixel-btn gold" onClick={() => void connect()} disabled={loading}>{loading && phase === 'catalog' ? '正在創建快照並讀取…' : '讀取聯絡人與會話 ↗'}</button>}
    </details>
    {!catalog && autoResult?.configuration && <button className="pixel-btn gold native-continue-button" onClick={() => void connect()} disabled={loading}>{loading && phase === 'catalog' ? '正在創建快照並讀取…' : '讀取聯絡人與會話 ↗'}</button>}
    {!catalog && autoResult?.configuration && /WAL|未写回|写回/i.test(error) && <p className="native-catalog-warning">已填入的密鑰仍保留在本次連接中。讀取器會在副本中合並已提交的 WAL 記錄；若複製時文件持續變化或校驗失敗，請暫停收發消息後點擊“讀取聯絡人與會話”重試。無需再次自動識別，請勿手動刪除 WAL 文件。</p>}
    {loading && phase === 'catalog' && <div className="scan-progress" role="status"><small>{progress.sessionName || '正在校驗本機資料庫…'}</small><button className="text-btn" onClick={() => void window.caseboard?.cancelLoad().catch(() => {})}>停止讀取</button></div>}
    {catalog && <>
      <div className="connection-stage"><span>02</span><div><b>選擇這次要檢索的聊天範圍</b><small>{catalog.people.length} 位聯絡人 · {catalog.sessions.length} 個會話 · {catalog.databaseCount} 個資料庫</small></div></div>
      {catalog.warnings.map((warning, index) => <p className="native-catalog-warning" key={index}>◇ {warning}</p>)}
      <div className="session-toolbar"><label><input type="checkbox" checked={selected.length === catalog.sessions.length && !!selected.length} onChange={event => setSelected(event.target.checked ? catalog.sessions.map(session => session.id) : [])} disabled={loading} /> 全部會話</label><button className="text-btn" onClick={() => setSelected(catalog.sessions.filter(session => session.kind === 'private').map(session => session.id))} disabled={loading}>僅私聊</button><button className="text-btn" onClick={() => setSelected(catalog.sessions.filter(session => session.kind === 'group').map(session => session.id))} disabled={loading}>僅群聊</button><input aria-label="搜索待掃描會話" placeholder="查找會話…" value={search} onChange={event => setSearch(event.target.value)} disabled={loading} /></div>
      <div className="session-list">{visibleSessions.slice(0, 80).map(session => <label key={session.id}><input type="checkbox" checked={selected.includes(session.id)} onChange={event => setSelected(current => event.target.checked ? [...current, session.id] : current.filter(id => id !== session.id))} disabled={loading} /><span>{session.kind === 'group' ? '▣' : '◇'}</span><b>{session.name}</b><small>{session.kind === 'group' ? '群聊' : session.kind === 'private' ? '私聊' : '其他'}</small></label>)}{visibleSessions.length > 80 && <p className="form-help">其餘 {visibleSessions.length - 80} 個會話可搜索定位；使用“全部會話”可一並選擇。</p>}{!visibleSessions.length && <p className="form-help">{catalog.sessions.length ? '沒有匹配的會話，請換個關鍵詞。' : '該目錄未讀取到會話，請核對帳號路徑與密鑰。'}</p>}</div>
      <div className="scan-options"><label>消息範圍 <select value={maxMessages} onChange={event => setMaxMessages(event.target.value)} disabled={loading}><option value="0">全部記錄（逐頁掃描）</option><option value="20000">最多 20,000 條</option><option value="5000">最多 5,000 條</option></select></label><span>已選擇 {selected.length} 個會話</span></div>
      {loading && phase === 'load' ? <div className="scan-progress" role="status"><div><span>正在讀取 {progress.sessionName || '所選會話'}…</span><b>{number(progress.messages)} 條</b></div><progress value={progress.sessionsDone} max={progress.sessionsTotal || 1} /><small>{progress.sessionsDone} / {progress.sessionsTotal} 個會話已處理</small><button className="text-btn" onClick={() => void window.caseboard?.cancelLoad().catch(() => {})}>停止並保留已讀取資料</button></div> : <button className="pixel-btn gold" onClick={() => void load()} disabled={loading || !selected.length}>開始載入並檢索全部所選記錄 ↗</button>}
    </>}
    {error && <p className="connection-error" role="alert">◇ {error}<small>{autoResult?.configuration ? '自動填入的信息仍保留，可按原因處理後重試讀取。' : '可檢查微信登錄狀態，或展開高級手動連接。明文資料庫無需密鑰。'}</small></p>}
    <p className="form-help">自動識別只在正常系統權限下嘗試；macOS 等系統可能限制進程讀取，受限時會顯示原因。密鑰不寫入本地檔案或導出的 JSON。讀取中斷、失敗或設定上限時會標為“部分資料”。</p>
  </div>
}
