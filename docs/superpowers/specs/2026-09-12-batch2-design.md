# 第二批：消息细节、群 interaction、通知雏形、主人显示名

日期：2026-09-12
状态：按既定批次推进（用户已确认"继续"）
参照：Grok Bot《Designing Grok Bot》——"bring the user in when a decision requires judgment"、花名册通知流

## 目标

1. **@ 高亮**：群消息里的 `@名字` / `@everyone` 按频道成员名匹配并高亮渲染
2. **消息细节**：淡色时间戳、悬停复制整条消息、错误消息可一键重试
3. **群 interaction 接线**：群回合里智能体 `ask_user` 弹出 InteractionCard、可回答（后端已在群 SSE 转发 `event`，前端丢弃了）
4. **通知雏形**：智能体在等你回答时发系统通知（`document.hidden` 才发）；侧边栏群频道未读红点（轮询发现 lastMessage 变化）
5. **主人显示名**：设置页可改，群消息传 `body.ownerName`（后端 http.ts:504 已支持），本地用户消息用它

## 非目标

- 头像图片上传、API Key 设置页（secret store 已有，另批）
- 私聊后台消息的未读追踪（需要 sessions 轮询，后续）
- 通知声音、每智能体通知开关

## 关键设计

- @ 高亮走前端成员名匹配，不改后端 `mentions` 透传：房间消息的 DisplayMessage 映射已经丢了 mentions 字段，前端匹配避免动两个序列化层；代价是代码块里的 @ 也会被高亮（群消息场景可接受）
- 通知只在「需要用户判断」时发（interaction），常规新消息只用红点——避免通知轰炸
- 未读基线：首次 syncWorkspace 只记录 seen、不计数，防止启动时全列表红点
- 主人显示名存 localStorage（`agentbot.ownerName`），默认「主人」；发送群消息时随 body 传后端

## 验证

typecheck + 全量单测 + 双端 build；群 interaction 用现有单测回归，SSE 通道用冒烟脚本手验。
