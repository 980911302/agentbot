# AgentBot 使用与开发说明

更新：2026-09-25，依据当前源码。行为与模型见[架构设计](./架构设计.md)，工具参数见[工具参考](./工具参考.md)。后续任务、缺陷与路线统一登记在 VibeHub「智能体机器」项目，不在仓库里另建待办文档。

## 1. 安装与启动

仓库有根（后端 `src/`）、`web`（React + Vite）、`desktop`（Electron）三个 npm 包，各自维护锁文件。要求 Node 24（`.nvmrc` 为 24.8.0，`package.json` 的 `engines` 为 `>=24.0.0 <25`）。

```bash
npm ci
npm --prefix web ci
npm --prefix desktop ci
cp .env.example .env   # 只在首次配置时复制，已有 .env 直接编辑
```

在 `.env` 填入 `AGENT_API_KEY`，然后选择运行方式：

```bash
npm run desktop       # 先构建后端与前端，再启动 Electron（后端用随机端口）
npm run server        # 只起后端，默认 127.0.0.1:8787；web/dist 存在时顺带托管界面
npm run web:dev       # Vite 开发前端（:5173），/api 代理到 8787，需同时运行 server
npm run dev -- "读一下 package.json"   # 命令行单次对话
```

桌面端启动时先探测 `127.0.0.1:8787/api/health`，已有后端就直接复用，否则在进程内启动后端。同一份数据目录只允许一个后端（单实例锁）。

## 2. 工程命令

| 命令 | 实际范围 |
| --- | --- |
| `npm test` | 根目录 `test/*.test.ts`，node:test + tsx，全部使用临时目录和假模型 |
| `node --import tsx test/fixtures/ui-preview.ts` | 手动 UI 验收预览（先 `npm run web:build`）：临时数据 + 假模型一次造出 9 类界面场景，启动后打印 URL 与场景频道 id，Ctrl-C 清理 |
| `npm run typecheck` | 后端 `tsc --noEmit` + 前端 `tsc --noEmit` |
| `npm run build` | 先清 `dist/` 再编译后端 |
| `npm run web:build` | 前端类型检查 + Vite 打包到 `web/dist/` |
| `npm run build:all` | 后端 + 前端构建 |
| `npm run check` | typecheck + test + build:all |
| `npm run docs:check` | 根 `README.md` 与 `docs/*.md` 的相对链接、代码围栏 |
| `npm run ci` | 双端类型 → 测试 → 双端构建 → 文档检查 → UI 令牌 → 格式 → 静态检查 → 跨层 import（`scripts/ci.mjs`，8 步） |
| `node scripts/check-format.mjs` | 只检查 `.prettierfiles` 受管清单的格式；触碰新文件先 `npx prettier --write <file>` 并把路径追加进清单 |
| `node scripts/check-lint.mjs` | 受管文件的静态检查：tsc 未使用声明/隐式 any、显式 any、裸 Promise |
| `node scripts/check-imports.mjs` | 跨层 import 约束（R1 契约纯净 / R2 前端只类型导入 / R3 路由不碰 storage / R4 工具不碰门面），可传 rootDir 指向测试夹具 |
| `npm run clean` | 只清 `dist`、`web/dist`、`test-results`（白名单，绝不碰 `.agentbot`/`.env`） |

### 提交前钩子（ENG-02）

仓库没有远端，`.github/workflows/ci.yml` 不会运行，所以门禁靠本地钩子兜底：

- `.githooks/pre-commit`：先跑 `node scripts/verify-staged.mjs`（暂存区红线：`.env` 与
  `.env.*`（`.env.example` 放行）、`.agentbot/`、`.commandcode/`、`*.key`/`*.pem`/`*.p12`、
  大于 1MB 的文件），再跑 `npm run typecheck` 与 `npm test`；任一步失败即阻止提交。
- 安装：`npm install` 会经 `package.json` 的 `prepare` → `node scripts/install-hooks.mjs`
  自动执行 `git config core.hooksPath .githooks`；也可以手动跑这一条。
- 钩子检查的是**工作区**（原生钩子拿不到干净的暂存树），所以提交前请让工作区处于要提交的状态。
- 只在确知风险时用 `git commit --no-verify` 跳过；完整门禁仍是提交前跑一次 `npm run ci`。

## 3. 配置

启动时读取项目根 `.env`（`src/config.ts`，进程环境变量优先）。设置页保存的模型配置写入数据目录 `model-config.json`，启动时优先于环境变量，可在界面热更新。

| 变量 | 默认/作用 |
| --- | --- |
| `AGENT_API_KEY` / `OPENAI_API_KEY` | 模型 Key，必填其一；缺失时启动报 `MissingApiKeyError` |
| `AGENT_BASE_URL` / `OPENAI_BASE_URL` | OpenAI 兼容地址，默认 `https://api.deepseek.com/v1` |
| `AGENT_MODEL` | 默认 `deepseek-chat` |
| `AGENT_OWNER_NAME` / `AGENT_OWNER` | 主人在群里的显示名，默认「主人」 |
| `AGENT_DATA_DIR` | 数据目录，默认 `<项目根>/.agentbot` |
| `AGENT_MEMORY_EXTRACTION` | `off` 关闭回合后的自动记忆抽取（update_state 仍可写记忆） |
| `AGENT_WEB` | `off` 不装载 WebSearch / WebFetch |
| `AGENT_STOP_WORDS` | 逗号或空白分隔，追加到默认停止词（停、停止、取消、stop 等） |
| `AGENT_DELIVER_DIRS` | 文件交付目录白名单，默认下载、桌面、文档目录 |
| `PORT` | `npm run server` 的端口，默认 8787；桌面端使用随机端口 |

## 4. 使用方式与当前边界

- 侧边栏选择同事进入私聊，选择群进入共享讨论；左上角加号新建同事或群（群最多 6 人）。删除同事、解散群只能由用户在侧边栏发起。
- Enter 发送，Shift+Enter 换行；群里 `@名字` 或 `@everyone` 点名。被点名的必须回应，其他人没有新内容就保持沉默。
- 发送只返回 202 回执，回合在后台执行；界面变化全部走 `GET /api/events` 订阅，断线只断订阅，重连凭游标补发。
- 忙碌时可以继续发新句：旧执行挂起、结束后补跑。整句发送停止词走停止流程：停止立即生效，并暂停该同事后续的自动处理（同事来信、群回合）。
- 群有 `open`（普通群聊）和 `managed`（受控流程）两种模式，受控流程见[群流程与行动权](./群流程与行动权.md)。
- SendToUser 可弹选项卡或密钥框；用户新句会作废未回答的卡片；密钥值不进入聊天和模型上下文。
- 工具调用先记意图再执行再记结果；中断的调用在重启后标记为待核对，不会自动重放。

具体工具及限制见[工具参考](./工具参考.md)。当前不提供云电脑；本机 Read/Shell 不受项目级文件沙箱约束。

## 5. API 概览

基础地址为后端 `http://127.0.0.1:<port>`，路由分发在 `src/server/http.ts`，各资源在 `src/server/routes/`。发送类接口只回 202 回执。

| 路由 | 方法与作用 |
| --- | --- |
| `/api/health` | GET：服务状态、模型、工具目录、预算、主人名 |
| `/api/events` | GET：SSE 订阅，`?after=<seq>` 补发；先发 `ready {latestSeq, resync}` |
| `/api/chat/state` | GET：`?channels=a,b` 取频道快照（消息、运行、待答卡、智能体控制状态） |
| `/api/settings/model` | GET：模型配置（Key 打码）；POST：保存/新增/切换供应商与模型并热更新。只在 `.env`/环境变量配了 Key 时，这里如实显示「已配置」；保存时没填 Key 就沿用环境里的 Key，不会把运行时换成空 Key |
| `/api/settings/model/test` | POST：测试模型连接。改了 `baseURL` 就必须同时传新的 `apiKey`，否则 400——已保存的 Key 只会发往它所属供应商的地址 |
| `/api/agents`、`/api/bots` | GET/POST：列出/创建同事（bots 为前端兼容视图） |
| `/api/agents/:id`、`/api/bots/:id` | GET/PATCH/DELETE：详情/修改/删除。两条删除路径走同一个生命周期（`AgentRuntime.removeAgent`）：忙碌时 409；删完清对话线、自己的记忆与摘要、收件箱积压、待答卡、控制条目，并从所有群的成员表移出。往来档案、任务进度、运行与工具账本作为历史事实保留 |
| `/api/agents/:id/messages` | GET：原始消息；POST：私聊发送（202） |
| `/api/agents/:id/correspondence/:peerId` | GET：与某同事的往来记录（分页） |
| `/api/agents/:id/tasks`、`/tasks/:taskId` | GET：任务进度分页摘要 / 完整快照 |
| `/api/agents/:id/inbox` | GET：积压与失败数；POST：触发消费（已暂停时返回 held） |
| `/api/agents/:id/inbox/retry` | POST：人工重试失败来信 |
| `/api/agents/:id/stop`、`/resume`、`/control` | POST 停止 / POST 恢复（`selection.kind`：input/task/chain/enable_future）/ GET 控制状态 |
| `/api/agents/:id/memory` | GET 快照 / POST 手动写入；`/memory/:scope/:owner/:entryId` PATCH/DELETE |
| `/api/agents/:id/context` | GET：当前上下文预览与预算统计 |
| `/api/chat`、`/api/sessions(/:id)` | 前端兼容的私聊发送与会话入口 |
| `/api/control/stops/:stopId`、`/api/deliveries/:receiptId` | GET：停止操作状态 / 投递回执 |
| `/api/rooms` | GET/POST：群列表/建群 |
| `/api/rooms/:id` | GET/PATCH/DELETE：详情/改名与成员/解散 |
| `/api/rooms/:id/messages` | GET：群时间线；POST：群发言（202） |
| `/api/rooms/:id/flow`、`/flow/control` | GET 当前受控流程；POST 暂停/恢复/结束 |
| `/api/interactions`、`/api/interactions/:id` | GET 待答卡；POST 回答或取消 |
| `/api/secrets`、`/api/secrets/:name` | GET 密钥名字（不含值）；DELETE 删除 |

### 本机请求守卫

服务只监听 127.0.0.1，但仍有跨站调用与 DNS 重绑定的风险，因此在路由分发前统一校验（实现 `src/server/transport/request-guard.ts`）：

- **Host 必须回环**（`127.0.0.0/8`、`localhost` 及其子域、`::1`），否则 403 `FORBIDDEN_HOST`。
- **写操作（POST/PUT/PATCH/DELETE）带 Origin 时，来源必须是本应用**：同源回环（任意端口，含 Vite 开发端口）或桌面端 `file://`；外站来源与 `Origin: null` 一律 403 `FORBIDDEN_ORIGIN`。
- **带 Origin 的请求若带 body，Content-Type 必须是 `application/json`**，否则 403 `FORBIDDEN_CONTENT_TYPE`（挡住 text/plain、表单这类不触发 CORS 预检的简单请求）。
- 不带 Origin 的调用视为本机进程（CLI、`curl`、测试、桌面主进程）放行——浏览器发出的跨站写请求一定会带 Origin，无从伪造。

回归测试见 `test/http-request-guard.test.ts`。

### 事件订阅（SSE）

- `ready`：`{ latestSeq, resync }`；`resync=true` 表示游标太旧或后端重启过，客户端先取快照再从 `latestSeq` 往后订阅。
- `entry`：`{ seq, at, kind, agentId?, roomId?, runId?, payload }`，`kind` 为 `agent`（delta/message/interaction 等）、`room`（room_message/round_start/round_end/flow_updated 等）、`run`（运行状态迁移）。
- 心跳是 SSE 注释行；前端消费在 `web/src/features/events/` 与 `web/src/features/chat/use-chat-stream.ts`。

## 6. 数据目录

默认 `.agentbot/`（Git 忽略，是用户数据，不是构建缓存）：

| 路径 | 内容 |
| --- | --- |
| `agents.json` | 同事资料与工具配置 |
| `rooms/index.json`、`rooms/*.jsonl` | 群及时间线 |
| `messages/*.jsonl` | 每个同事的对话线 |
| `memory/agents/`、`memory/user.json`、`memory/projects/` | 三作用域记忆 |
| `compaction/*.json` | 压缩摘要 |
| `inbox/*.json` | 同事来信与排队群回合（领取/期限/尝试次数/检查点/held） |
| `correspondence/accepted.jsonl` | 已受理来信的往来档案 |
| `chat/runs.json` | 聊天运行账本（重启时把未结束的运行标为中断） |
| `control/state.json` | 执行控制：许可、票据、停止、投递回执、副作用。已终结的票据只保留最近若干条（默认 2000，`ticketRetention` 可调），文件不会随消息数无限增长；接近 48MB 软上限约 80% 时开始告警 |
| `runs/ledger.json` | 回合与任务树账本 |
| `received/index.json` | clientMessageId 幂等索引 |
| `tools/invocations.json`、`tools/outputs/` | 工具执行账本、落盘的工具原文 |
| `tasks/progress/`、`tasks/prompts/`、`tasks/todos.json` | 任务检查点、系统提示快照、待办板 |
| `room-flows/` | 受控群流程状态与签名密钥 |
| `model-config.json` | 设置页保存的供应商与模型（含明文 Key） |
| `secrets.json` | 密钥框收集的密钥（明文，权限 0600） |
| `agentbot.lock` | 单实例锁（pid + 取得时间，正常退出删除） |

备份时先停止后端，再复制整个数据目录。`npm run clean` 与任何清理脚本都不能碰数据目录。

## 7. 排查入口

| 现象 | 先检查 |
| --- | --- |
| 无法启动 | Key 是否配置、端口是否占用、是否已构建；「数据目录正被另一个进程使用」表示已有后端在跑 |
| 消息被拒「控制存储已损坏」 | `control/state.json` 无法解析，系统进入只读保护；先备份数据目录再处理 |
| 前端接口失败 | `/api/health`、Vite 代理、接口错误响应 |
| 界面不更新 | `/api/events` 是否连上、`ready` 帧的 `resync`、浏览器控制台 |
| 群成员不回应 | 是否被点名、是否处于暂停（`GET /api/agents/:id/control`）、收件箱是否 held |
| 工具调用出现模型 400 | tool_calls 与 tool 结果是否成组，见 `src/context/history-selector.ts` |
| 卡片点击无效 | `/api/interactions` 中是否还在，是否超时或被新句作废 |
| 网页抓取被拒 | URL 协议、解析地址是否内网、响应大小与登录要求 |

## 8. 文档索引

| 文档 | 用途 |
| --- | --- |
| [架构设计](./架构设计.md) | 产品约束、领域模型、调度/投递/停止/恢复设计 |
| [工具参考](./工具参考.md) | 25 个工具的参数、行为与边界 |
| [工具边界审计](./工具边界审计.md) | 每个工具的输入输出限额与全链路保护 |
| [群流程与行动权](./群流程与行动权.md) | open/managed 两种群模式、行动授权、自动接棒 |
| [聊天运行与恢复协议](./聊天运行与恢复协议.md) | 聊天控制面：运行身份、事件出口、恢复水位 |
| [执行控制与可靠投递修复设计](./执行控制与可靠投递修复设计.md) | 许可、停止、暂停、投递回执的行为契约 |
| [模块执行边界](./模块执行边界.md) | 授权继承、日志恢复、任务续跑、记忆提交边界 |
| [消息身份与智能体往来](./消息身份与智能体往来.md) | 模型角色与真实发送者分离、往来档案 |
| [协作投递](./协作投递.md) / [协作投递实现](./协作投递实现.md) | 私发、群发与投递语义及实现边界 |
| [群聊点名](./群聊点名.md) / [对话线与群边界](./对话线与群边界.md) / [群动作与提示词](./群动作与提示词.md) | 群聊产品语义 |
| [提示词](./提示词.md) / [缓存命中](./缓存命中.md) | 提示词分层与前缀缓存设计 |
| [UI 交互与视觉](./UI交互与视觉.md) / [主题与 CSS](./主题与CSS.md) | 界面交互规则与主题 token |
