import { createAnalysisEngine, defaultAliases } from './analysis'
import { generateDossierHtml, generateDossierMarkdown, importDatasetValue } from './import-export'
import { summaryHtml, summaryMarkdown } from './summary-format'
import { emptyProfile, profileHtml, profileMarkdown } from './dossier-profile'
import { collectStatistics, groupSessions, inConversationScope, scopedInsights, scopeLabels, statisticsHtml, statisticsMarkdown } from './scope-statistics'
import type { AliasMap, BoardDocument, BoardGraph, CaseDataset, ConversationScope, DossierProfile, DossierSummary, PersonInsights, RelationKind, StatisticsCollection } from './types'

export interface AnalysisScope {
  centerId: string
  customAliases: AliasMap
  startDate: string
  endDate: string
  excludedIds: string[]
  query: string
  kinds: RelationKind[]
  onlyPinned: boolean
  pins: string[]
}
export interface AnalysisView {
  insights: Omit<PersonInsights, 'relatedMessages'> & { relatedMessageIds: string[] }
  graph: BoardGraph
  completeGraph: BoardGraph
  visibleMessageIds: string[]
  statistics?: StatisticsCollection
}
export interface ExportContext {
  profiles?: Record<string, DossierProfile>
  portrait?: string
  format: 'md' | 'html' | 'json'
  note: string
  personNote?: string
  warnings: string[]
  board: BoardDocument
  summary: DossierSummary | null
  fingerprint: string
  conversationScope?: ConversationScope
}
export type AnalysisAction =
  | { type: 'dataset'; dataset: CaseDataset }
  | { type: 'analyze'; scope: AnalysisScope }
  | { type: 'report'; scope: AnalysisScope; note: string; warnings: string[]; conversationScope?: ConversationScope }
  | { type: 'export'; scope: AnalysisScope; context: ExportContext }
  | { type: 'import'; file: File }

/** Dataset and indexes live in the worker. Requests carry only changed settings. */
export class AnalysisRuntime {
  private dataset: CaseDataset | null = null
  private defaults: AliasMap = {}
  private filtered: CaseDataset | null = null
  private filterKey = ''
  private engine: ReturnType<typeof createAnalysisEngine> | null = null
  private aliasKey = ''
  private aliases: AliasMap = {}
  private statisticsKey = ''
  private statistics: StatisticsCollection | null = null

  private prepare(scope: AnalysisScope) {
    if (!this.dataset) throw new Error('資料尚未載入背景分析')
    const key = JSON.stringify([scope.startDate, scope.endDate, scope.excludedIds])
    if (!this.engine || key !== this.filterKey) {
      const excluded = new Set(scope.excludedIds)
      const start = scope.startDate ? new Date(`${scope.startDate}T00:00:00`).getTime() : -Infinity
      const end = scope.endDate ? new Date(`${scope.endDate}T23:59:59.999`).getTime() : Infinity
      this.filtered = !excluded.size && !scope.startDate && !scope.endDate ? this.dataset : { ...this.dataset, messages: this.dataset.messages.filter(message => !excluded.has(message.id) && message.timestamp >= start && message.timestamp <= end) }
      this.engine = createAnalysisEngine(this.filtered)
      this.filterKey = key
      this.statistics = null
    }
    const aliasKey = JSON.stringify(scope.customAliases)
    if (aliasKey !== this.aliasKey) {
      this.aliases = { ...this.defaults, ...scope.customAliases }
      this.aliasKey = aliasKey
    }
    return { dataset: this.filtered!, engine: this.engine, aliases: this.aliases }
  }

  async handle(action: AnalysisAction): Promise<unknown> {
    if (action.type === 'import') {
      const text = await action.file.text()
      if (text.length > 60_000_000) throw new Error('文件超過 60 MB，請按會話或日期拆分後導入。')
      let parsed: any
      try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')) }
      catch { throw new Error('文件不是有效 JSON，請選擇聊天資料或線索板 JSON。') }
      return { dataset: importDatasetValue(parsed, action.file.name), meta: parsed?.caseboard }
    }
    if (action.type === 'dataset') {
      this.dataset = action.dataset
      this.defaults = Object.fromEntries(action.dataset.people.filter(person => person.kind !== 'group').map(person => [person.id, defaultAliases(person)]))
      this.filtered = null; this.engine = null; this.filterKey = ''; this.aliasKey = '\0'; this.aliases = {}; this.statistics = null
      return this.defaults
    }
    const { dataset, engine, aliases } = this.prepare(action.scope)
    const fullInsights = engine.analyze(action.scope.centerId, aliases)
    const statisticsKey = JSON.stringify([action.scope.centerId, this.aliasKey])
    if (!this.statistics || this.statisticsKey !== statisticsKey) {
      this.statistics = collectStatistics(dataset, action.scope.centerId, fullInsights, aliases)
      this.statisticsKey = statisticsKey
    }
    if (action.type === 'analyze') {
      const { relatedMessages, scopedTopics: _scopedTopics, ...insights } = fullInsights
      const search = action.scope.query.trim().toLowerCase()
      const pins = new Set(action.scope.pins)
      const visible = relatedMessages.filter(message => (!action.scope.onlyPinned || pins.has(message.id)) && (!search || `${message.content} ${message.senderName} ${message.sessionName}`.toLowerCase().includes(search)))
      // Preserve chronological ties, matching the previous stable sort.
      visible.sort((a, b) => b.timestamp - a.timestamp)
      const start = action.scope.startDate ? new Date(`${action.scope.startDate}T00:00:00`).getTime() : undefined
      const end = action.scope.endDate ? new Date(`${action.scope.endDate}T23:59:59.999`).getTime() : undefined
      return { insights: { ...insights, relatedMessageIds: relatedMessages.map(message => message.id) }, graph: engine.graph(action.scope.centerId, { query: action.scope.query, kinds: action.scope.kinds, start, end }, aliases), completeGraph: engine.graph(action.scope.centerId, { start, end }, aliases), visibleMessageIds: visible.map(message => message.id), statistics: this.statistics } satisfies AnalysisView
    }
    const note = action.type === 'report' ? action.note : action.context.note
    const warnings = action.type === 'report' ? action.warnings : action.context.warnings
    const conversationScope = (action.type === 'report' ? action.conversationScope : action.context.conversationScope) || 'all'
    const groups = groupSessions(dataset)
    const reportDataset = { ...dataset, title: `${dataset.title} · ${scopeLabels[conversationScope]}`, messages: dataset.messages.filter(message => inConversationScope(message, conversationScope, groups)), coverage: { ...dataset.coverage, description: `${dataset.coverage.description} 本報告選擇：${scopeLabels[conversationScope]}；相關原文與統計以此範圍為準。`, warnings } }
    const reportInsights = scopedInsights(dataset, fullInsights, conversationScope)
    reportInsights.topics = this.statistics[conversationScope].topics
    reportInsights.summary = `${scopeLabels[conversationScope]}：${reportInsights.relatedMessages.length} 條相關記錄，${reportInsights.hits.length} 條稱呼命中。統計僅基於已載入且通過當前日期與排除設定的資料。`
    const notes = { [action.scope.centerId]: note }
    if (action.type === 'report') {
      const content = generateDossierMarkdown(reportDataset, action.scope.centerId, aliases, notes, reportInsights).replace('\n## 原文证据与上下文', statisticsMarkdown(this.statistics, conversationScope) + '\n## 原文证据与上下文')
      return { preview: content.slice(0, 30000), characters: content.length }
    }
    const { context, scope } = action
    const person = dataset.people.find(person => person.id === scope.centerId)!
    const profile = context.profiles?.[scope.centerId] || emptyProfile()
    if (context.format === 'md') return profileMarkdown(profile, person) + generateDossierMarkdown(reportDataset, scope.centerId, aliases, notes, reportInsights).replace('\n## 原文证据与上下文', statisticsMarkdown(this.statistics, conversationScope) + '\n## 原文证据与上下文') + (conversationScope === 'all' && context.summary ? summaryMarkdown(context.summary) : '')
    if (context.format === 'html') return generateDossierHtml(reportDataset, scope.centerId, aliases, notes, reportInsights).replace('<h2>原文证据与上下文</h2>', statisticsHtml(this.statistics, conversationScope) + '<h2>原文证据与上下文</h2>').replace('<main>', `<main>${profileHtml(profile, person, context.portrait)}`).replace('</main>', `${conversationScope === 'all' && context.summary ? summaryHtml(context.summary) : ''}</main>`)
    return JSON.stringify({ ...this.dataset, caseboard: { profiles: context.profiles || {}, centerId: scope.centerId, aliases, notes: { [scope.centerId]: context.personNote ?? note }, excluded: scope.excludedIds, pins: scope.pins, board: context.board, filters: { startDate: scope.startDate, endDate: scope.endDate, kinds: scope.kinds }, summary: context.summary ? { fingerprint: context.fingerprint, value: context.summary } : null } }, null, 2)
  }
}
