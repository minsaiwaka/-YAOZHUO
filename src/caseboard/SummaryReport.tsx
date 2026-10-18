import { selectionDescription } from './ai-selection'
import type { DossierSummary } from './types'

const basis = { 'self-stated': '本人自述', repeated: '重復出現的線索', 'third-party': '他人描述', uncertain: '依據不足' }
const confidence = { high: '較充分', medium: '有限依據', low: '待核實' }
export function SummaryReport({ summary, onEvidence }: { summary: DossierSummary; onEvidence: (id: string) => void }) {
  const sections = [{ title: '記錄支持的主要信息', values: summary.findings }, { title: '可能的偏好與興趣', values: summary.preferences }, { title: '相關話題歸納', values: summary.topics }]
  return <section className="ai-summary-report"><div className="section-title"><h3>綜合資料綜述</h3><span>AI 草稿 · 待人工核對</span></div><p className="ai-scope">{summary.model} · {summary.processedMessages} / {summary.totalMessages} 條相關消息已處理 · {new Date(summary.generatedAt).toLocaleString('zh-CN')}</p><p className="ai-selection-description">{selectionDescription(summary.selection)}</p><p className="ai-overview">{summary.overview}</p>
    {sections.map(section => <div className="ai-report-section" key={section.title}><h4>{section.title}</h4>{section.values.length ? section.values.map((finding, index) => <article className="ai-finding" key={index}><p>{finding.statement}</p><div className="ai-finding-meta">{finding.basis && <span>{basis[finding.basis]}</span>}{finding.confidence && <span>依據程度：{confidence[finding.confidence]}</span>}</div><div className="evidence-references">{finding.evidenceIds.map((id, refIndex) => <button key={id} title={id} onClick={() => onEvidence(id)}>原文 {refIndex + 1} ↗</button>)}</div></article>) : <p className="muted">現有記錄不足以形成有依據的歸納。</p>}</div>)}
    <div className="ai-report-section"><h4>常用表達</h4>{summary.expressions.length ? summary.expressions.map(expression => <article className="ai-finding" key={expression.text}><p>“{expression.text}” <small>本人原文中出現 {expression.count} 次</small></p><div className="evidence-references">{expression.evidenceIds.map((id, index) => <button key={id} title={id} onClick={() => onEvidence(id)}>原文 {index + 1} ↗</button>)}</div></article>) : <p className="muted">未發現足夠重復的本人表達。</p>}</div>
    <div className="ai-report-section"><h4>尚不能確認的部分</h4><ul>{summary.uncertainties.map((value, index) => <li key={index}>{value}</li>)}</ul></div><div className="ai-report-section"><h4>範圍與限制</h4><ul>{summary.limitations.map((value, index) => <li key={index}>{value}</li>)}</ul><p className="muted">服務地址：{summary.endpoint}</p></div></section>
}
export { summaryHtml, summaryMarkdown } from './summary-format'
