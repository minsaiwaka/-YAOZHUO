import { pinyin } from 'pinyin-pro'
import type { AliasMap, BoardFilters, BoardGraph, CaseDataset, Evidence, MentionHit, Person, PersonInsights, Relation, RelationKind, Topic } from './types'

const normalize = (value: string) => value.trim().toLocaleLowerCase()
const unique = <T,>(values: T[]) => [...new Set(values)]
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const EMPTY_ALIASES: AliasMap = Object.freeze({})
const defaultAliasCache = new Map<string, readonly string[]>()
const compareChinese = new Intl.Collator('zh').compare

function remember<K, V>(cache: Map<K, V>, key: K, value: V, maximum: number): V {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > maximum) cache.delete(cache.keys().next().value!)
  return value
}

/** Suggestions are editable: initials are candidate identifiers, never identity proof. */
export function defaultAliases(person: Person): string[] {
  const cacheKey = JSON.stringify([person.name, person.alias, person.kind])
  const cached = defaultAliasCache.get(cacheKey)
  if (cached) return [...cached]
  const values = [person.name, person.alias || '']
  if (person.kind !== 'group' && /\p{Script=Han}/u.test(person.name)) {
    values.push(pinyin(person.name, { pattern: 'first', toneType: 'none', type: 'array' }).join('').toLowerCase())
  }
  const result = unique(values.map(value => value.trim()).filter(value => value.length >= 2))
  remember(defaultAliasCache, cacheKey, result, 4096)
  return [...result]
}

function aliasIndex(dataset: CaseDataset, aliases: AliasMap) {
  const byPerson = new Map(dataset.people.map(person => {
    const custom = Object.prototype.hasOwnProperty.call(aliases, person.id) ? aliases[person.id] : undefined
    return [person.id, unique([...(custom ?? defaultAliases(person))].map(value => value.trim()).filter(value => value.length > 0))] as const
  }))
  const owners = new Map<string, Set<string>>()
  for (const [id, values] of byPerson) for (const value of values) {
    const key = normalize(value)
    if (!owners.has(key)) owners.set(key, new Set())
    owners.get(key)!.add(id)
  }
  return { byPerson, owners }
}

function aliasExpression(alias: string, flags = 'iu'): RegExp {
  const escaped = escapeRegExp(alias)
  // ASCII identifiers must be complete tokens: lzx must not match lzx123 / xlzx.
  const pattern = /^[\x00-\x7F]+$/.test(alias) && /[a-z0-9]/i.test(alias)
    ? `(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])` : escaped
  return new RegExp(pattern, flags)
}

function findMentions(dataset: CaseDataset, centerId: string, { byPerson, owners }: ReturnType<typeof aliasIndex>): MentionHit[] {
  const candidates = (byPerson.get(centerId) ?? []).slice().sort((a, b) => {
    const ambiguity = (owners.get(normalize(a))!.size > 1 ? 1 : 0) - (owners.get(normalize(b))!.size > 1 ? 1 : 0)
    return ambiguity || b.length - a.length
  })
  const expressions = candidates.map(alias => ({ alias, expression: aliasExpression(alias) }))
  const hits: MentionHit[] = []
  for (const message of dataset.messages) {
    if (message.mentionedIds?.includes(centerId)) {
      hits.push({ evidenceId: message.id, personId: centerId, matchedAlias: '@联系人标识', ambiguous: false })
      continue
    }
    const alias = expressions.find(item => item.expression.test(message.content))?.alias
    if (alias) hits.push({ evidenceId: message.id, personId: centerId, matchedAlias: alias, ambiguous: (owners.get(normalize(alias))?.size ?? 0) > 1 })
  }
  return hits
}

const STOP_WORDS = new Set(('我们 你们 他们 她们 自己 这个 那个 一个 什么 怎么 今天 明天 昨天 现在 时候 可以 还有 然后 就是 觉得 已经 真的 一起 不是 没有 因为 所以 但是 如果 知道 看看 确实 这样 那样 还是 一下 一点 有点 这次 下次 好的 收到 谢谢 哈哈 哈哈哈 嗯嗯 对的 不用 好像 应该 需要 时候 事情 可能 比较 一直 终于 记得 大家 时间 地方 以后 之前 之后 那边 这边 里面 外面 所有 一个 两个 一张 一杯 这些 那些 说了 告诉 也是 不是 没事 到了 先去 下午 上午 晚上 中午 早上 已读 图片 视频 语音 文件 text image video file quote').split(/\s+/))

// Reuse ICU's dictionary and collation tables across people and graph filters.
type WordSegment = { segment: string; index: number; isWordLike?: boolean }
const Segmenter = (Intl as unknown as { Segmenter: new (locale: string, options: { granularity: 'word' }) => { segment(text: string): Iterable<WordSegment> } }).Segmenter
const segmenter = new Segmenter('zh-CN', { granularity: 'word' })

interface TopicTokenizer {
  words(content: string): readonly string[]
}

function createTopicTokenizer(excludedAliases: string[]): TopicTokenizer {
  const excluded = new Set(excludedAliases.map(normalize))
  const namePatterns = unique(excludedAliases).sort((a, b) => b.length - a.length).map(alias => aliasExpression(alias).source)
  const nameExpression = namePatterns.length ? new RegExp(namePatterns.join('|'), 'giu') : undefined
  const cache = new Map<string, readonly string[]>()
  const allowed = (value: string) => value.length >= 2 && value.length <= 12 && !STOP_WORDS.has(value) && !excluded.has(normalize(value)) && !/^\d+$/.test(value)
  return { words(content) {
    const cached = cache.get(content)
    if (cached) return cached
    // Remove complete names before segmentation, otherwise the Chinese word
    // segmenter can turn 林知夏 into the misleading topic “林知”.
    const topicContent = nameExpression ? content.replace(nameExpression, ' ') : content
    const segments = segmenter.segment(topicContent)[Symbol.iterator]()
    const words = new Set<string>()
    let current = segments.next()
    let following = segments.next()
    while (!current.done) {
      const part = current.value
      const next = following.done ? undefined : following.value
      current = following
      following = segments.next()
      if (!part.isWordLike) continue
      const token = part.segment.toLowerCase()
      if (allowed(token)) words.add(token)
      // Contiguous Chinese pieces often form useful phrases such as “旧书店”.
      if (next?.isWordLike && /^[\p{Script=Han}]+$/u.test(part.segment + next.segment) && part.segment.length + next.segment.length <= 6 && !STOP_WORDS.has(part.segment) && !STOP_WORDS.has(next.segment)) {
        const phrase = part.segment + next.segment
        if (allowed(phrase)) words.add(phrase)
      }
    }
    return remember(cache, content, [...words], 2048)
  } }
}

function extractTopics(messages: Evidence[], tokenizer: TopicTokenizer): Topic[] {
  const scores = new Map<string, Set<string>>()
  for (const message of messages) {
    if (message.kind !== 'text') continue
    for (const word of tokenizer.words(message.content)) {
      if (!scores.has(word)) scores.set(word, new Set())
      scores.get(word)!.add(message.id)
    }
  }
  return rankTopics(scores, messages.length)
}

function rankTopics(scores: Map<string, Set<string>>, count: number): Topic[] {
  const candidates = [...scores].map(([label, ids]) => ({ label, count: ids.size, evidenceIds: [...ids] }))
    .filter(topic => topic.count >= (count >= 8 ? 2 : 1))
    .sort((a, b) => (b.count * Math.min(b.label.length, 4)) - (a.count * Math.min(a.label.length, 4)) || b.count - a.count || compareChinese(a.label, b.label))
  const result: Topic[] = []
  for (const candidate of candidates) {
    if (result.some(topic => topic.label.includes(candidate.label) || candidate.label.includes(topic.label))) continue
    result.push(candidate)
    if (result.length === 8) break
  }
  return result.sort((a, b) => b.count - a.count)
}

function extractTopicScopes(messages: Evidence[], tokenizer: TopicTokenizer, people: Map<string, Person>) {
  const all = new Map<string, Set<string>>(), privateScores = new Map<string, Set<string>>(), groupScores = new Map<string, Set<string>>()
  let privateCount = 0, groupCount = 0
  for (const message of messages) {
    const group = people.get(message.sessionId)?.kind === 'group' || message.sessionId.endsWith('@chatroom')
    if (group) groupCount++; else privateCount++
    if (message.kind !== 'text') continue
    for (const word of tokenizer.words(message.content)) for (const scores of [all, group ? groupScores : privateScores]) {
      let ids = scores.get(word)
      if (!ids) scores.set(word, ids = new Set())
      ids.add(message.id)
    }
  }
  return { all: rankTopics(all, messages.length), private: rankTopics(privateScores, privateCount), group: rankTopics(groupScores, groupCount) }
}

interface MessageIndex {
  dataset: CaseDataset
  people: Map<string, Person>
  messageById: Map<string, Evidence>
  sessions: Map<string, Evidence[]>
  chronologicalSessions: Map<string, Evidence[]>
  senders: Map<string, Evidence[]>
  positions: Map<string, number>
  order: Map<string, number>
  originals: Map<string, Map<string, Evidence | null>>
  groupsByPerson: Map<string, string[]>
  membersByGroup: Map<string, string[]>
  counts: Map<string, number>
}

export function messageTopics(messages: Evidence[], aliases: AliasMap): Topic[] {
  return extractTopics(messages, createTopicTokenizer(Object.values(aliases).flat()))
}

function append<T>(map: Map<string, T[]>, key: string, value: T) {
  const values = map.get(key)
  if (values) values.push(value)
  else map.set(key, [value])
}

function createMessageIndex(dataset: CaseDataset, parent?: MessageIndex): MessageIndex {
  const index: MessageIndex = {
    dataset,
    people: parent?.people ?? new Map(dataset.people.map(person => [person.id, person])),
    messageById: new Map(), sessions: new Map(), chronologicalSessions: new Map(), senders: new Map(), positions: new Map(), order: new Map(), originals: new Map(), counts: new Map(),
    groupsByPerson: parent?.groupsByPerson ?? new Map(), membersByGroup: parent?.membersByGroup ?? new Map(),
  }
  if (!parent) for (const member of dataset.memberships) {
    append(index.groupsByPerson, member.personId, member.groupId)
    append(index.membersByGroup, member.groupId, member.personId)
  }
  const unsortedSessions = new Set<string>()
  for (let offset = 0; offset < dataset.messages.length; offset++) {
    const message = dataset.messages[offset]
    index.messageById.set(message.id, message)
    index.order.set(message.id, offset)
    const session = index.sessions.get(message.sessionId)
    if (session?.length && session[session.length - 1].timestamp > message.timestamp) unsortedSessions.add(message.sessionId)
    append(index.sessions, message.sessionId, message)
    append(index.senders, message.senderId, message)
    index.counts.set(message.senderId, (index.counts.get(message.senderId) ?? 0) + 1)
    if (message.senderId !== message.sessionId) index.counts.set(message.sessionId, (index.counts.get(message.sessionId) ?? 0) + 1)
    if (message.originalId) {
      let originals = index.originals.get(message.sessionId)
      if (!originals) index.originals.set(message.sessionId, originals = new Map())
      originals.set(message.originalId, originals.has(message.originalId) ? null : message)
    }
  }
  for (const [id, messages] of index.sessions) {
    const chronological = unsortedSessions.has(id) ? [...messages].sort((a, b) => a.timestamp - b.timestamp) : messages
    index.chronologicalSessions.set(id, chronological)
    for (let position = 0; position < chronological.length; position++) index.positions.set(chronological[position].id, position)
  }
  return index
}

function relatedEvidence(index: MessageIndex, centerId: string, hits: MentionHit[]): Evidence[] {
  const anchorIds = new Set(hits.map(hit => hit.evidenceId))
  for (const message of index.sessions.get(centerId) ?? []) anchorIds.add(message.id)
  for (const message of index.senders.get(centerId) ?? []) anchorIds.add(message.id)
  const relatedIds = new Set(anchorIds)
  // Neighbours come only from the original anchors. Context must not expand
  // recursively to the rest of a conversation, even when timestamps are close.
  for (const id of anchorIds) {
    const message = index.messageById.get(id)!
    const session = index.chronologicalSessions.get(message.sessionId)!
    const position = index.positions.get(id)!
    for (const offset of [-1, 1]) {
      const neighbour = session[position + offset]
      if (neighbour && Math.abs(neighbour.timestamp - message.timestamp) <= 15 * 60 * 1000) relatedIds.add(neighbour.id)
    }
  }
  return [...relatedIds].map(id => index.messageById.get(id)!).sort((a, b) => a.timestamp - b.timestamp || index.order.get(a.id)! - index.order.get(b.id)!)
}

interface PreparedAliases {
  index: ReturnType<typeof aliasIndex>
  tokenizer: TopicTokenizer
  centers: Map<string, PreparedCenter>
}
interface PreparedCenter {
  hits: MentionHit[]
  relatedMessages: Evidence[]
  insights?: PersonInsights
  graphs: Map<string, BoardGraph>
}

function analyze(index: MessageIndex, centerId: string, prepared: PreparedCenter, aliases: PreparedAliases): PersonInsights {
  const { dataset, messageById } = index
  const person = dataset.people.find(item => item.id === centerId)
  if (!person) return { hits: [], conversationMentions: [], topics: [], relatedMessages: [], summary: '所选人物不在当前数据中。' }
  const { hits, relatedMessages } = prepared
  const conversationMap = new Map<string, PersonInsights['conversationMentions'][number]>()
  for (const hit of hits) {
    const message = messageById.get(hit.evidenceId)!
    const item = conversationMap.get(message.sessionId) ?? { sessionId: message.sessionId, name: message.sessionName, count: 0, selfCount: 0, evidenceIds: [] }
    item.count++
    if (message.senderId === dataset.ownerId) item.selfCount++
    item.evidenceIds.push(message.id)
    conversationMap.set(message.sessionId, item)
  }
  const topics = extractTopicScopes(relatedMessages, aliases.tokenizer, index.people)
  const ambiguous = hits.filter(hit => hit.ambiguous).length
  const conversations = [...conversationMap.values()].sort((a, b) => b.count - a.count || compareChinese(a.name, b.name))
  return {
    hits,
    conversationMentions: conversations,
    topics: topics.all,
    scopedTopics: { private: topics.private, group: topics.group },
    relatedMessages,
    summary: `在已载入的 ${dataset.messages.length} 条消息中，检出 ${hits.length} 条关于「${person.name}」的提及候选，分布于 ${conversations.length} 个会话${ambiguous ? `；其中 ${ambiguous} 条存在同名或缩写歧义，需人工核对` : ''}。话题按相关原文的出现消息数统计，不推断人物关系或性格。`,
  }
}

function graphForSelection(index: MessageIndex, centerId: string, filters: BoardFilters, hits: MentionHit[], relatedMessages: Evidence[]): BoardGraph {
  const { dataset, people, messageById, sessions: sessionMessages } = index
  const center = people.get(centerId)
  if (!center) return { nodes: [], edges: [] }
  const query = filters.query?.trim().toLowerCase() ?? ''
  const messages = dataset.messages
  const edges = new Map<string, Relation>()
  const edgeEvidence = new Map<string, Set<string>>()
  const add = (source: string, target: string, kind: RelationKind, label: string, evidenceIds: string[], strength = evidenceIds.length) => {
    if (source === target || !people.has(source) || !people.has(target) || (filters.kinds && !filters.kinds.includes(kind))) return
    const id = `${kind}:${source}:${target}`
    const old = edges.get(id)
    const mergedIds = old?.evidenceIds ?? []
    const seen = edgeEvidence.get(id) ?? new Set<string>()
    for (const evidenceId of evidenceIds) if (!seen.has(evidenceId)) { seen.add(evidenceId); mergedIds.push(evidenceId) }
    edgeEvidence.set(id, seen)
    edges.set(id, { id, source, target, kind, label: old?.label.includes('待核对') ? old.label : label, evidenceIds: mergedIds, strength: Math.max(old?.strength ?? 0, strength, mergedIds.length) })
  }
  const directMessages = sessionMessages.get(centerId) ?? []
  if (directMessages.length && center.kind !== 'group') add(centerId, dataset.ownerId, 'direct', '直接会话', directMessages.map(message => message.id))
  const groupIds = new Set(index.groupsByPerson.get(centerId) ?? [])
  for (const message of index.senders.get(centerId) ?? []) if (people.get(message.sessionId)?.kind === 'group') groupIds.add(message.sessionId)
  if (center.kind === 'group') groupIds.add(centerId)
  for (const groupId of groupIds) {
    const groupMessages = sessionMessages.get(groupId) ?? []
    // Date/search filters must not leave invisible unrelated membership-only branches.
    if ((query || filters.start !== undefined || filters.end !== undefined) && !groupMessages.length) continue
    if (centerId !== groupId) add(centerId, groupId, 'shared-group', '所在群聊', groupMessages.filter(message => message.senderId === centerId).map(message => message.id))
    const members = index.membersByGroup.get(groupId) ?? []
    const memberEvidence = new Map<string, string[]>()
    for (const message of groupMessages) {
      if (!memberEvidence.has(message.senderId)) memberEvidence.set(message.senderId, [])
      memberEvidence.get(message.senderId)!.push(message.id)
    }
    for (const memberId of members) if (memberId !== centerId) add(groupId, memberId, 'shared-group', '群成员', memberEvidence.get(memberId) ?? [])
  }
  for (const hit of hits) {
    const message = messageById.get(hit.evidenceId)!
    const target = message.sessionId === centerId ? dataset.ownerId : message.sessionId
    add(centerId, target, 'mention', hit.ambiguous ? '提及候选 · 待核对' : '会话中提及', [message.id], 1)
  }
  const relatedNodes = new Set([...edges.values()].flatMap(edge => [edge.source, edge.target]))
  // These are exclusively the owner's observed private sessions.
  for (const personId of relatedNodes) {
    if (personId === centerId || personId === dataset.ownerId || people.get(personId)?.kind !== 'person') continue
    const direct = sessionMessages.get(personId) ?? []
    if (direct.length) add(dataset.ownerId, personId, 'direct', '本地可见私聊', direct.map(message => message.id))
  }
  const relatedIds = new Set(relatedMessages.map(message => message.id))
  for (const message of messages) {
    const byEvidenceId = message.replyTo ? messageById.get(message.replyTo) : undefined
    const original = message.replyTo ? (byEvidenceId?.sessionId === message.sessionId ? byEvidenceId : index.originals.get(message.sessionId)?.get(message.replyTo)) : undefined
    if (original && (relatedIds.has(message.id) || relatedIds.has(original.id))) add(message.senderId, original.senderId, 'reply', '引用回复', [original.id, message.id], 2)
  }
  const allEdges = [...edges.values()]
  const weights = new Map<string, number>([[centerId, Number.MAX_SAFE_INTEGER]])
  for (const edge of allEdges) {
    weights.set(edge.source, (weights.get(edge.source) ?? 0) + edge.strength + 1)
    weights.set(edge.target, (weights.get(edge.target) ?? 0) + edge.strength + 1)
  }
  const retained = new Set([...weights].sort((a, b) => b[1] - a[1]).map(([id]) => id))
  retained.add(centerId)
  return {
    nodes: [...retained].map(id => ({ ...people.get(id)!, messageCount: index.counts.get(id) ?? 0 })),
    edges: allEdges.filter(edge => retained.has(edge.source) && retained.has(edge.target)),
  }
}

export interface AnalysisEngine {
  analyze(centerId: string, aliases?: AliasMap): PersonInsights
  graph(centerId: string, filters?: BoardFilters, aliases?: AliasMap): BoardGraph
}

/**
 * One engine owns one immutable archive revision. Its indexes stay inside the
 * analysis worker; moving the same data through postMessage for each keystroke
 * would otherwise cost more than the actual graph filtering.
 */
export function createAnalysisEngine(dataset: CaseDataset): AnalysisEngine {
  const index = createMessageIndex(dataset)
  const aliasStates = new Map<string, PreparedAliases>()
  const selections = new Map<string, MessageIndex>()
  const searchable = new Map<string, string>()
  const prepare = (centerId: string, aliases: AliasMap) => {
    // The signature also catches an edited custom alias array. Default pinyin
    // suggestions are cached separately and never recomputed on graph filters.
    const key = JSON.stringify(aliases)
    let state = aliasStates.get(key)
    if (!state) {
      const indexed = aliasIndex(dataset, aliases)
      const allAliases = dataset.people.filter(person => person.kind !== 'group').flatMap(person => indexed.byPerson.get(person.id) ?? [])
      state = remember(aliasStates, key, { index: indexed, tokenizer: createTopicTokenizer(allAliases), centers: new Map() }, 2)
    }
    let center = state.centers.get(centerId)
    if (!center) {
      const hits = index.people.has(centerId) ? findMentions(dataset, centerId, state.index) : []
      center = remember(state.centers, centerId, { hits, relatedMessages: relatedEvidence(index, centerId, hits), graphs: new Map() }, 3)
    }
    return { state, center }
  }
  return {
    analyze(centerId, aliases = EMPTY_ALIASES) {
      const { state, center } = prepare(centerId, aliases)
      return center.insights ??= analyze(index, centerId, center, state)
    },
    graph(centerId, filters = {}, aliases = EMPTY_ALIASES) {
      const { center } = prepare(centerId, aliases)
      const query = filters.query?.trim().toLowerCase() ?? ''
      const selectionKey = JSON.stringify([filters.start ?? null, filters.end ?? null, query])
      const graphKey = JSON.stringify([selectionKey, filters.kinds ?? null])
      const cached = center.graphs.get(graphKey)
      if (cached) return cached
      let selected = index
      if (query || filters.start !== undefined || filters.end !== undefined) {
        selected = selections.get(selectionKey)!
        if (!selected) {
          const messages = dataset.messages.filter(message => {
            if ((filters.start !== undefined && message.timestamp < filters.start) || (filters.end !== undefined && message.timestamp > filters.end)) return false
            if (!query) return true
            let text = searchable.get(message.id)
            if (text === undefined) {
              text = `${message.content} ${message.senderName} ${message.sessionName}`.toLowerCase()
              searchable.set(message.id, text)
            }
            return text.includes(query)
          })
          selected = remember(selections, selectionKey, createMessageIndex({ ...dataset, messages }, index), 2)
        }
      }
      // Reuse the complete hit list: query/date filters cannot change which
      // alias matched a message or make an ambiguous alias unambiguous.
      const hits = selected === index ? center.hits : center.hits.filter(hit => selected.messageById.has(hit.evidenceId))
      const related = selected === index ? center.relatedMessages : relatedEvidence(selected, centerId, hits)
      return remember(center.graphs, graphKey, graphForSelection(selected, centerId, filters, hits, related), 8)
    },
  }
}

// Compatibility for exports and existing callers. React treats archives as
// immutable; replacing an array or appending messages also starts a new index.
const engines = new WeakMap<CaseDataset, { engine: AnalysisEngine; people: Person[]; messages: Evidence[]; memberships: CaseDataset['memberships']; messageCount: number; peopleCount: number; membershipCount: number }>()
function engineFor(dataset: CaseDataset): AnalysisEngine {
  const old = engines.get(dataset)
  if (old && old.people === dataset.people && old.messages === dataset.messages && old.memberships === dataset.memberships && old.messageCount === dataset.messages.length && old.peopleCount === dataset.people.length && old.membershipCount === dataset.memberships.length) return old.engine
  const engine = createAnalysisEngine(dataset)
  engines.set(dataset, { engine, people: dataset.people, messages: dataset.messages, memberships: dataset.memberships, messageCount: dataset.messages.length, peopleCount: dataset.people.length, membershipCount: dataset.memberships.length })
  return engine
}

export function analyzePerson(dataset: CaseDataset, centerId: string, aliases: AliasMap = EMPTY_ALIASES): PersonInsights {
  return engineFor(dataset).analyze(centerId, aliases)
}

export function buildGraph(dataset: CaseDataset, centerId: string, filters: BoardFilters = {}, aliases: AliasMap = EMPTY_ALIASES): BoardGraph {
  return engineFor(dataset).graph(centerId, filters, aliases)
}
