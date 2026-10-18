import { characterDesigns } from './pixel-characters'
import type { DossierProfile, Person } from './types'

export function emptyProfile(): DossierProfile { return { displayName: '', occupation: '', location: '', commonPhrases: '', preferences: '', description: '', fields: [], updatedAt: 0 } }
export function validateProfile(value: unknown): DossierProfile {
  const p = value && typeof value === 'object' ? value as Partial<DossierProfile> : {}
  const text = (value: unknown, length: number) => typeof value === 'string' ? value.trim().slice(0, length) : ''
  return { displayName: text(p.displayName, 100), occupation: text(p.occupation, 200), location: text(p.location, 200), commonPhrases: text(p.commonPhrases, 4000), preferences: text(p.preferences, 4000), description: text(p.description, 10000), fields: Array.isArray(p.fields) ? p.fields.filter(field => field && typeof field.label === 'string' && typeof field.value === 'string').slice(0, 20).map(field => ({ label: text(field.label, 100), value: text(field.value, 2000) })).filter(field => field.label) : [], avatarVariant: Number.isInteger(p.avatarVariant) && p.avatarVariant! >= 0 && p.avatarVariant! < characterDesigns.length ? p.avatarVariant : undefined, updatedAt: typeof p.updatedAt === 'number' && Number.isFinite(p.updatedAt) && p.updatedAt >= 0 ? p.updatedAt : 0 }
}
export function profileRows(profile: DossierProfile) {
  return [['姓名（人工顯示名）', profile.displayName], ['職業 / 身份', profile.occupation], ['常出現的地點', profile.location], ['常用語', profile.commonPhrases], ['偏好 / 常點飲品', profile.preferences], ['人物說明', profile.description], ...profile.fields.map(field => [field.label, field.value])].filter(([, value]) => value)
}
export function profileMarkdown(profile: DossierProfile, person: Person): string {
  const escape = (value: string) => value.replace(/([\\`*_[\]<>#|])/g, '\\$1').replace(/\n/g, '\n  ')
  return `\n## 人物檔案卡\n\n姓名：${escape(profile.displayName || person.name)}；原始聯絡人：${escape(person.name)}；標識：${escape(person.id)}。\n\n像素照片：${profile.avatarVariant === undefined ? '自動分配' : String(profile.avatarVariant + 1).padStart(3, '0') + ' · ' + characterDesigns[profile.avatarVariant].name}。\n以下為人工整理資料，不是原始聊天或已核實結論。\n\n${profileRows(profile).map(([label, value]) => `- ${escape(label)}：${escape(value)}`).join('\n') || '尚未填寫。'}\n`
}
export function profileHtml(profile: DossierProfile, person: Person, portrait?: string): string {
  const e = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
  const image = portrait && /^data:image\/svg\+xml;base64,[a-z0-9+/=]+$/i.test(portrait) ? `<img width="96" height="144" alt="人物像素照片" src="${e(portrait)}" style="image-rendering:pixelated;float:right;border:2px solid #7b9b8b;background:#e1eee4;padding:16px;margin:0 0 16px 16px"/>` : ''
  return `<section class="person-file" style="border:2px solid #7b9b8b;background:#f0f6ed;padding:24px;margin-bottom:24px;display:flow-root"><small>YAOZHUO / PERSONNEL FILE</small>${image}<h2>人物檔案 · ${e(profile.displayName || person.name)}</h2><p>原始聯絡人：${e(person.name)}<br>標識：${e(person.id)}</p><p><small>以下為人工整理資料，不是原始聊天或已核實結論。</small></p><dl>${profileRows(profile).map(([label, value]) => `<dt><b>${e(label)}</b></dt><dd style="white-space:pre-wrap;margin:6px 0 16px">${e(value)}</dd>`).join('') || '<p>尚未填寫。</p>'}</dl></section>`
}
