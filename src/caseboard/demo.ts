import type { CaseDataset, Evidence, Person } from './types'

const people: Person[] = [
  { id: 'me', name: '我', kind: 'self' },
  { id: 'lin', name: '林知夏', alias: '知夏', kind: 'person' },
  { id: 'chen', name: '陈屿', alias: '阿屿', kind: 'person' },
  { id: 'xu', name: '许棠', kind: 'person' },
  { id: 'zhou', name: '周予安', kind: 'person' },
  { id: 'su', name: '苏眠', kind: 'person' },
  { id: 'lu', name: '陆遥', kind: 'person' },
  { id: 'g-town', name: '小镇散步俱乐部', kind: 'group' },
  { id: 'g-photo', name: '周末胶片计划', kind: 'group' },
  { id: 'g-book', name: '桥边旧书店', kind: 'group' },
]

type Scene = [sessionId: string, day: number, lines: [senderId: string, content: string][]]
// Every statistic comes from these 120 inspectable fictional messages. No generated counts.
const scenes: Scene[] = [
  ['lin', 1, [['me', '知夏，周末还去桥边旧书店吗？'], ['lin', '去呀，旧书店新到了一箱摄影画册。'], ['me', '那我们带上胶片相机，顺便拍一下河边。'], ['lin', '好，周六两点在旧书店门口见。']]],
  ['chen', 1, [['me', '我刚和林知夏约了周末去旧书店，你要来吗？'], ['chen', '林知夏上次推荐的摄影画册还在那里，我想去翻翻。'], ['me', '她说旧书店有新书，之后可以一起去喝咖啡。'], ['chen', '可以，帮我留一个靠窗的位置。']]],
  ['g-town', 1, [['zhou', '周末的散步路线改走河边，有人一起吗？'], ['lin', '我先去旧书店，三点可以在石桥会合。'], ['me', '林知夏和我会从旧书店过去，带着相机。'], ['su', '那我到石桥等你们，顺便带些面包。']]],
  ['xu', 2, [['xu', 'lzx 上次说的那家旧书店在哪条路？'], ['me', '桥西街十八号，门口有一盆很大的绿植。'], ['xu', '我想请 lzx 帮我挑一本摄影入门书。'], ['me', '我晚点问问林知夏，周末她应该会过去。']]],
  ['lin', 2, [['lin', '我找到一张旧书店十年前的照片，想做个小对照。'], ['me', '可以站在同一个位置再拍一张。'], ['lin', '周末光线合适的话，用彩色胶片试试。'], ['me', '我把三脚架也带上，别忘了摄影画册。']]],
  ['g-photo', 2, [['lu', '这周摄影主题定成街角可以吗？'], ['lin', '我想拍旧书店和河边，正好有一卷胶片。'], ['chen', '林知夏拍旧书店的话，我来拍对面的咖啡店。'], ['me', '两组照片放在一起，做一个周末小展。']]],
  ['zhou', 3, [['me', '林知夏说石桥那段路正在维修，周末绕远一点吧。'], ['zhou', '收到，我把散步路线改到咖啡店后面的巷子。'], ['me', '她还想拍一些老门牌，巷子里应该有。'], ['zhou', '我记得那里有几块蓝底白字的旧门牌。']]],
  ['su', 3, [['su', '林知夏喜欢的那款手冲豆子到货了。'], ['me', '我告诉她，周末从旧书店回来可以来喝咖啡。'], ['su', '给 lzx 留一份，烘焙日期是昨天。'], ['me', '好的，我顺便把她上次落下的摄影画册带过去。']]],
  ['g-book', 3, [['xu', '旧书店周末准备整理摄影书架，缺两位帮手。'], ['lin', '我下午有空，可以按年代排一排摄影画册。'], ['me', '我和林知夏一起过去，带标签纸。'], ['zhou', '我来帮忙搬书箱，大家周末见。']]],
  ['lu', 4, [['lu', '你和林知夏经常去旧书店吧，那里能借地方办摄影小展吗？'], ['me', '知夏问过店主，靠窗那面墙可以用。'], ['lu', '那我把周末摄影的样片打印出来给她看看。'], ['me', '别急着定，先看墙面的尺寸再决定。']]],
  ['lin', 5, [['me', '摄影小展的墙面我量好了，宽两米四。'], ['lin', '那放六张照片就够了，旧书店原本的海报保留。'], ['me', '陆遥说可以帮忙打印样片。'], ['lin', '我周末把选好的胶片底片带给他。']]],
  ['chen', 5, [['chen', 'lzx 的摄影小展是这个周末开吗？'], ['me', '还在准备，她想先和旧书店店主确认时间。'], ['chen', '明白，咖啡店可以送一壶冷萃过去。'], ['me', '林知夏应该会喜欢这个提议，我帮你转达。']]],
  ['g-photo', 6, [['me', '林知夏挑了六张旧书店周边的照片，群里先看一下。'], ['lin', '其中两张是上个周末用胶片拍的，颗粒比较明显。'], ['lu', '我建议打印在哑光纸上，旧书店灯光会柔和一点。'], ['chen', '同意，摄影小展不用弄得太正式，像大家的周末记录就好。']]],
  ['xu', 6, [['me', '林知夏选中了那张窗边读书的照片。'], ['xu', '旧书店那张吗？我很喜欢画面里的橙色灯。'], ['me', '是的，她说想配一句关于周末的短文。'], ['xu', '我来找几段合适的文字，摄影画册里也有访谈可参考。']]],
  ['zhou', 7, [['zhou', '上次说的旧门牌我找到了，发个定位给林知夏？'], ['me', '可以，知夏还想拍一组清晨的小镇街道。'], ['zhou', '那我周末六点半去石桥等你们。'], ['me', '先看天气，雨太大的话就改在咖啡店碰头。']]],
  ['g-town', 7, [['su', '周末可能下雨，散步俱乐部要不要取消？'], ['lin', '小雨可以拍倒影，大雨就去旧书店看摄影画册。'], ['zhou', '林知夏这个备选方案不错，我改一下集合公告。'], ['me', '集合地点先写咖啡店，大家到了再决定。']]],
  ['su', 8, [['me', '林知夏的摄影小展想用一点咖啡香氛，你店里有空瓶吗？'], ['su', '有，不过旧书店空间不大，咖啡味太浓会盖住书香。'], ['me', '有道理，我和知夏说改成一小罐咖啡豆。'], ['su', '我给 lzx 留一个小玻璃罐，周末过来拿。']]],
  ['lin', 9, [['lin', '我把摄影小展的标题改成了“周末慢一点”。'], ['me', '很适合旧书店，照片说明也不用太长。'], ['lin', '对了，许棠帮我找到一本关于街头摄影的旧书。'], ['me', '那周末一起翻翻，顺便确定照片的顺序。']]],
  ['lu', 9, [['me', 'lzx 的样片打印好了没？她周末要带去旧书店。'], ['lu', '好了，哑光纸比想象中适合这些胶片照片。'], ['me', '林知夏说谢谢你，打印费用她会记在小展的清单上。'], ['lu', '明细我放在纸袋里了，别把摄影画册和样片压在一起。']]],
  ['g-book', 10, [['zhou', '旧书店靠窗的墙面已经清理好了。'], ['lin', '谢谢大家，周末带样片过去试着排一下。'], ['xu', '林知夏的摄影说明我校完了，放在群文件里。'], ['me', '我来检查挂钩和夹子，先试挂再决定。']]],
  ['chen', 11, [['me', '你有没有看到林知夏放在咖啡店的黑色镜头盖？'], ['chen', '看到了，在收银台旁边。我写了 lzx 的名字。'], ['me', '太好了，她还以为丢在旧书店了。'], ['chen', '让她周末顺路来拿，咖啡豆也帮她留着。']]],
  ['xu', 11, [['xu', '林知夏问我摄影小展的邀请卡要用什么颜色。'], ['me', '旧书店的灯光偏暖，用奶油色可能合适。'], ['xu', '我也这么想，周末带纸样给她看看。'], ['me', '邀请卡上记得写清楚：只是朋友们的摄影分享。']]],
  ['g-photo', 12, [['lu', '周末摄影分享的样片都准备好了。'], ['chen', '林知夏那张雨天石桥的照片，能单独留一张给我吗？'], ['lin', '可以，我带底片来，大家一起挑打印尺寸。'], ['me', '摄影说明和时间我放进共享清单了。']]],
  ['zhou', 12, [['me', 'lzx 说周末先去旧书店，再走河边那条摄影路线。'], ['zhou', '没问题，门牌的位置我也在地图上标好了。'], ['me', '林知夏想把这段路画成小卡片，留在旧书店给客人。'], ['zhou', '我来补上咖啡店和公厕的位置，方便大家走。']]],
  ['su', 13, [['su', '林知夏要的小玻璃罐我洗好了，里面放了少量咖啡豆。'], ['me', '谢谢，周末摄影小展应该正好用上。'], ['su', '还有两杯咖啡券，给旧书店帮忙整理书架的人。'], ['me', '我交给知夏，让她记录在感谢名单里。']]],
  ['lin', 14, [['me', '周末摄影小展准备得怎么样？'], ['lin', '样片都夹好了，旧书店的灯光也试过了。'], ['me', '大家都说想看看你拍的那张石桥倒影。'], ['lin', '那张我放在中间，旁边写上拍摄日期和胶片型号。']]],
  ['g-town', 14, [['me', '林知夏的摄影分享定在周末三点，地点是桥边旧书店。'], ['zhou', '散步结束正好过去，路线卡片我已经打印了。'], ['su', '我从咖啡店带一壶热水，大家记得带杯子。'], ['lin', '谢谢大家，旧书店见，下雨也照常。']]],
  ['lu', 15, [['lu', '林知夏的小展结束后，摄影样片怎么保存？'], ['me', '她想送给旧书店一套，剩下的装进作品夹。'], ['lu', '那我带一些无酸纸袋，胶片和照片分开放。'], ['me', '好，周末结束后我和 lzx 一起整理。']]],
  ['g-book', 15, [['xu', '摄影分享的邀请卡放在旧书店柜台了，欢迎周末来坐坐。'], ['lin', '我会带上那本摄影画册，方便大家翻看参考。'], ['zhou', '林知夏的路线卡也到了，石桥那段路已经恢复通行。'], ['me', '那就周末见，记得给店里的绿植留一点位置。']]],
  ['lin', 16, [['lin', '今天旧书店来了很多朋友，摄影分享顺利结束了。'], ['me', '你那张石桥倒影被大家问了好多次。'], ['lin', '我把摄影画册留在书店了，周末还可以去翻。'], ['me', '好，下个周末我们再约一杯咖啡。']]],
]

const messages: Evidence[] = []
const mediaExamples: Record<string, { kind: 'image' | 'emoji'; key: string; content: string }> = {
  'demo-008': { kind: 'image', key: 'demo:book', content: '[图片] 旧书店窗边的摄影画册' },
  'demo-040': { kind: 'image', key: 'demo:book', content: '[图片] 旧书店窗边的摄影画册' },
  'demo-076': { kind: 'image', key: 'demo:book', content: '[图片] 旧书店窗边的摄影画册' },
  'demo-080': { kind: 'image', key: 'demo:book', content: '[图片] 旧书店窗边的摄影画册' },
  'demo-018': { kind: 'emoji', key: 'demo:cat', content: '[表情] 点头的小猫' },
  'demo-052': { kind: 'emoji', key: 'demo:cat', content: '[表情] 点头的小猫' },
  'demo-060': { kind: 'emoji', key: 'demo:cat', content: '[表情] 点头的小猫' },
  'demo-084': { kind: 'emoji', key: 'demo:cat', content: '[表情] 点头的小猫' },
  'demo-104': { kind: 'image', key: 'demo:coffee', content: '[图片] 周末的一杯咖啡' },
  'demo-118': { kind: 'image', key: 'demo:coffee', content: '[图片] 周末的一杯咖啡' },
}
for (const [sceneIndex, [sessionId, day, lines]] of scenes.entries()) {
  const sceneStart = Date.UTC(2025, 8, day, 6 + sceneIndex % 4, 0)
  for (const [lineIndex, [senderId, content]] of lines.entries()) {
    const id = `demo-${String(messages.length + 1).padStart(3, '0')}`
    const media = mediaExamples[id]
    messages.push({
      id, originalId: id, sessionId,
      sessionName: people.find(person => person.id === sessionId)!.name,
      senderId, senderName: people.find(person => person.id === senderId)!.name,
      timestamp: sceneStart + lineIndex * 90_000, content: media?.content ?? content, kind: media?.kind ?? 'text',
      ...(media ? { mediaKey: media.key, mediaFileName: `${media.key.replace(':', '-')}.png` } : {}),
      ...(lineIndex === 1 && sceneIndex % 5 === 0 ? { replyTo: messages[messages.length - 1].id } : {}),
    })
  }
}

export const demoDataset: CaseDataset = {
  schemaVersion: 1,
  id: 'fictional-bridge-bookshop',
  title: '桥边旧书店 · 虚构演示档案',
  source: 'demo',
  importedAt: Date.UTC(2025, 8, 17, 4),
  ownerId: 'me',
  people,
  messages,
  memberships: [
    ...['me', 'lin', 'chen', 'zhou', 'su'].map(personId => ({ personId, groupId: 'g-town' })),
    ...['me', 'lin', 'chen', 'lu'].map(personId => ({ personId, groupId: 'g-photo' })),
    ...['me', 'lin', 'xu', 'zhou'].map(personId => ({ personId, groupId: 'g-book' })),
  ],
  coverage: {
    description: '完全虚构的日常示例：2025 年 9 月 1–16 日，6 个私聊、3 个群聊；每条消息均可回溯。',
    partial: true,
    sessionCount: new Set(messages.map(message => message.sessionId)).size,
    messageCount: messages.length,
    warnings: ['演示中的所有姓名、对话、关系均为虚构，不代表已读取你的微信数据。', '只能分析已载入的本地可见会话；不能看到其他人的私聊。', '姓名与拼音缩写属于提及候选，存在歧义时需要人工核对。'],
  },
}
