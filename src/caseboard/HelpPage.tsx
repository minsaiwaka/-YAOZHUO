import { useEffect, useRef, useState } from 'react'
import { CharacterGallery } from './WorkbenchPanels'

export const helpSections = [
  { id: 'start', label: '從這裡開始', icon: '01' },
  { id: 'relations', label: '關係網怎麼讀', icon: '02' },
  { id: 'analysis', label: '檢索與統計口徑', icon: '03' },
  { id: 'reading', label: '本機讀取與密鑰', icon: '04' },
  { id: 'saving', label: '保存、導出與 AI', icon: '05' },
  { id: 'characters', label: '200 位像素人物', icon: '06' },
] as const
export type HelpSection = typeof helpSections[number]['id']
type Destination = 'board' | 'clues' | 'timeline' | 'statistics' | 'dossier'
type HelpArticle = { section: HelpSection; title: string; paragraphs: string[]; step?: number; destination?: Destination; action?: string }
const searchForms: Record<string, string> = { 幫: '帮', 關: '关', 係: '系', 網: '网', 線: '线', 圖: '图', 數: '数', 據: '据', 讀: '读', 寫: '写', 設: '设', 導: '导', 統: '统', 計: '计', 報: '报', 錄: '录', 群: '群', 鑰: '钥', 碼: '码', 資: '资', 訊: '讯', 連: '连', 檢: '检', 篩: '筛', 選: '选', 頭: '头', 發: '发', 現: '现', 儲: '储', 存: '存', 備: '备', 註: '注', 簽: '签', 箋: '签', 識: '识', 別: '别', 號: '号', 帳: '账', 處: '处', 體: '体', 開: '开', 啟: '启', 動: '动', 頁: '页', 縮: '缩', 匯: '汇', 稱: '称', 對: '对', 話: '话', 實: '实', 視: '视', 頻: '频', 聯: '联', 隱: '隐', 復: '复', 確: '确', 認: '认' }
const normalizeSearch = (value: string) => value.toLowerCase().replace(/[\u3400-\u9fff]/g, character => searchForms[character] || character)
const articles: HelpArticle[] = [
  { section: 'start', title: '第一次使用，先走完六步', paragraphs: ['01 接入資料：可先載入虛構演示檔案，熟悉操作；也可以讀取本機資料或導入 JSON。', '02 選擇中心人物 → 03 核對姓名、外號與縮寫 → 04 核對原文和歧義 → 05 編排人物、便箋與圖片 → 06 保存線索板或導出卷宗。', '左側上方會顯示本次整理對象。人物、稱呼和日期會影響檢索結果，整理前請先核對。'], step: 1, action: '前往 01 接入資料' },
  { section: 'start', title: '畫布怎麼操作？', paragraphs: ['拖動人物卡或素材標題移動；拖動空白處平移畫布；滾輪縮放。雙擊人物卡可切換中心，點擊連線查看原文依據。', '便箋和圖片底部可以切換「已連中心／連到中心」。拖動素材右下角調整大小；素材標題與尺寸按鈕支持方向鍵微調，Shift 可加大步長。', '「全部」適配全部人物和素材，「中心」聚焦中心人物，「整理」重排人物。「專注畫布」收起頂部概覽，給線索留出更多空間。'], step: 5, action: '前往 05 編排線索板' },
  { section: 'relations', title: '每條關係線代表什麼？', paragraphs: ['直接對話：本機帳號與該人物之間有已載入的私聊記錄。展開其他人物時，也可能顯示你與他們之間的可見私聊。', '會話中提及：某段私聊或群聊命中了中心人物的姓名、外號、縮寫或 @ 標識，中心人物就連到該會話的人或群。', '群聊成員：由中心人物連到其所在的已識別群，再由群連到成員；即使成員沒有發言，也可能出現成員線。', '引用回覆：找到同一會話內的原消息與引用消息後，連接兩條消息的發送者。手動便箋和圖片使用獨立點線。'], destination: 'board', action: '返回關係線索板' },
  { section: 'relations', title: '有連線，是否表示兩個人認識？', paragraphs: ['例如，你和陳嶼的私聊提到了王小明，會出現「王小明—陳嶼」的提及線。它表示這段會話提到了王小明，不能據此確認兩人認識。', '目前不能準確確認真正的共同好友：本機資料未提供其他人的完整好友列表。共同群聊、同群成員和共同提及都只能作為線索。'] },
  { section: 'relations', title: '線越粗、位置越近，各表示什麼？', paragraphs: ['線寬按該類關係的去重消息依據數量計算，使用對數縮放並設上限。私聊看消息條數，提及看命中條數，群成員線看該成員的發言條數。', '手動素材連線不參與自動關係頻次。卡片位置主要用於排版和手動整理，遠近不表示親密程度；線寬也不能直接用作親密程度判斷。'] },
  { section: 'analysis', title: '怎樣找出其他會話裡的提及？', paragraphs: ['在 03 補充姓名、舊備註、外號、英文名和縮寫，例如「王小明，wxm，小明，明哥」，再更新稱呼。', '拉丁縮寫忽略大小寫並匹配完整片段；同一消息命中多個稱呼只計一次。@ 標識也會作為線索。', '目前主要依靠規則匹配和人工核對，不能可靠追蹤「他、她」等代詞指代。同名、同縮寫或轉述需要結合原文確認，可以排除無關記錄。'], step: 3, action: '前往 03 設定稱呼' },
  { section: 'analysis', title: '什麼算相關消息？哪些篩選影響報告？', paragraphs: ['相關消息包括直接會話、中心人物發言、稱呼命中，以及同一會話中相距 15 分鐘以內的前後相鄰各一條上下文。上下文不會遞迴擴展整段聊天。', '日期範圍和人工排除影響分析與報告。畫布搜索、關係開關和僅看釘選控制對應視圖，不改變報告統計口徑。', '「完整線索」逐項列出人物、群聊、關係、相關原文、媒體和手動素材；所有列表均可翻頁查看。'], destination: 'clues', action: '查看完整線索' },
  { section: 'analysis', title: '全部、私聊、群聊，分別統計什麼？', paragraphs: ['全部相關記錄是私聊與群聊相關記錄之和，兩者互斥，不重複計數。私聊包含與中心人物的私聊，也包含其他私聊中的相關提及與上下文。', '群聊只計相關消息，不能當作整個群的全部歷史。每種範圍可查看數量、發送比例、類型、時段、話題和會話總計。', '中心人物就是本機帳號時，發言只計入「中心人物」一次。話題是本地詞頻，不能單憑詞頻斷言偏好或人物關係；時段按本機時區統計。'], destination: 'statistics', action: '查看互動統計' },
  { section: 'reading', title: '自動讀取需要什麼條件？', paragraphs: ['從你正常登錄的 Windows 或 macOS 桌面啟動應用，與微信使用同一系統帳號，並保持微信登錄。點擊自動識別並填充，多帳號時先選擇要讀取的帳號。', '自動識別會驗證候選密鑰後再填充；完成連接後，選擇所需會話再載入消息。也可展開高級設定手動填入已有參數。', '系統權限、微信版本或缺少候選密鑰可能使自動獲取失敗，界面會保留已驗證的信息並說明原因。不要把密鑰或含密鑰的截圖粘貼到公開問題中。'], step: 1, action: '返回資料接入' },
  { section: 'reading', title: '圖片密鑰可以連接資料庫嗎？', paragraphs: ['圖片 AES／XOR 與資料庫密鑰用途不同，各自獨立驗證。圖片參數不能代替資料庫密鑰。', '應用嘗試讀取所選帳號的本機已有圖片參數，並用本地 DAT 樣本驗證；缺少 XOR 時，可從一致的 PNG／JPEG 文件尾推導。沒有候選或樣本時不會宣稱已取得圖片密鑰。', '圖片驗證失敗不阻止讀取文字與聯絡人。找不到本地圖片時，可先在微信中下載，或手動添加圖片到線索板。WXGF、實況、視頻和語音專用解碼尚未全部內置。'] },
  { section: 'reading', title: '遇到 WAL 或「部分資料」怎麼辦？', paragraphs: ['WAL 是資料庫的寫入日誌。讀取器在副本中核驗並合併可驗證的已提交記錄，正常的舊代際尾部會被忽略。請勿手動刪除原 WAL 文件。', '若文件持續變化，可暫停收發消息後重試；真正的校驗損壞仍會報錯。已驗證填入的密鑰在當次連接中保留，通常無需重新自動識別。', '取消讀取、設定條數上限、部分分庫失敗或不支持的資料結構，均可能標為部分資料。未載入的內容不參與分析。'] },
  { section: 'saving', title: '怎樣保存，下一次還能繼續整理？', paragraphs: ['本地草稿會自動保存。跨設備或長期歸檔請在 06 選擇「保存完整線索板」，導出 JSON。', 'JSON 保留人物檔案、像素照片選擇、全部已載入資料、人物位置、便箋、圖片、手動連線、稱呼以及可恢復的篩選設定。再次導入這個 JSON，可繼續整理。', 'HTML／Markdown 用於閱讀和打印，按所選全部、私聊或群聊範圍導出完整原文與統計。卷宗預覽有長度限制，導出不受預覽截斷影響。'], step: 6, action: '前往 06 保存與導出' },
  { section: 'saving', title: '外接 AI 會做什麼、收到什麼？', paragraphs: ['外接 AI 可選全部相關聊天、指定會話或逐條勾選消息；支持搜索、分頁與跨頁勾選。人工備註默認不發送，可單獨勾選。修改範圍或服務後需重新確認，再根據所選原文整理綜述，區分本人自述、重複線索、他人描述和不確定性，並附消息依據。', 'AI 目前不參與自動生成關係線。可能偏好與常用表達需要核對原文；單獨私聊或群聊報告不會混入基於全部記錄的 AI 綜述。', '資料庫密鑰、圖片密鑰及 AI API Key 不寫入檔案。導出的 JSON 與報告包含聊天原文和素材，請自行保管。'] },
  { section: 'characters', title: '200 位人物如何分配？', paragraphs: ['圖鑑收錄 200 款像素人物，涵蓋日常、輕裝、暖衣、工坊、週末、夜遊、花日、雨季、遠行等衣裝、發型和配飾。點擊人物卷宗照片或右側「編輯人物檔案」，可按編號和造型搜索，自行更換。', '未手動指定時按人物標識分配外觀；手動選擇後同步到人物卡與線索板，並隨 JSON 保存。檔案姓名、常用語、偏好和自訂欄位也可編輯，原始記錄保持原樣。像素外觀僅用於視覺區分，不從聊天內容推斷性別、職業或性格。'] },
]

export function HelpSidebar({ section, onSection }: { section: HelpSection; onSection: (section: HelpSection) => void }) {
  return <div className="workflow-panel help-sidebar"><div className="step-heading"><small>HELP / LOCAL GUIDE</small><h3>使用幫助</h3></div><p className="step-help">隨時查閱，當前讀取和整理設定會保留。</p><nav aria-label="幫助目錄">{helpSections.map(item => <button key={item.id} aria-current={section === item.id ? 'page' : undefined} onClick={() => onSection(item.id)}><small>{item.icon}</small><span>{item.label}</span></button>)}</nav></div>
}

export default function HelpPage({ section, busy, onStep, onView }: { section: HelpSection; busy: boolean; onStep: (step: number) => void; onView: (view: Destination) => void }) {
  const [query, setQuery] = useState('')
  const page = useRef<HTMLDivElement>(null)
  useEffect(() => { setQuery(''); page.current?.scrollTo({ top: 0 }) }, [section])
  const search = normalizeSearch(query.trim())
  const visible = articles.filter(article => search ? normalizeSearch(`${article.title} ${article.paragraphs.join(' ')}`).includes(search) : article.section === section)
  return <div className="scroll-page help-page" ref={page}><div className="page-intro"><small>07 / FIELD GUIDE</small><h3>幫助與操作說明</h3><p>從記錄出發，了解每條線索的來源、整理方法與資料範圍。</p></div><label className="help-search form-label">搜索全部幫助<input id="help-search" aria-label="搜索幫助" placeholder="例如：共同好友、連線、WAL、圖片、保存…" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="section-title"><h4>{search ? `找到 ${visible.length} 條說明` : helpSections.find(item => item.id === section)?.label}</h4><span>本機內置 · 無需聯網</span></div>{visible.map(article => <article className="help-article" key={article.title}><h4>{article.title}</h4>{article.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}{(article.step || article.destination) && <button className="pixel-btn small" disabled={busy} onClick={() => article.step ? onStep(article.step) : article.destination && onView(article.destination)}>{article.action} ↗</button>}</article>)}{!visible.length && <div className="empty-state"><h4>暫無對應說明</h4><p>可以試試較短的關鍵詞，或從左側目錄選擇。</p><button className="pixel-btn" onClick={() => setQuery('')}>清除搜索</button></div>}{section === 'characters' && !search && <><CharacterGallery initiallyOpen pageSize={24} wide /><details className="character-atlas"><summary>查看 200 位人物全圖</summary><img src={`${import.meta.env.BASE_URL}caseboard/character-atlas.png`} loading="lazy" decoding="async" alt="謠诼 200 款原創像素人物，編號 001 至 200" /></details></>}</div>
}
