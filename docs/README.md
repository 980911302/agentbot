# AgentBot 使用与开发说明

更新：2026-09-12，依据当前源码。待实现功能和工程改造见[执行计划](./工程化执行计划.md)；行为与目标模型见[架构设计](./架构设计.md)；工具参数见[工具参考](./工具参考.md)。

## 1. 安装与启动

当前仓库有根、web、desktop 三个 npm 包，各自维护锁文件。根 package.json 声明 Node ≥20.3，本次检查使用 Node v24.8.0。各端最低版本与发布版本尚需在执行计划 E1 统一核验，不能据此承诺所有 Node 20 环境都通过。

在项目根目录执行：

```bash
npm ci
npm --prefix web ci
npm --prefix desktop ci
cp .env.example .env
```

首次使用时再复制模板，在 `.env` 填入模型 Key。已有 `.env` 时直接编辑，避免覆盖配置。随后选择运行方式：

```bash
npm run desktop       # 构建后启动 Electron，使用随机后端端口
npm run server        # 后端，默认 127.0.0.1:8787
npm run web:dev       # Vite 开发前端，默认 :5173
npm run dev -- "读一下 package.json"
```

前后端热重载开发时，在两个终端分别运行 server 和 web:dev；Vite 将 `/api` 代理到 8787。若修改后端端口，也要同步开发代理。直接访问后端提供的网页前，先执行 `npm run web:build` 生成静态页面。

## 2. 当前工程命令

| 命令 | 实际范围 |
| --- | --- |
| `npm test` | 根 test 目录的 node:test 测试 |
| `npm run typecheck` | 仅后端 TypeScript |
| `cd web && npm exec -- tsc --noEmit -p tsconfig.json` | 前端 TypeScript |
| `npm run build` | 后端编译到 dist |
| `npm run web:build` | 前端类型检查及 Vite 打包 |
| `npm run desktop` | 后端构建、前端构建、启动桌面 |

统一 check、clean、双端 typecheck 和 CI 是执行计划 E1 的待办，当前不要调用尚不存在的脚本。后端 tsc 目前不主动清理旧输出，删除源码后的旧 dist 文件可能残留；E1 将补干净构建。

## 3. 配置

配置解析在 `src/config.ts`，进程环境变量优先于 `.env`。缺少模型 Key 时启动失败，并提示配置方式；源码没有默认 Key。

| 配置 | 默认/作用 |
| --- | --- |
| AGENT_API_KEY / OPENAI_API_KEY | 模型 Key，必填其中一个 |
| AGENT_BASE_URL / OPENAI_BASE_URL | OpenAI 兼容地址，默认 `https://api.deepseek.com/v1` |
| AGENT_MODEL | 默认 `deepseek-chat` |
| AGENT_OWNER_NAME / AGENT_OWNER | 群发言者显示名，默认“主人” |
| AGENT_DATA_DIR | 默认项目根 `.agentbot` |
| AGENT_MEMORY_EXTRACTION | `off` 关闭自动抽取；显式记忆工具仍可使用 |
| AGENT_WEB | `off` 不装载 WebSearch/WebFetch |
| AGENT_STOP_WORDS | 逗号或空白分隔，追加停止词 |
| AGENT_DELIVER_DIRS | 文件交付目录白名单；默认下载、桌面、文档目录 |
| PORT | server 模式默认 8787；桌面使用随机端口 |

界面的主人名当前另存 localStorage，并在群发送时传入；全局统一 SettingsService 尚未完成。设置页尚未提供完整的模型 Key、时区、语言与每同事工具装卸功能。

## 4. 使用方式与当前边界

- 侧边栏选择同事进入私聊，选择群进入共享讨论；加号创建同事或群。固定身份持续存在。
- 聊天顶栏或侧边栏入口修改同事资料；用户可从侧边栏删除同事/群。分组、隐藏找回和完整头像管理仍在收尾计划。
- Enter 发送，Shift+Enter 换行；群里 @名字 或 @everyone 点名。未被点名且没有补充信息时，同事可以沉默。
- 私聊有增量文本；群展示成员的回合状态和公开发言。工具入参与输出主要在过程抽屉查看。
- 信息抽屉提供过程、记忆和群成员；用户可查看、调整记忆及群成员。
- 忙碌时可以继续发新句，旧执行挂起；发送整句“停”等停止词走停止流程。当前没有输入框停止按钮。
- SendToUser 可显示选项卡或密钥框；交互目前有超时，用户新句会作废旧问题卡。密钥值不进入普通聊天或模型结果。
- 群里的忙碌成员不再被跳过：消息会排进它的收件箱，等它空下来补一轮（离群后排队消息自动撤销）。收件箱是「领取-确认」（失败有限退避，超限进 failed 等人工重试）。
- 发送只返回回执，回合在后台跑；界面变化走 `GET /api/events` 订阅，断线只断订阅（重连凭游标补发）。关闭全部桌面窗口仍会退出后端。
- 工具调用会记账（执行前记意图、执行后记结果）；中断的调用要按策略先核对，shell 这类不会自动重跑（自动恢复尚未开启）。
- 同一份数据目录只允许一个后端：启动时取 `agentbot.lock`，已有活进程会明确报错；崩溃留下的锁会自动接管。重启会接管上次没确认的来信并接着办。

具体工具及限制见[工具参考](./工具参考.md)。当前不提供云电脑，也不把本机 Read/Shell 描述为受项目级文件沙箱约束。

## 5. 当前 API 概览

基础地址是后端的 `http://127.0.0.1:<port>`。源码入口 `src/server/http.ts`；发送类接口只回 202 回执，界面变化统一走 `/api/events` 订阅。

| 路由 | 方法与作用 |
| --- | --- |
| `/api/health` | GET：模型、工具、预算、服务状态 |
| `/api/events` | GET：SSE 事件订阅，`?after=<seq>` 补发；ready 帧带 `{latestSeq, resync}` |
| `/api/agents` | GET/POST：列出/创建同事 |
| `/api/agents/:id` | GET/PATCH/DELETE：详情/修改/删除 |
| `/api/agents/:id/messages` | GET：原始消息；POST：202 回执（`{messageId, agentId, receiptSeq, duplicate}`），正文含 text、可选 model/clientMessageId |
| `/api/agents/:id/memory` | GET/POST：记忆快照/手动写入 |
| `/api/agents/:id/memory/:scope/:owner/:entryId` | PATCH/DELETE：改记忆/遗忘 |
| `/api/agents/:id/context` | GET：当前上下文预览和预算统计 |
| `/api/agents/:id/inbox` | GET：积压与 failed 数；POST：触发消费；`POST /inbox/retry`：人工重试 failed |
| `/api/rooms` | GET/POST：群列表/创建 |
| `/api/rooms/:id` | GET/PATCH/DELETE：详情/修改/解散 |
| `/api/rooms/:id/messages` | GET：群时间线；POST：202 受理回执，扇出在后台跑（含 text、可选 model/ownerName） |
| `/api/interactions` | GET：待答卡，可按 agentId 筛选 |
| `/api/interactions/:id` | POST：value/secret/cancelled 等答案或取消 |
| `/api/secrets` | GET：已存密钥名字，不含值 |
| `/api/secrets/:name` | DELETE：删除对应密钥 |
| `/api/bots`、`/api/bots/:id` | 兼容前端使用的同事视图与编辑入口 |
| `/api/sessions`、`/api/sessions/:id` | 兼容对话概要和展示消息入口 |
| `/api/chat` | 兼容私聊发送入口（202 回执） |

agents 和 bots 当前并非字段完全一致的别名。例如 agents PATCH 只处理 name/instructions/toolNames/projectIds，而 bots 编辑入口可处理部分展示资料；E1/E2/E5 将统一契约。调用前以对应路由校验字段为准。

记忆 API 中 scope 为 self/user/project，工具层 agent 映射 self；项目写入需明确 projectId。响应中的原始 Message 和前端展示消息形态不同，不直接混用。

### 事件订阅（SSE）

发送与订阅是分开的：发送接口回 202 后，回合的事件都写进进程内事件日志（`EventJournal`，单调 seq）。

订阅 `GET /api/events?after=<seq>` 的帧：

- `ready`：`{ latestSeq, resync }`；`resync=true` 表示游标太旧（被保留窗口挤掉）或后端重启过，客户端要先重新取快照，再从 `latestSeq` 往后订阅；
- `entry`：一条 JournalEntry `{ seq, at, kind, agentId?, roomId?, payload }`；`kind` 为 `agent`（AgentEvent：delta/message/interaction 等）、`room`（RoomEvent：room_message/round_start/round_end/fanout_done）、`run`（回合收尾 `{phase:'done'|'error', ...}`）；
- 心跳是 SSE 注释行；断线只断订阅，重连带上最后一条 `seq` 即可补齐。

前端消费在 `web/src/features/events/use-event-stream.ts`（重连与游标）与 `web/src/features/chat/use-chat-stream.ts`（按 agentId/roomId 路由到频道）。

## 6. 数据、产物与备份

当前身份、消息、群、记忆、摘要、收件箱和密钥保存在数据目录：

| 路径 | 内容 |
| --- | --- |
| agents.json | 同事资料与工具配置 |
| rooms/index.json、rooms/*.jsonl | 群及时间线 |
| messages/*.jsonl | 每个同事的经历 |
| memory/user.json、memory/agents/、memory/projects/ | 三作用域记忆 |
| compaction/*.json | 压缩摘要 |
| inbox/*.json | 同事来信（含领取/期限/尝试次数/检查点；failed 可人工重试） |
| tools/invocations.json | 工具执行账本（意图/结果/恢复分类；有意图没结果的调用是恢复时的核对依据） |
| agentbot.lock | 单实例锁（pid + 取得时间；正常退出会删除） |
| secrets.json | 本机明文密钥文件，权限 0600；不要复制到诊断日志 |

密钥实现见 `src/secret/store.ts`。Run、任务树、待答 Promise、shell/worker 索引和 Todo 当前仍在内存，备份文件不能恢复这些进程句柄。

备份时先停止后端写入，再复制整个配置的数据目录及所引用的必要产物。清理构建目录、旧文档或截图时，不清理 `.agentbot`。将来的数据库迁移与回滚按执行计划操作。

## 7. 排查入口

| 现象 | 先检查 |
| --- | --- |
| 无法启动 | `.env`/进程环境中的 Key、端口、前后端构建产物；「数据目录正被另一个进程使用」= 另一个后端还在跑（或旧进程没退干净） |
| 前端接口失败 | `/api/health`、Vite 代理、API 错误响应 |
| 工具调用出现模型 400 | tool_calls 与 tool_result 是否成组；context 裁剪及 provider 输入 |
| 群成员没回 | 是否忙碌被跳过、是否被点名、是否有公开 posts、round_end 状态 |
| 界面不更新 | `/api/events` 订阅是否连上（ready 帧的 resync）、游标是否停住、浏览器控制台报错 |
| 插话后显示异常 | 事件 seq 是否乱序、busy 计数、忙完重拉历史、旧回合是否已 parked |
| 卡片点击无效 | `/api/interactions` 中是否还存在；是否超时或被新句作废 |
| 找不到旧信息 | 原消息是否存在、来源标记、压缩覆盖范围、记忆容量与检索词 |
| 工具卸载后又回来 | ensureDefaultAgent 会补工具；E5.3 修复 |
| 头像清除不生效 | registry 空覆盖约束；E5.1/E5.8 修复 |
| 网页抓取拒绝访问 | URL 协议、解析地址、内网限制、响应大小与登录要求 |
| UI 无法滚动 | 滚动容器 min-height、flex 布局、跟随底部状态 |

记录实际错误和复现步骤，不用“已全部实现”的旧批次记录替代当前检查。功能与工程问题统一登记到执行计划对应项。
