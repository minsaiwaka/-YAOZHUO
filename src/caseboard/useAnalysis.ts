import { useEffect, useMemo, useState } from 'react'
import { AnalysisClient } from './analysis-client'
import type { AnalysisScope, AnalysisView, ExportContext } from './analysis-runtime'
import type { AliasMap, CaseDataset, ConversationScope, PersonInsights } from './types'

const empty: AnalysisView = { insights: { hits: [], conversationMentions: [], topics: [], relatedMessageIds: [], summary: '' }, graph: { nodes: [], edges: [] }, completeGraph: { nodes: [], edges: [] }, visibleMessageIds: [] }
const emptyAliases: AliasMap = {}

export function useAnalysis(dataset: CaseDataset, scope: AnalysisScope, preview: boolean, note: string, warnings: string[], conversationScope: ConversationScope = 'all') {
  const [session, setSession] = useState<{ client: AnalysisClient; dataset: CaseDataset; ready: Promise<AliasMap> } | null>(null)
  const [defaults, setDefaults] = useState<{ dataset: CaseDataset; values: AliasMap } | null>(null)
  const [result, setResult] = useState<{ dataset: CaseDataset; scope: AnalysisScope; value: AnalysisView } | null>(null)
  const [report, setReport] = useState<{ dataset: CaseDataset; scope: AnalysisScope; note: string; conversationScope: ConversationScope; value: { preview: string; characters: number } } | null>(null)
  const [error, setError] = useState('')
  const reportScope = useMemo<AnalysisScope>(() => ({ centerId: scope.centerId, customAliases: scope.customAliases, startDate: scope.startDate, endDate: scope.endDate, excludedIds: scope.excludedIds, query: '', kinds: [], pins: [], onlyPinned: false }), [scope.centerId, scope.customAliases, scope.startDate, scope.endDate, scope.excludedIds])
  useEffect(() => {
    let active = true
    let client: AnalysisClient
    try { client = new AnalysisClient(new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })) }
    catch { setError('背景分析執行緒未能啟動，請重新載入應用。'); return }
    const ready = client.request<AliasMap>({ type: 'dataset', dataset })
    setSession({ client, dataset, ready }); setError('')
    void ready.then(values => { if (active) setDefaults({ dataset, values }) }).catch(failure => { if (active) setError(String(failure.message)) })
    return () => { active = false; client.dispose() }
  }, [dataset])
  useEffect(() => {
    if (!session || session.dataset !== dataset) return
    let active = true
    void session.ready.then(() => active ? session.client.request<AnalysisView>({ type: 'analyze', scope }) : null).then(value => {
      if (active && value) { setResult({ dataset, scope, value }); setError('') }
    }).catch(failure => { if (active && failure.name !== 'AbortError') setError(String(failure.message)) })
    return () => { active = false }
  }, [session, dataset, scope])
  useEffect(() => {
    if (!preview || !session || session.dataset !== dataset) return
    let active = true
    const timer = setTimeout(() => {
      void session.ready.then(() => session.client.request<{ preview: string; characters: number }>({ type: 'report', scope: reportScope, note, warnings, conversationScope })).then(value => { if (active) setReport({ dataset, scope: reportScope, note, conversationScope, value }) }).catch(failure => { if (active && failure.name !== 'AbortError') setError(String(failure.message)) })
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [preview, session, dataset, reportScope, note, warnings, conversationScope])
  // Never label the previous person's evidence as the newly selected person.
  const value = result?.dataset === dataset && result.scope.centerId === scope.centerId && result.scope.customAliases === scope.customAliases && result.scope.startDate === scope.startDate && result.scope.endDate === scope.endDate && result.scope.excludedIds === scope.excludedIds ? result.value : empty
  const messageById = useMemo(() => new Map(dataset.messages.map(message => [message.id, message])), [dataset])
  const insights = useMemo<PersonInsights>(() => ({ ...value.insights, relatedMessages: value.insights.relatedMessageIds.flatMap(id => { const message = messageById.get(id); return message ? [message] : [] }) }), [value.insights, messageById])
  const visibleMessages = useMemo(() => value.visibleMessageIds.flatMap(id => { const message = messageById.get(id); return message ? [message] : [] }), [value.visibleMessageIds, messageById])
  const exportFile = async (context: ExportContext): Promise<string> => {
    if (!session || session.dataset !== dataset) throw new Error('背景資料尚未就緒，請稍後重試')
    await session.ready
    return session.client.request<string>({ type: 'export', scope, context })
  }
  const importFile = async (file: File): Promise<{ dataset: CaseDataset; meta: any }> => {
    if (!session) throw new Error('背景工具尚未就緒，請稍後重試')
    return session.client.request({ type: 'import', file })
  }
  const currentReport = report?.dataset === dataset && report.scope === reportScope && report.note === note && report.conversationScope === conversationScope ? report.value : null
  return { aliases: defaults?.dataset === dataset ? defaults.values : emptyAliases, insights, graph: value.graph, completeGraph: value.completeGraph, statistics: value.statistics, visibleMessages, messageById, busy: !result || result.dataset !== dataset || result.scope !== scope, error, report: currentReport, exportFile, importFile }
}
