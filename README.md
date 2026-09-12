# AgentBot

本地运行的多智能体协作工作台。每个 agent 是一个长期合作的同事，拥有固定身份、职责、消息经历和自己的记忆，可以私聊、参加群讨论、联系其他同事并使用工具干活。

当前已具备身份与记忆、群聊与点名、流式回复、停止与插话、工作台操作、本机工具和 executor 雏形。可靠投递、跨重启工作状态与主动跟进将按工程计划逐步完善。

## 快速开始

```bash
npm ci
npm --prefix web ci
npm --prefix desktop ci
```

首次配置时复制 `.env.example` 为 `.env` 并填写 `AGENT_API_KEY`；已有配置直接编辑。运行：

```bash
npm run desktop       # 桌面端：先构建，再启动
npm run server        # 后端，默认 127.0.0.1:8787
npm run web:dev       # 前端开发模式，需同时运行后端
```

## 文档

| 文档 | 用途 |
| --- | --- |
| [整体工程化执行计划](./docs/工程化执行计划.md) | 唯一后续路线：目录治理、代码拆分、可靠执行、功能收尾、发布及验收 |
| [架构与行为设计](./docs/架构设计.md) | 当前产品约束、固定同事与工作模型、消息/调度/恢复设计 |
| [当前工具参考](./docs/工具参考.md) | 实际工具与参数、支持范围、已知差异 |
| [使用与开发说明](./docs/README.md) | 配置、启动、现有 API、数据目录和排查方法 |

## 开发检查

```bash
npm test              # 单元与集成测试
npm run typecheck     # 当前仅检查后端
npm run build         # 后端编译
npm run web:build     # 前端类型检查与构建
```

前端单独类型检查：在 `web/` 执行 `npm exec -- tsc --noEmit -p tsconfig.json`。统一检查、干净构建和 CI 将在执行计划 E1 补齐。

## 目录

| 目录 | 内容 |
| --- | --- |
| src/ | TypeScript 后端、同事、记忆、群、工具与运行时 |
| web/ | React + Vite 前端 |
| desktop/ | Electron 启动与窗口 |
| test/ | 行为测试 |
| docs/ | 四份现行文档 |
| .agentbot/ | 运行数据，Git 忽略；不是构建缓存 |

当前保持三个 npm 包；目标模块拆分见执行计划。云电脑不在产品范围，本机 Shell 和文件能力继续保留。
