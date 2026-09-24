# AgentBot

本地运行的多智能体协作工作台。每个智能体是一个长期合作的同事：固定身份、职责、自己的对话线和记忆，可以私聊、参加群讨论、给其他同事发消息，并使用本机工具干活。

## 功能

- 固定同事：身份、职责、分层记忆（自己的笔记 / 共用的「关于你」/ 项目笔记）与上下文压缩
- 群聊：`@` 点名、忙碌成员排队、受控群流程（顺序接棒）
- 可靠执行：先持久接收再执行，收件箱领取-确认，工具执行账本，重启后启动扫描
- 停止与插话：整句停止词立即生效，用户新句可插队，旧任务挂起后补跑
- 25 个工具：本机文件与 Shell、联网只读抓取、记忆、工作台（建同事/建群）、后台工人等
- 界面：React 工作台（深浅两套主题）+ Electron 桌面壳，设置页可热切换模型供应商

## 环境要求

- Node.js 24（见 `.nvmrc`，`engines` 为 `>=24.0.0 <25`）与 npm 10+
- 一个兼容 OpenAI 接口的模型 Key（默认 DeepSeek）

## 快速开始

```bash
npm ci
npm --prefix web ci
npm --prefix desktop ci
cp .env.example .env   # 填写 AGENT_API_KEY
```

```bash
npm run desktop       # 桌面端：先构建，再启动
npm run server        # 只起后端，默认 127.0.0.1:8787
npm run web:dev       # 前端开发模式（:5173），需同时运行后端
```

## 常用命令

```bash
npm test              # 行为测试（临时目录 + 假模型，不读写 .agentbot）
npm run typecheck     # 后端 + 前端类型检查
npm run check         # typecheck + test + 双端构建
npm run ci            # check + 文档检查，提交前必须通过
npm run clean         # 清理构建产物（dist、web/dist、test-results）
```

## 项目结构

```text
AgentBot/
├── src/                后端（TypeScript，Node ESM）
│   ├── server/         HTTP 入口、路由、运行时（runtime/）、事件日志
│   ├── agent/          智能体装配、模型-工具循环、收件箱、注册表
│   ├── context/        上下文组装、预算、提示词渲染
│   ├── memory/         记忆存储、检索、去重、抽取、压缩
│   ├── room/           群、点名、召唤队列、发言规则
│   ├── tools/          工具定义（builtin/）与执行服务（services/）
│   ├── storage/        JSON/JSONL 存储、执行控制、各类账本
│   ├── shared/contracts/  前后端共用的线上契约（纯类型与纯校验）
│   ├── llm/            OpenAI 兼容 Provider
│   └── interaction/ secret/ workbench/ cli/
├── web/                前端（React 19 + Vite）
├── desktop/            Electron 桌面壳
├── test/               node:test 行为测试、fakes/、fixtures/
├── scripts/            ci、clean、docs 检查脚本
├── docs/               现行设计与使用文档
└── .github/workflows/  CI
```

运行数据默认写在 `.agentbot/`（Git 忽略），配置在 `.env`（Git 忽略）。

## 文档

| 文档 | 用途 |
| --- | --- |
| [使用与开发说明](./docs/README.md) | 配置、命令、API、数据目录、排查方法与完整文档索引 |
| [架构设计](./docs/架构设计.md) | 产品约束、领域模型、调度/投递/停止/恢复设计 |
| [工具参考](./docs/工具参考.md) | 工具参数、行为与边界 |
| [群流程与行动权](./docs/群流程与行动权.md) | 普通群聊与受控流程 |
| [UI 交互与视觉](./docs/UI交互与视觉.md) | 界面交互规则与视觉风格 |

## 开发协作

任务、缺陷与后续路线统一在 VibeHub「智能体机器」项目维护；开发契约、项目地图与 UI 规范以团队技能的形式发布在同一项目下（`agentbot-contract`、`agentbot-project-map`、`agentbot-ui-design`）。每次改动提交前运行 `npm run ci`。
