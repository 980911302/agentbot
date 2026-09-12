# 聊天面板净化、流式与在场感 —— 一批设计

日期：2026-09-12
状态：已确认（用户选定"彻底拿掉"档 + PATCH 接线）
参照：xAI Grok Bot《Designing Grok Bot for a world of persistent agents》

## 背景与目标

对照 Grok Bot，当前聊天面板把执行过程（ToolCallCard、入参/输出）塞进了消息流；没有流式输出；群聊回合进行中界面死寂；头像不表达状态；多处假数据会在演示时穿帮。

本批目标：

1. **聊天面板只呈现对话**：最终回复 + 进行中状态 + 交付物；执行细节全部收进「屏幕」抽屉的完整时间线
2. **私聊流式打字机**：provider 真 SSE，逐 token 推到前端
3. **群聊进行中状态**：谁的回合谁的头像气泡在动
4. **头像即状态**：idle / thinking / working / done 四态动效 + 悬停看当前动作
5. **假数据清理**：不编造 activity / conversationCount / 标题
6. **智能体可编辑**：接上闲置的 `PATCH /api/bots/:id`（名字/职责/颜色），群可重命名

## 非目标（后续批次）

- 群回合流式：群回合的收尾文本是内部推理，不进历史（`persistAssistantText=false`），流出来会露出永远不会发出的"内心戏"。群只做在场状态。
- 通知 / 例程 / 技能 / 连接器
- 头像图片上传、i18n、真实用量页、侧边栏分组

## 设计

### 1 流式（私聊）

- `ChatOptions` 增加 `onDelta?: (text: string) => void`。`OpenAIProvider` 在提供 `onDelta` 时走 `stream: true` + `stream_options.include_usage`，解析 SSE 分块：累积 `delta.content` 每段回调 `onDelta`，同时按 index 累积 `tool_calls` 分片；未提供 `onDelta` 时保持原一次性路径（群回合、单测不受影响）。
- `AgentEvent` 新增 `{ type: 'delta'; text: string }`。`AgentLoopDeps.onDelta` 透传给 `provider.chat`。
- `runtime.runTurn` 的 turn 参数增加 `onDelta`，**仅私聊发送路径传入**；群回合路径不传。
- 事件顺序保证：deltas 在 SSE 连接上先于对应 `message` 事件到达。
- 前端：`applyEvent` 保持纯函数不动；App 增加 `liveText` 状态 —— `delta` 追加，收到 `message(text)` / `done` / `error` 时清空并落真实消息。`ChatView` 在消息列表末尾渲染 live 气泡（头像 + 名字 + 增长文本），替代当前三个点的空泡。

### 2 聊天面板净化 + 抽屉时间线

- `MessageItem` 删除内嵌 `ToolCallCard` 与 tools-container。
- `ToolCallCard` 保留，改造成「屏幕」抽屉时间线的行组件。
- `BotScreen` 重构：**当前动作**（最近 running 调用，无则空闲态 BotFace）+ **完整时间线**（当前频道所有消息的 toolCalls 按序排列，可展开入参/输出）+ 产物列表。去掉 `tool://` 假地址栏装饰。
- 消息流里的产物文件 chip 保留（交付结果，不是过程）。

### 3 在场感（头像即状态）

- 状态取值：后端 `BotSummary.status`（working/idle）+ 本地 `busy`；thinking = 流式进行中。
- 侧边栏：working 的智能体头像加脉冲环（来自 15s 轮询的 bots 数据）。
- 聊天区：busy 时顶栏与消息头像动效；busy→idle 时头像短暂闪绿勾（done，2.5s）。
- 悬停：working 气泡与头像的 `title` 显示最近 running 的工具调用（真实数据，不编文案）。
- 群：`round_start` 后渲染该成员的头像 + 「正在回复…」工作气泡，其消息到达即替换；沉默提示不变。

### 4 假数据清理

- `ChatView` 标题兜底「白泽联调」→「对话」。
- `currentBotSummary` 不再编造：activity 取最近 running toolCall（无则空，UI 显示「正在处理…」），conversationCount 弃用前端造假（后端若返回真实计数则用）。
- 后端 `toBotView.conversationCount` 用消息存储的真实计数。
- 写死的主人名 "linlin zhang" 属于主人显示名设置项，本批不动。

### 5 智能体编辑（PATCH 接线）

- `api.updateBot(id, { name?, instructions?, color? })` → `PATCH /api/bots/:id`（后端已实现）。
- 新组件 `BotProfileDialog`：名字、职责（多行）、颜色（预设色板，头像实时预览）。入口：聊天顶栏点智能体名；侧边栏右键「编辑」。
- 群重命名：`api.renameRoom(roomId, name)` → `PATCH /api/rooms/:id {name}`（后端已实现）；入口：侧边栏右键「重命名」。
- 保存后同步 `backendAgents` / `channels` / 顶栏标题。

## 测试与验证

- provider 流式解析单测：mock 分块 SSE（含 tool_calls 分片、usage 尾块），断言 onDelta 序列与最终 LLMResponse。
- agent-loop 单测：onDelta 透传、delta 事件顺序在 message 之前。
- 既有单测回归 + `npm run typecheck` + 后端/前端 build。
