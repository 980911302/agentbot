# AgentBot

本地运行的**多智能体协作工作台**。每个智能体有自己的长期记忆、自己的职责，可以在群里协作、私聊干活、互相传话。

> 三份文档分工：
> - **本文** —— 是什么、怎么用、接口清单
> - [设计文档](./设计文档.md) —— 架构与设计决策
> - [链路文档](./链路文档.md) —— 一次请求从进到出的完整过程

整理日期：2026-09-11

---

## 1. 这是什么

一句话：**给每个智能体一本自己的笔记，然后让它们在群里像同事一样协作。**

和常见 AI 助手的差别：

| | 常见助手 | AgentBot |
| --- | --- | --- |
| 记忆单位 | 一份账号一份记忆 | **每个智能体一本笔记** |
| 人的信息 | 混在同一份里 | 单独的「关于你」作用域，所有智能体共享 |
| 群聊 | 一个中心 AI 决定谁说话 | **扇出给全体成员，各自决定说不说** |
| 记忆满了 | 报错或截断 | 画像降级成日志、日志老化、随手笔记过期 |
| 上下文 | 历史切片 | **七段重新组装**（历史只占一段） |

---

## 2. 快速开始

### 2.1 环境要求

- Node.js ≥ 20.3（需要原生 `fetch`）
- macOS / Windows / Linux

### 2.2 安装

```bash
npm install
npm --prefix web install
npm --prefix desktop install
```

### 2.3 三种跑法

```bash
# ① 桌面客户端（推荐）—— 内置后端，双击即用
npm run desktop

# ② 只跑后端 + 网页（默认 http://127.0.0.1:8787）
npm run server

# ③ 前端热重载开发（Vite :5173，自动代理 /api 到 :8787）
npm run server        # 一个终端
npm run web:dev       # 另一个终端
```

### 2.4 命令行模式

```bash
npm run dev -- "读一下 package.json，用一句话总结这个项目"
```

会打印上下文分层用量、每次工具调用、以及本轮写入的记忆：

```
agent> 通用助手 · deepseek-chat
[context] Agent 角色=46t/1项  当前任务=35t/1项
  → read_file({"path": "package.json"})
  ← read_file: { "name": "agentbot", ... } (1ms)
[memory] + [user/portrait] 用户的名字是张林
(2 轮 · final_answer)
```

### 2.5 构建

```bash
npm run build        # 后端 → dist/
npm run web:build    # 前端 → web/dist/
npm run typecheck    # 双端类型检查
```

---

## 3. 界面说明

```
┌──────────┬──────────────────────────────┬──────────────┐
│ 侧边栏    │  消息区                       │ 抽屉          │
│          │                              │              │
│ ☰ 白泽联调│  @everyone 各说一句…          │ 屏幕 / 记忆 / │
│   （群）  │                              │ 成员          │
│          │  ┌─ 测试运维 ────────────┐    │              │
│ ○ 测试运维│  │ 159 的发测 checklist…  │    │ 群：成员表    │
│ ○ 知识库  │  └──────────────────────┘    │ 私聊：记忆    │
│ ○ 白泽团队│  ┌─ AI服务 ──────────────┐    │              │
│ ○ AI服务  │  │ 我这边补一句…          │    │              │
│          │  └──────────────────────┘    │              │
│          │  · 白泽团队 看过，没开口       │              │
│          │                              │              │
│ ⚙ 市场    │  ┌────────────────────────┐  │              │
│ LZ linlin│  │ 给 白泽联调 发消息…  →  │  │              │
└──────────┴──────────────────────────────┴──────────────┘
```

### 3.1 侧边栏

| 元素 | 说明 |
| --- | --- |
| **群**（带彩色头像组） | 点击进入群聊，成员各自发言 |
| **智能体**（单个头像） | 点击进入私聊 |
| `＋` | 新建智能体 / 新建群 |
| 搜索框 | 过滤频道 |
| 底部 | 市场（设置）、主题切换、当前用户 |

### 3.2 输入框（胶囊）

| 操作 | 效果 |
| --- | --- |
| `Enter` | 发送 |
| `Shift + Enter` | 换行 |
| `@名字` | 在群里点名某个成员 |
| `@everyone` / `@所有人` | 点名全体 |
| `+` 按钮 | 查看当前装载的工具 |
| 模型选择器 | 切换 `Chat` / `Reasoner` |

### 3.3 抽屉面板（点右上角 ⓘ）

| 标签 | 内容 | 适用范围 |
| --- | --- | --- |
| **屏幕** | 实时显示正在执行的工具调用与返回 | 全部 |
| **记忆** | 三层 × 三作用域，可手动增删、置为画像 | 全部 |
| **成员** | 群成员表，可拉人 / 踢人 | 仅群 |

### 3.4 群聊的两种提示

- **「XX 正在看这一轮…」** —— 某成员正在处理，实时显示
- **「XX 看过，没开口」** —— 该成员这一轮选择沉默（**正常行为**，不是失败）

---

## 4. 功能清单

### 4.1 智能体

- 新建时指定**名字**与**职责**（职责写进系统提示词）
- 每个智能体有独立的：指令、工具集、长期记忆、消息历史
- 系统会自动给新智能体装载全部内置工具

### 4.2 群聊

- 群只有三样东西：**名字、成员表（≤ 6）、共享时间线**
- **三波扇出**：被点名者串行 → 在场未点名者并行 → 被同事再次 @ 者串行
- `@` 是强信号不是投递开关（没被 @ 的也会进入回合）
- **成员之间也能互相叫醒**：A 发言里 `@B`，B 会被再开一轮（防环上限 2 次）
- 被点名的成员**必须开口**（硬约束：不给沉默工具）
- 成员表改完**从下一回合生效**，新成员不回溯历史

### 4.3 记忆

三层 × 三作用域：

| 层 | 每次带进上下文 | 保留上限 | 超容量时 | 生存期 |
| --- | --- | --- | --- | --- |
| **画像** | 12 条 | 40 条 | 降级为日志 | 永久 |
| **日志** | 8 条 | 600 条 | 淘汰最旧 | 永久（可搜） |
| **随手笔记** | 6 条 | 80 条 | 淘汰最旧 | 24 小时 |

| 作用域 | 谁能读 |
| --- | --- |
| **它的笔记** | 只有它自己 |
| **共用的「关于你」** | 所有智能体 |
| **项目笔记** | 参与该项目的智能体 |

**写入方式**：

1. **模型主动调用** `remember` 工具（用户说「记住这个」时）
2. **回合后自动抽取**（兜底）

**重复自动合并**——同一件事不会堆很多份。

### 4.4 上下文管理

- 对话变长时自动压缩成摘要（触发阈值 12 条待压缩消息）
- 旧记忆靠检索带回来，不是全量倒进去
- 前端可以实时看到每段用了多少 token（`event: context`）

### 4.5 工具

| 工具 | 作用 | 限制 |
| --- | --- | --- |
| `calculator` | 四则运算 | 仅数字与 `+ - * / % ( )` |
| `read_file` | 读文件 | ≤ 64 KB，沙箱内 |
| `write_file` | 写文件 | ≤ 256 KB，沙箱内 |
| `list_files` | 列目录 | 跳过隐藏项与 node_modules |
| `remember` | 写长期记忆 | 可指定作用域与层级 |
| `recall` | 搜长期记忆 | |
| `say` | 群内发言 | **仅群回合**，每轮最多 3 条 |
| `stay_silent` | 保持沉默 | **仅群回合**，被点名时不提供 |
| `send_to_agent` | 私发同事 | 传话链深度上限 3 |

**沙箱**：所有文件工具限制在项目根目录内，路径穿越会被拒绝。

---

## 5. API 参考

所有接口在 `http://127.0.0.1:<port>` 上，默认只监听 `127.0.0.1`。

### 5.1 健康检查

```
GET /api/health
→ {
    ok: true,
    service: "agentbot",
    model: "deepseek-chat",
    models: [{ id, label, hint }],
    tools: [{ name, description }],
    budget: { total, recentLimit, compactionTrigger, reserveRecent, sections }
  }
```

### 5.2 智能体

```
GET    /api/agents                    列出全部智能体
POST   /api/agents                    新建  { name, instructions?, color? }
GET    /api/agents/:id                详情（含 memory / messageCount / busy）
PATCH  /api/agents/:id                改    { name?, instructions?, toolNames?, projectIds? }
DELETE /api/agents/:id                删除（连带消息与记忆）
```

> `/api/bots` 是 `/api/agents` 的兼容别名，响应里同时带 `bots` 与 `agents` 两个字段。

### 5.3 消息与回合

```
GET  /api/agents/:id/messages?limit=N     读历史（已合并工具调用与结果）
POST /api/agents/:id/messages             SSE 发起回合  { text, model? }
```

响应是 `text/event-stream`，事件见 §7。

### 5.4 记忆

```
GET    /api/agents/:id/memory                            三层 × 三作用域快照
POST   /api/agents/:id/memory                            手动写入 { text, scope?, tier?, tags?, projectId? }
PATCH  /api/agents/:id/memory/:scope/:owner/:entryId     改层级 { tier?, text?, tags? }
DELETE /api/agents/:id/memory/:scope/:owner/:entryId     遗忘
```

`:scope` 取值 `self` / `user` / `project`；`:owner` 对 `self` 是 agentId、对 `user` 是 `user`、对 `project` 是 projectId。

写 `project` 作用域时归属必须明确：智能体只参与一个项目会自动落对；
参与多个项目时必须显式给 `projectId`，否则返回 400（不会猜一个写进去）。

### 5.5 上下文预览

```
GET /api/agents/:id/context
→ { stats, system, droppedRecent, droppedGroups, surfaced }
```

用于调试——可以直接看到某一刻送给模型的系统提示原文与分层用量。

### 5.6 收件箱（智能体 1:1）

```
GET  /api/agents/:id/inbox     查看积压
POST /api/agents/:id/inbox     立即处理积压（合并成一个回合）
```

### 5.7 群

```
GET    /api/rooms                            列出全部群（含成员信息与最后一条消息）
POST   /api/rooms                            新建  { name, memberIds }
GET    /api/rooms/:id                        详情
PATCH  /api/rooms/:id                        改名 / 改成员  { name?, memberIds? }
DELETE /api/rooms/:id                        解散
GET    /api/rooms/:id/messages?limit=N       共享时间线
POST   /api/rooms/:id/messages               SSE 扇出  { text, model?, ownerName? }
```

`POST /api/rooms/:id/messages` 会**同时**返回 `event:`（AgentEvent）和 `room:`（RoomEvent）两种事件。

### 5.8 兼容层

| 旧接口 | 映射到 |
| --- | --- |
| `GET /api/bots` | `GET /api/agents` |
| `POST /api/bots` | `POST /api/agents` |
| `GET /api/sessions?botId=` | 该 agent 的对话概要 |
| `GET /api/sessions/:id` | `GET /api/agents/:id/messages` |
| `POST /api/chat` | `POST /api/agents/:id/messages` |

---

## 6. 数据目录

所有状态落在项目根的 `.agentbot/`（可用 `AGENT_DATA_DIR` 改）：

```
.agentbot/
├── agents.json                     智能体注册表
├── rooms/
│   ├── index.json                  房间表
│   └── <roomId>.jsonl              群时间线
├── messages/
│   └── <agentId>.jsonl             该智能体的消息（私聊 + 群聊同一条线）
├── memory/
│   ├── user.json                   共用的「关于你」
│   ├── agents/<agentId>.json       它的笔记
│   └── projects/<projectId>.json   项目笔记
├── compaction/<agentId>.json       压缩摘要
└── inbox/<agentId>.json            智能体 1:1 收件箱
```

**备份 / 迁移**：直接复制这个目录。**重置**：删掉它。

---

## 7. SSE 事件速查

| 事件 | 载荷 | 出现场景 |
| --- | --- | --- |
| `: ping` | — | 每 15 秒心跳 |
| `event:` | `AgentEvent` | 私聊 + 群聊 |
| `room:` | `RoomEvent` | 仅群聊 |
| `done:` | `{ content, iterations, stopReason, agentId }` | 全部 |
| `error:` | `{ message, status? }` | 全部 |

```ts
// AgentEvent
{ type: 'context',    stats }                  // 上下文分层用量
{ type: 'message',    message }                // 消息落库（含工具调用与结果）
{ type: 'iteration',  index }                  // 第 N 轮模型调用
{ type: 'compacted',  coversUpTo, messageCount }
{ type: 'memory',     added, merged }          // 写入了记忆
{ type: 'final',      content }

// RoomEvent
{ type: 'room_message', message }
{ type: 'round_start',  roundId, agentId, agentName }
{ type: 'round_end',    outcome }              // outcome.status: spoke | silent | error
{ type: 'fanout_done',  roundId, spoke, silent }
```

---

## 8. 配置

**API Key 只从环境变量或 `.env` 读，源码里没有任何默认密钥。**

第一次使用：

```bash
cp .env.example .env
# 编辑 .env，填入 AGENT_API_KEY
```

`.env` 已在 `.gitignore` 中，不会进仓库。缺 key 时启动会直接失败并打印配置指引
（桌面端会弹对话框提示）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENT_API_KEY` | （必填） | 模型 API key，`OPENAI_API_KEY` 也可 |
| `AGENT_BASE_URL` | `https://api.deepseek.com/v1` | 任何 OpenAI 兼容端点 |
| `AGENT_MODEL` | `deepseek-chat` | 默认模型 |
| `AGENT_OWNER_NAME` | `主人` | 在群里显示的主人名 |
| `AGENT_DATA_DIR` | `<root>/.agentbot` | 数据目录 |
| `AGENT_MEMORY_EXTRACTION` | 开启 | 设为 `off` 关闭回合后自动抽取记忆 |
| `PORT` | `8787` | 仅 `npm run server` 使用 |

读取顺序：**进程环境变量 > `.env` 文件**（命令行传入的能覆盖 `.env`）。

---

## 9. 目录结构

```
AgentBot/
├── src/                       后端（零运行时依赖）
│   ├── agent/                 智能体：循环 / 注册表 / 收件箱 / 类型
│   ├── context/               上下文：组装 / 预算 / 分配
│   ├── memory/                记忆：存储 / 策略 / 去重 / 检索 / 压缩 / 抽取
│   ├── room/                  群：房间表 / 点名 / 回合简报
│   ├── store/                 消息存储（JSONL）
│   ├── llm/                   Provider 接口与 OpenAI 兼容实现
│   ├── tools/                 工具协议 / 注册表 / 内置工具
│   ├── server/                HTTP/SSE / 运行时编排 / 预置数据
│   ├── index.ts               公共 API 导出 + CLI
│   └── config.ts              配置解析
├── web/                       React 前端
│   └── src/
│       ├── App.tsx            事件消费与状态编排
│       ├── api.ts             HTTP 客户端
│       ├── components/        界面组件
│       └── styles.css         设计系统
├── desktop/                   Electron 客户端（内置后端）
├── docs/                      文档
├── 记忆系统.md                 产品规格：记忆
├── 群聊与智能体交互.md          产品规格：群聊
└── .agentbot/                 运行时数据（gitignore）
```

---

## 10. 常见问题

**Q：换个模型供应商？**
改 `AGENT_BASE_URL` 和 `AGENT_MODEL`，只要对方兼容 `/chat/completions`。UI 的模型选择器由 `/api/health` 的 `models` 驱动，可在 `src/config.ts` 的 `AVAILABLE_MODELS` 调整。

**Q：API key 写死在代码里了？**
默认值在 `src/config.ts`，但环境变量优先。要发布的话建议删掉默认值。

**Q：为什么群里有人不回话？**
这是**设计行为**。没被点名且没有新信息的成员会沉默，避免房间空转。想让它回就 `@它`。

**Q：智能体会记得上次群里的讨论吗？**
会。对每个智能体来说，私聊和群聊是**同一条对话线**，带房间标记。但它的私有笔记不会被同事读到。

**Q：记忆会不会满？**
不会报错。画像满了降级为日志，日志老了移出眼前（仍可搜），随手笔记 24 小时后消失。重要的事说「记住这个」会进画像层。

**Q：怎么重置一切？**
删掉 `.agentbot/` 目录。

**Q：端口被占用？**
`npm run server` 用 `PORT=9000 npm run server`；桌面端用随机端口，不会冲突。

---

## 11. 开发

```bash
npm test             # 单元测试（node:test，40 项）
npm run typecheck    # 后端 + 前端类型检查
npm run build        # 后端编译
npm run web:build    # 前端打包
npm run server       # 起后端（带静态托管）
npm run web:dev      # 前端热重载
```

**测试覆盖**：点名解析（长名优先 / 别名 / 失败降级）、记忆去重（数字守卫 / 同义改写）、
召唤队列（二次叫醒 / 防环 / 并行占名额）、开口与沉默判定、群回合简报。

**加一个新工具**：

```ts
// src/tools/examples/my-tool.ts
import { defineTool } from '../tool.js';

export const myTool = defineTool<{ input: string }>({
  name: 'my_tool',
  description: '这个工具做什么',
  parameters: {
    type: 'object',
    properties: { input: { type: 'string', description: '参数说明' } },
    required: ['input'],
  },
  execute({ input }) {
    return `处理结果：${input}`;
  },
});
```

然后在 `src/server/tools.ts` 里注册即可——`ensureDefaultAgent()` 会自动把新工具补进已有智能体的工具集。

**改记忆策略 / 预算 / 群限制**：见[设计文档 §8 扩展点](./设计文档.md#8-扩展点)。
