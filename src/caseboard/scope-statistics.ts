import { messageTopics } from './analysis'
import type { AliasMap, CaseDataset, ConversationScope, Evidence, MessageKind, PersonInsights, ScopeStatistics, StatisticsCollection } from './types'

export const scopeLabels: Record<ConversationScope, string> = { all: '全部相關記錄', private: '私聊相關記錄', group: '群聊相關記錄' }
export const kindLabels: Record<MessageKind, string> = { text: '文字', image: '圖片', emoji: '表情', video: '影片', voice: '語音', file: '檔案', other: '其他' }
export function groupSessions(dataset: CaseDataset): Set<string> { return new Set(dataset.people.filter(person => person.kind === 'group').map(person => person.id)) }
export function inConversationScope(message: Evidence, scope: ConversationScope, groups: Set<string>): boolean {
  const group = groups.has(message.sessionId) || message.sessionId.endsWith('@chatroom')
  return scope === 'all' || (scope === 'group' ? group : !group)
}

/** Counts the same related evidence in three disjoint conversation scopes.
 * Context is selected once before partitioning, so private + group = all. */
export function collectStatistics(dataset: CaseDataset, centerId: string, insights: PersonInsights, aliases: AliasMap): StatisticsCollection {
  const groups = groupSessions(dataset)
  const hits = new Map(insights.hits.map(hit => [hit.evidenceId, hit]))
  const build = (scope: ConversationScope): ScopeStatistics => {
    const messages = insights.relatedMessages.filter(message => inConversationScope(message, scope, groups))
    const conversations = new Map<string, ScopeStatistics['conversations'][number]>()
    const kinds = new Map<MessageKind, number>(), days = new Set<string>(), hours = Array<number>(24).fill(0)
    let centerSent = 0, ownerSent = 0, mentions = 0, ambiguous = 0, first = Infinity, last = -Infinity
    for (const message of messages) {
      // For a self-centered file, the owner's messages belong to centerSent only.
      const byCenter = message.senderId === centerId
      const byOwner = !byCenter && message.senderId === dataset.ownerId
      centerSent += Number(byCenter); ownerSent += Number(byOwner)
      const hit = hits.get(message.id)
      mentions += Number(!!hit); ambiguous += Number(!!hit?.ambiguous)
      first = Math.min(first, message.timestamp); last = Math.max(last, message.timestamp)
      const date = new Date(message.timestamp)
      hours[date.getHours()]++
      days.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`)
      kinds.set(message.kind, (kinds.get(message.kind) || 0) + 1)
      const row = conversations.get(message.sessionId) || { id: message.sessionId, name: message.sessionName, count: 0, centerSent: 0, ownerSent: 0 }
      row.count++; row.centerSent += Number(byCenter); row.ownerSent += Number(byOwner)
      conversations.set(message.sessionId, row)
    }
    return { scope, messages: messages.length, sessions: conversations.size, centerSent, ownerSent, otherSent: messages.length - centerSent - ownerSent, mentions, ambiguous, ...(messages.length ? { first, last } : {}), days: days.size, hours, kinds: [...kinds].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count), conversations: [...conversations.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh')), topics: scope === 'all' ? insights.topics : insights.scopedTopics?.[scope] ?? messageTopics(messages, aliases) }
  }
  return { all: build('all'), private: build('private'), group: build('group') }
}

export function scopedInsights(dataset: CaseDataset, insights: PersonInsights, scope: ConversationScope): PersonInsights {
  if (scope === 'all') return { ...insights }
  const groups = groupSessions(dataset)
  const relatedMessages = insights.relatedMessages.filter(message => inConversationScope(message, scope, groups))
  const ids = new Set(relatedMessages.map(message => message.id))
  return { ...insights, relatedMessages, hits: insights.hits.filter(hit => ids.has(hit.evidenceId)), conversationMentions: insights.conversationMentions.filter(row => scope === 'group' ? groups.has(row.sessionId) || row.sessionId.endsWith('@chatroom') : !groups.has(row.sessionId) && !row.sessionId.endsWith('@chatroom')) }
}

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
const markdownText = (text: string) => text.replace(/[\r\n]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|\-])/g, '\\$1')
export function statisticsMarkdown(values: StatisticsCollection, selected: ConversationScope = 'all'): string {
  return '\n\n## 互動內容統計\n\n統計限於日期與人工排除後的相關記錄，含直接對話、本人發言、提及及相鄰上下文；私聊包括其他私聊中的提及。私聊與群聊互斥，相加等於全部。時段按本機時區；頻次不代表親密程度。\n' + (selected === 'all' ? ['all', 'private', 'group'] as const : [selected]).map(scope => {
    const value = values[scope]
    return `\n### ${scopeLabels[scope]}\n\n消息 ${value.messages} 條；會話 ${value.sessions} 個；有記錄 ${value.days} 天。中心人物發送 ${value.centerSent}，本機帳號發送 ${value.ownerSent}，其他人發送 ${value.otherSent}。稱呼命中 ${value.mentions}，歧義 ${value.ambiguous}。\n\n類型：${value.kinds.map(row => `${kindLabels[row.kind]} ${row.count}`).join('、') || '無'}。\n\n時段（0–23 時）：${value.hours.join(' / ')}。\n\n高頻話題：${value.topics.map(row => `${markdownText(row.label)}（${row.count}）`).join('、') || '無'}。\n\n| 會話 | 消息 | 中心人物 | 本機帳號 |\n| --- | ---: | ---: | ---: |\n${value.conversations.map(row => `| ${markdownText(row.name)} | ${row.count} | ${row.centerSent} | ${row.ownerSent} |`).join('\n')}\n`
  }).join('')
}
export function statisticsHtml(values: StatisticsCollection, selected: ConversationScope = 'all'): string {
  return `<section><h2>互動內容統計</h2><p>僅統計日期及人工排除後的相關記錄，含相鄰上下文。私聊與群聊互斥；時段按本機時區。頻次不代表親密程度。</p>${(selected === 'all' ? ['all', 'private', 'group'] as const : [selected]).map(scope => {
    const value = values[scope]
    return `<h3>${scopeLabels[scope]}</h3><p>${value.messages} 條消息 · ${value.sessions} 個會話 · ${value.days} 個活躍日</p><p>中心人物 ${value.centerSent} · 本機帳號 ${value.ownerSent} · 其他人 ${value.otherSent} · 稱呼命中 ${value.mentions}（歧義 ${value.ambiguous}）</p><p>類型：${value.kinds.map(row => `${kindLabels[row.kind]} ${row.count}`).join('、') || '無'}</p><p>時段（0–23 時）：${value.hours.join(' / ')}</p><p>高頻話題：${value.topics.map(row => `${escape(row.label)}（${row.count}）`).join('、') || '無'}</p><table><thead><tr><th>會話</th><th>消息</th><th>中心人物</th><th>本機帳號</th></tr></thead><tbody>${value.conversations.map(row => `<tr><td>${escape(row.name)}</td><td>${row.count}</td><td>${row.centerSent}</td><td>${row.ownerSent}</td></tr>`).join('')}</tbody></table>`
  }).join('')}</section>`
}
