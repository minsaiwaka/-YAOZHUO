export type PersonKind = 'self' | 'person' | 'group'
export type MessageKind = 'text' | 'image' | 'emoji' | 'video' | 'voice' | 'file' | 'other'
export type RelationKind = 'direct' | 'shared-group' | 'mention' | 'reply'
export type AliasMap = Record<string, string[]>

export interface Person {
  id: string
  name: string
  alias?: string
  kind: PersonKind
}

/** Local editorial annotations. These never replace a contact or a chat original. */
export interface DossierProfile {
  displayName: string
  avatarVariant?: number
  occupation: string
  location: string
  commonPhrases: string
  preferences: string
  description: string
  fields: { label: string; value: string }[]
  updatedAt: number
}
export interface SummarySelection {
  mode: 'all' | 'sessions' | 'messages'
  availableMessages: number
  availableSessions: number
  messageIds: string[]
  sessions: { id: string; name: string; count: number }[]
  includeManualNotes: boolean
}

export interface Evidence {
  id: string
  sessionId: string
  sessionName: string
  senderId: string
  senderName: string
  timestamp: number
  content: string
  kind: MessageKind
  originalId?: string
  replyTo?: string
  mentionedIds?: string[]
  mediaKey?: string
  mediaUrl?: string
  mediaFileName?: string
}

export interface Membership { personId: string; groupId: string }
export interface CaseDataset {
  schemaVersion: 1
  id: string
  title: string
  source: 'demo' | 'weflow' | 'import' | 'local'
  importedAt: number
  ownerId: string
  people: Person[]
  messages: Evidence[]
  memberships: Membership[]
  coverage: {
    description: string
    partial: boolean
    sessionCount: number
    messageCount: number
    warnings: string[]
  }
}

export interface Relation {
  id: string
  source: string
  target: string
  kind: RelationKind
  label: string
  evidenceIds: string[]
  strength: number
}
export interface BoardNode extends Person { messageCount: number }
export interface BoardGraph { nodes: BoardNode[]; edges: Relation[] }
export interface BoardFilters {
  query?: string
  start?: number
  end?: number
  kinds?: RelationKind[]
}
export interface CaseNotes { [personId: string]: string }
export interface BoardItem {
  id: string
  linkedToCenter?: boolean
  type: 'note' | 'image'
  title: string
  text?: string
  dataUrl?: string
  evidenceIds?: string[]
  x: number
  y: number
  width: number
  height: number
}
export interface BoardLayout { [nodeId: string]: { x: number; y: number } }
export interface BoardDocument { layout: BoardLayout; items: BoardItem[]; zoom?: number }
export type ConversationScope = 'all' | 'private' | 'group'
export interface ScopeStatistics {
  scope: ConversationScope
  messages: number
  sessions: number
  centerSent: number
  ownerSent: number
  otherSent: number
  mentions: number
  ambiguous: number
  first?: number
  last?: number
  days: number
  hours: number[]
  kinds: { kind: MessageKind; count: number }[]
  conversations: { id: string; name: string; count: number; centerSent: number; ownerSent: number }[]
  topics: Topic[]
}
export type StatisticsCollection = Record<ConversationScope, ScopeStatistics>
export interface MentionHit { evidenceId: string; personId: string; matchedAlias: string; ambiguous: boolean }
export interface Topic { label: string; count: number; evidenceIds: string[] }
export interface PersonInsights {
  scopedTopics?: { private: Topic[]; group: Topic[] }
  hits: MentionHit[]
  conversationMentions: { sessionId: string; name: string; count: number; selfCount: number; evidenceIds: string[] }[]
  topics: Topic[]
  relatedMessages: Evidence[]
  summary: string
}

export interface ConnectionOptions { connectionId: string }
export interface WeFlowSession { id: string; name: string; kind: 'private' | 'group' | 'other' }
export interface NativeAccount { path: string; name: string; version: '4.x' | '3.x' | 'unknown' }
export interface NativeDiscovery { accounts: NativeAccount[]; searched: string[]; platform: string }
export interface NativeOpenOptions { accountPath: string; key: string; keys?: Record<string, string>; ownerId: string; ownerName: string; imageKey?: string; xorKey?: number; clientId?: string }
export interface NativeAutoOptions { accountPath?: string }
export interface NativeAutoResult {
  status: 'ready' | 'partial' | 'select-account' | 'needs-wechat' | 'permission' | 'not-found'
  accounts: NativeAccount[]
  configuration?: NativeOpenOptions
  message: string
  warnings: string[]
  verifiedDatabases: number
  totalDatabases: number
}
export interface WeFlowCatalog { people: Person[]; sessions: WeFlowSession[] }
export interface NativeCatalog extends WeFlowCatalog { connectionId: string; ownerId: string; warnings: string[]; databaseCount: number }
export interface LoadOptions extends ConnectionOptions { sessionIds: string[]; maxMessages: number; ownerName: string }
export interface AISummaryOptions {
  baseUrl: string
  apiKey: string
  model: string
  centerName: string
  centerId: string
  ownerId: string
  aliases: string[]
  coverageDescription: string
  warnings: string[]
  messages: Evidence[]
  manualNotes?: string
}
export interface SummaryFinding { statement: string; evidenceIds: string[]; confidence?: 'high' | 'medium' | 'low'; basis?: 'self-stated' | 'repeated' | 'third-party' | 'uncertain' }
export interface DossierSummary {
  selection?: SummarySelection
  generatedAt: number
  model: string
  endpoint: string
  overview: string
  findings: SummaryFinding[]
  topics: SummaryFinding[]
  preferences: SummaryFinding[]
  expressions: { text: string; count: number; evidenceIds: string[] }[]
  uncertainties: string[]
  limitations: string[]
  processedMessages: number
  totalMessages: number
}
export interface CaseboardBridge {
  discover(): Promise<NativeDiscovery>
  autoSetup(options: NativeAutoOptions): Promise<NativeAutoResult>
  chooseFolder(): Promise<{ path?: string }>
  catalog(options: NativeOpenOptions): Promise<NativeCatalog>
  closeConnection(options: ConnectionOptions): Promise<void>
  load(options: LoadOptions): Promise<CaseDataset>
  cancelLoad(): Promise<void>
  onProgress(callback: (progress: { sessionsDone: number; sessionsTotal: number; messages: number; sessionName: string }) => void): () => void
  media(options: ConnectionOptions & { evidence: Evidence }): Promise<{ dataUrl: string }>
  summarize(options: AISummaryOptions): Promise<DossierSummary>
  cancelSummary(): Promise<void>
  onSummaryProgress(callback: (progress: { completed: number; total: number; phase: string }) => void): () => void
  saveFile(options: { name: string; content: string; extension: 'md' | 'json' | 'html' }): Promise<{ saved: boolean; path?: string }>
}

declare global {
  interface Window { caseboard?: CaseboardBridge }
}
