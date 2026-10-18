import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { readSetting, storeSetting } from './storage'
import Modal from './Modal'
import { PagedList } from './WorkbenchPanels'
import { buildSummaryRequest, conversationIndex, selectSummaryMessages, selectionLabels, summarySelection, type SelectionMode } from './ai-selection'
import type { AISummaryOptions, DossierSummary } from './types'

export default function AISummarySetup({ context, revision, onGenerated, onBusyChange }: { context: Omit<AISummaryOptions, 'baseUrl' | 'apiKey' | 'model'>; revision: string; onGenerated: (summary: DossierSummary) => void; onBusyChange: (value: boolean) => void }) {
  const initial = readSetting('ai-service', { baseUrl: '', model: '' })
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl), [model, setModel] = useState(initial.model), [apiKey, setApiKey] = useState('')
  const [mode, setMode] = useState<SelectionMode>('all'), [sessionIds, setSessionIds] = useState(new Set<string>()), [messageIds, setMessageIds] = useState(new Set<string>())
  const [includeNotes, setIncludeNotes] = useState(false), [picker, setPicker] = useState(false), [query, setQuery] = useState(''), [sessionFilter, setSessionFilter] = useState('')
  const search = useDeferredValue(query.trim().toLowerCase())
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [progress, setProgress] = useState({ completed: 0, total: 1, phase: '' })
  const mounted = useRef(true), reading = useRef(false)
  const sessions = useMemo(() => conversationIndex(context.messages), [context.messages])
  const selected = useMemo(() => selectSummaryMessages(context.messages, mode, sessionIds, messageIds), [context.messages, mode, sessionIds, messageIds])
  const selection = useMemo(() => summarySelection(context.messages, selected, mode, includeNotes && !!context.manualNotes?.trim()), [context.messages, selected, mode, includeNotes, context.manualNotes])
  const consentToken = useMemo(() => ({}), [revision, selected, mode, includeNotes, baseUrl, model, apiKey])
  const [approvedToken, approve] = useState<object | null>(null)
  const consent = approvedToken === consentToken
  const matchingSessions = useMemo(() => sessions.filter(session => `${session.name} ${session.id}`.toLowerCase().includes(search)), [sessions, search])
  const matchingMessages = useMemo(() => mode === 'messages' && picker ? context.messages.filter(message => (!sessionFilter || message.sessionId === sessionFilter) && (!search || `${message.content} ${message.senderName} ${message.sessionName}`.toLowerCase().includes(search))) : [], [context.messages, sessionFilter, search, mode, picker])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (reading.current) void window.caseboard?.cancelSummary() } }, [])
  useEffect(() => window.caseboard?.onSummaryProgress(setProgress), [])
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  const toggle = (id: string, kind: 'session' | 'message') => {
    const setter = kind === 'session' ? setSessionIds : setMessageIds
    setter(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  const chooseMode = (next: SelectionMode) => { setMode(next); setQuery(''); setSessionFilter(''); if (next !== 'all') setPicker(true) }
  const generate = async () => {
    if (!window.caseboard) { setError('當前預覽尚未連接本地分析服務，請從項目啟動入口打開。'); return }
    if (!consent || !baseUrl.trim() || !model.trim() || !selected.length || busy) return
    const request = buildSummaryRequest(context, selected, selection, { baseUrl: baseUrl.trim(), apiKey, model: model.trim() })
    setBusy(true); reading.current = true; setError(''); setProgress({ completed: 0, total: 1, phase: '準備讀取所選聊天…' })
    storeSetting('ai-service', { baseUrl: baseUrl.trim(), model: model.trim() })
    try { const result = await window.caseboard.summarize(request); if (mounted.current) onGenerated({ ...result, selection }) }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { reading.current = false; if (mounted.current) { setBusy(false); approve(null) } }
  }
  const clearService = () => { setBaseUrl(''); setModel(''); setApiKey(''); approve(null); storeSetting('ai-service', { baseUrl: '', model: '' }) }
  return <details className="ai-settings" open><summary>◇ 外接 AI · 綜合資料綜述</summary><p className="step-help">先選聊天範圍，再確認服務與發送內容。重要表述保留原文引用。</p>
    <fieldset className="ai-range-options" disabled={busy}><legend>01 選擇聊天範圍</legend>{(['all', 'sessions', 'messages'] as const).map(value => <label key={value}><input type="radio" name="ai-selection-mode" value={value} checked={mode === value} onChange={() => chooseMode(value)} /><span>{selectionLabels[value]}</span></label>)}</fieldset>
    {mode !== 'all' && <button className="pixel-btn" disabled={busy} onClick={() => setPicker(true)}>編輯{mode === 'sessions' ? '會話' : '消息'}選擇 · {selected.length.toLocaleString()} 條 ↗</button>}
    <p className="form-help">「全部」指目前已載入、通過日期與排除篩選的相關聊天，未載入資料不會發送。選擇會話只包含其中的相關消息。</p>
    <label className="ai-consent"><input type="checkbox" checked={includeNotes} disabled={busy || !context.manualNotes?.trim()} onChange={event => setIncludeNotes(event.target.checked)} /><span>同時發送人工備註與便箋{!context.manualNotes?.trim() && '（暫無）'}</span></label>
    <label className="form-label">02 AI 服務地址<input aria-label="AI 服務地址" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://服務地址/v1" disabled={busy} /></label>
    <label className="form-label">模型名稱<input aria-label="AI 模型名稱" value={model} onChange={event => setModel(event.target.value)} disabled={busy} /></label>
    <label className="form-label">API Key<input aria-label="AI API Key" type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} disabled={busy} /></label>
    <div className="ai-send-scope" aria-live="polite"><b>將發送 {selection.sessions.length} 個會話 · {selected.length.toLocaleString()} 條消息</b><small>可選範圍：{sessions.length} 個會話 / {context.messages.length.toLocaleString()} 條。{selection.includeManualNotes ? '包含人工備註。' : '不含人工備註。'}長記錄分批處理，服務可能按調用量計費。</small><span>{baseUrl || '請先填寫服務地址'}</span></div>
    <label className="ai-consent"><input type="checkbox" checked={consent} disabled={busy || !selected.length} onChange={event => approve(event.target.checked ? consentToken : null)} /><span>03 我確認將以上所選原文{selection.includeManualNotes ? '及人工備註' : ''}發送至填寫的服務。</span></label>
    {busy ? <div className="scan-progress" role="status"><span>{progress.phase || '正在生成資料綜述…'}</span><progress value={progress.completed} max={progress.total || 1} /><small>{progress.completed} / {progress.total} 批次 · 本次 {selected.length.toLocaleString()} 條</small><button className="pixel-btn" onClick={() => void window.caseboard?.cancelSummary()}>停止生成</button></div> : <button className="pixel-btn gold" disabled={!consent || !baseUrl.trim() || !model.trim() || !selected.length} onClick={() => void generate()}>發送所選聊天並生成 ↗</button>}
    <button className="text-btn" disabled={busy} onClick={clearService}>清除服務配置</button>{error && <p className="connection-error" role="alert">◇ {error}</p>}<p className="form-help">Key 不寫入資料包。支持 HTTPS 兼容接口，以及本機 HTTP 模型服務。未填寫服務時仍可導出本地統計卷宗。</p>
    {picker && !busy && <Modal title={mode === 'sessions' ? '選擇參與總結的會話' : '選擇參與總結的消息'} subtitle="01 / CHAT SELECTION" wide onClose={() => setPicker(false)}><div className="modal-body ai-selection-dialog"><p>已選 <b>{selection.sessions.length} 個會話 / {selected.length.toLocaleString()} 條消息</b>。跨頁保留選擇，未勾選的原文不會發送。</p><label className="form-label">搜索{mode === 'sessions' ? '會話' : '消息'}<input aria-label="搜索 AI 聊天範圍" value={query} onChange={event => setQuery(event.target.value)} placeholder={mode === 'sessions' ? '會話名稱或標識…' : '原文、發送人或會話…'} /></label>{mode === 'messages' && <label className="form-label">限定會話<select aria-label="按會話篩選消息" value={sessionFilter} onChange={event => setSessionFilter(event.target.value)}><option value="">全部會話</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.name} · {session.count} 條</option>)}</select></label>}
      <div className="selection-actions"><button className="pixel-btn small" onClick={() => mode === 'sessions' ? setSessionIds(current => new Set([...current, ...matchingSessions.map(session => session.id)])) : setMessageIds(current => new Set([...current, ...matchingMessages.map(message => message.id)]))}>全選當前搜索結果</button><button className="text-btn" onClick={() => mode === 'sessions' ? setSessionIds(new Set()) : setMessageIds(new Set())}>清空全部選擇</button></div>
      {mode === 'sessions' ? <PagedList key={`sessions:${search}`} items={matchingSessions} size={15} label="可選會話">{session => <label className="selection-row" key={session.id}><input type="checkbox" checked={sessionIds.has(session.id)} onChange={() => toggle(session.id, 'session')} /><span><b>{session.name}</b><small>{session.id}</small></span><strong>{session.count} 條</strong></label>}</PagedList> : <PagedList key={`messages:${search}:${sessionFilter}`} items={matchingMessages} size={15} label="可選消息">{message => <label className="selection-row" key={message.id}><input type="checkbox" checked={messageIds.has(message.id)} onChange={() => toggle(message.id, 'message')} /><span><b>{message.sessionName} · {message.senderName}</b><small>{new Date(message.timestamp).toLocaleString('zh-CN')} · {message.id}</small><p>{message.content.slice(0, 400)}{message.content.length > 400 ? '…' : ''}</p></span></label>}</PagedList>}
      <div className="selection-confirm"><span>{selected.length ? `已選 ${selected.length.toLocaleString()} 條` : '請至少選擇一條消息'}</span><button className="pixel-btn gold" onClick={() => setPicker(false)}>完成選擇</button></div></div></Modal>}
  </details>
}
