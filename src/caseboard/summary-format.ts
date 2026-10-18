import { selectionDescription } from './ai-selection'
import type { DossierSummary } from './types'

const basis = { 'self-stated': '本人自述', repeated: '重復出現的線索', 'third-party': '他人描述', uncertain: '依據不足' }
const confidence = { high: '較充分', medium: '有限依據', low: '待核實' }
export function summaryMarkdown(summary: DossierSummary): string {
  const block = (title: string, values: DossierSummary['findings']) => `\n### ${title}\n\n${values.map(value => `- ${value.statement}\n  依據：${value.evidenceIds.join('、')}${value.basis ? `；${basis[value.basis]}` : ''}${value.confidence ? `；依據程度：${confidence[value.confidence]}` : ''}`).join('\n') || '記錄不足。'}\n`
  return `\n\n## AI 綜合資料綜述（待人工核對）\n\n生成於 ${new Date(summary.generatedAt).toISOString()}；模型 ${summary.model}；服務 ${summary.endpoint}。\n已處理 ${summary.processedMessages} / ${summary.totalMessages} 條所選消息。\n${selectionDescription(summary.selection)}\n\n${summary.overview}\n${block('記錄支持的主要信息', summary.findings)}${block('可能的偏好與興趣', summary.preferences)}${block('相關話題', summary.topics)}\n### 常用表達\n\n${summary.expressions.map(value => `- “${value.text}”：本人原文中 ${value.count} 次；依據 ${value.evidenceIds.join('、')}`).join('\n') || '重復記錄不足。'}\n\n### 尚不能確認\n\n${summary.uncertainties.map(value => `- ${value}`).join('\n')}\n\n### 範圍與限制\n\n${summary.limitations.map(value => `- ${value}`).join('\n')}\n`
}
export function summaryHtml(summary: DossierSummary): string {
  const e = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
  const block = (title: string, values: DossierSummary['findings']) => `<h3>${title}</h3>${values.map(value => `<article><p>${e(value.statement)}</p><small>${value.basis ? basis[value.basis] : ''} ${value.confidence ? confidence[value.confidence] : ''} · 依據：${value.evidenceIds.map(e).join('、')}</small></article>`).join('') || '<p>記錄不足。</p>'}`
  return `<section class="ai-report"><h2>AI 綜合資料綜述（待人工核對）</h2><p>模型 ${e(summary.model)} · 已處理 ${summary.processedMessages} / ${summary.totalMessages} 條相關消息 · ${new Date(summary.generatedAt).toISOString()}</p><p>${e(selectionDescription(summary.selection))}</p><p>${e(summary.overview)}</p>${block('記錄支持的主要信息', summary.findings)}${block('可能的偏好與興趣', summary.preferences)}${block('相關話題', summary.topics)}<h3>常用表達</h3>${summary.expressions.map(value => `<p>“${e(value.text)}” · 本人原文中出現 ${value.count} 次<br><small>依據：${value.evidenceIds.map(e).join('、')}</small></p>`).join('') || '<p>重復記錄不足。</p>'}<h3>尚不能確認</h3><ul>${summary.uncertainties.map(value => `<li>${e(value)}</li>`).join('')}</ul><h3>範圍與限制</h3><ul>${summary.limitations.map(value => `<li>${e(value)}</li>`).join('')}</ul><small>服務地址：${e(summary.endpoint)}</small></section>`
}
