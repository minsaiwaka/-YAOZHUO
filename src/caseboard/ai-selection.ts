import type { AISummaryOptions, DossierSummary, Evidence, SummarySelection } from './types'

export type SelectionMode = SummarySelection['mode']
export function conversationIndex(messages: readonly Evidence[]) {
  const sessions = new Map<string, { id: string; name: string; count: number }>()
  for (const message of messages) {
    const entry = sessions.get(message.sessionId)
    if (entry) entry.count++
    else sessions.set(message.sessionId, { id: message.sessionId, name: message.sessionName, count: 1 })
  }
  return [...sessions.values()]
}
export function selectSummaryMessages(messages: Evidence[], mode: SelectionMode, sessionIds: ReadonlySet<string>, messageIds: ReadonlySet<string>): Evidence[] {
  return mode === 'all' ? messages : messages.filter(message => mode === 'sessions' ? sessionIds.has(message.sessionId) : messageIds.has(message.id))
}
export function summarySelection(available: Evidence[], selected: Evidence[], mode: SelectionMode, includeManualNotes: boolean): SummarySelection {
  return { mode, availableMessages: available.length, availableSessions: conversationIndex(available).length, messageIds: selected.map(message => message.id), sessions: conversationIndex(selected), includeManualNotes }
}
export const selectionLabels: Record<SelectionMode, string> = { all: '全部相關聊天', sessions: '指定會話', messages: '指定消息' }
export function selectionDescription(selection?: SummarySelection): string {
  return selection ? `${selectionLabels[selection.mode]} · ${selection.sessions.length} / ${selection.availableSessions} 個會話，${selection.messageIds.length.toLocaleString()} / ${selection.availableMessages.toLocaleString()} 條相關消息；${selection.includeManualNotes ? '包含' : '未包含'}人工備註。` : '此舊版綜述未記錄具體選取範圍，不能據此認定已覆蓋全部聊天。'
}
/** The transport receives only selected originals. Scope metadata stays local. */
export function buildSummaryRequest(context: Omit<AISummaryOptions, 'baseUrl' | 'apiKey' | 'model'>, selected: Evidence[], scope: SummarySelection, service: Pick<AISummaryOptions, 'baseUrl' | 'apiKey' | 'model'>): AISummaryOptions {
  if (!selected.length) throw new Error('請至少選擇一條相關消息。')
  return { ...context, ...service, messages: selected, manualNotes: scope.includeManualNotes ? context.manualNotes : undefined, coverageDescription: `${context.coverageDescription}\n本次主動選取範圍：${selectionDescription(scope)}未選消息不參與歸納。`, warnings: [...context.warnings, ...(scope.mode !== 'all' ? ['本次為人工選取的部分聊天，不能代表全部相關記錄。'] : [])] }
}

/** Imports must retain the original selection; never recount a partial summary over the whole dataset. */
export function validateStoredSummary(value: unknown, messages: Evidence[], personId: string): DossierSummary | null {
  if (!value || typeof value !== 'object') return null
  const result = value as DossierSummary
  const byId = new Map(messages.map(message => [message.id, message]))
  if (typeof result.overview !== 'string' || typeof result.model !== 'string' || typeof result.endpoint !== 'string' || !Number.isFinite(result.generatedAt) || !Number.isSafeInteger(result.processedMessages) || !Number.isSafeInteger(result.totalMessages) || result.processedMessages < 0 || result.totalMessages < result.processedMessages) return null
  if (![result.findings, result.preferences, result.topics, result.expressions, result.uncertainties, result.limitations].every(Array.isArray) || ![...result.uncertainties, ...result.limitations].every(value => typeof value === 'string')) return null
  let selection: SummarySelection | undefined
  if (result.selection !== undefined) {
    const s = result.selection
    if (!s || !['all', 'sessions', 'messages'].includes(s.mode) || !Array.isArray(s.messageIds) || s.messageIds.some(id => typeof id !== 'string' || !byId.has(id)) || new Set(s.messageIds).size !== s.messageIds.length || !Number.isSafeInteger(s.availableMessages) || s.availableMessages < s.messageIds.length || s.availableMessages > messages.length || !Number.isSafeInteger(s.availableSessions) || s.availableSessions < 0 || typeof s.includeManualNotes !== 'boolean' || result.totalMessages !== s.messageIds.length || result.processedMessages !== s.messageIds.length) return null
    const sessions = conversationIndex(s.messageIds.map(id => byId.get(id)!))
    if (s.mode === 'all' && s.messageIds.length !== s.availableMessages) return null
    if (s.availableSessions < sessions.length || s.availableSessions > conversationIndex(messages).length) return null
    selection = { ...s, sessions }
  }
  const allowed = selection ? new Set(selection.messageIds) : new Set(byId.keys())
  const findings = (values: DossierSummary['findings']) => values.filter(item => item && typeof item.statement === 'string' && Array.isArray(item.evidenceIds)).map(item => ({ statement: item.statement.slice(0, 20000), evidenceIds: [...new Set(item.evidenceIds.filter(id => typeof id === 'string' && allowed.has(id)))], ...(['self-stated', 'repeated', 'third-party', 'uncertain'].includes(item.basis || '') ? { basis: item.basis } : {}), ...(['high', 'medium', 'low'].includes(item.confidence || '') ? { confidence: item.confidence } : {}) })).filter(item => item.evidenceIds.length).slice(0, 100)
  const chosen = selection ? selection.messageIds.map(id => byId.get(id)!) : null
  const expressions = result.expressions.filter(item => item && typeof item.text === 'string' && item.text.length >= 2 && Array.isArray(item.evidenceIds)).slice(0, 30).map(item => {
    const candidates = chosen || [...new Set(item.evidenceIds)].flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
    const actual = candidates.filter(message => message.senderId === personId && message.content.includes(item.text))
    return { text: item.text.slice(0, 2000), count: actual.length, evidenceIds: actual.map(message => message.id) }
  }).filter(item => item.count >= 2)
  return { ...result, selection, findings: findings(result.findings), preferences: findings(result.preferences), topics: findings(result.topics), expressions }
}
