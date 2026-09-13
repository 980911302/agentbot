# Execution Control v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个请求能有边界地结束；用户停止后旧来信不能重启执行；平台能准确说明消息是否真正发出。

**Architecture:** 新增单一控制事实源 `RuntimeControlStore`（`.agentbot/control/state.json` 串行事务 + 原子替换）。`ActivationCoordinator` 是唯一执行许可入口。投递走 `DeliveryService` 提交 committed outbox，投影幂等回放。旧关键词完成门拆除，回合由结构化结果结束。

**Tech Stack:** Node ≥24 TypeScript、现有 JSON/JSONL 存储、`node:test` + `tsx`、React/SSE。不引入中间件或多实例协调。

## Global Constraints

- 全程中文用户可见文案；代码标识用英文。
- 本机单实例；不引入微服务/消息中间件。
- 首版补齐进程崩溃恢复，不宣称断电级持久，不宣称任意 Shell 恰好一次。
- `SendToAgent` 投递后返回，不等待对方完成；普通投递不是子任务。
- `Task` 工人按真实所有权取消。
- 当前群发言走 `SendToUser`；`to:"dm"` 才私发主人。
- 提示词保持简洁通用；故障语料只进测试，不进提示词特例清单。
- 准入、停止、发送提交、预算扣减必须经过同一个串行仲裁点。
- 用户新命令建立新链并签发该新链许可，**不会**把 `autoActivation` 全局改回 enabled。
- 停止生效点 = 控制事务提交成功；事务锁内不等待模型/工具 Promise。
- 未实现 `room_round`/`all_agents` 前 API 返回 `UNSUPPORTED_STOP_SCOPE`，不展示空按钮。
- 测试：FakeProvider、独立 tempDataDir、deferred Promise、假时钟、故障注入；不用真实模型和固定 sleep 判断并发。
- 验证：`npm run typecheck`；相关 `node --test --import tsx test/...`；收束后 `npm test`。
- 工作在当前 dirty `main`（用户明确同意）；保留未提交 E3 代码。
- 规范全文：`docs/执行控制与可靠投递修复设计.md`。语义不可省略，字段名可微调。

---

### Task 1: 执行控制契约

**Files:**
- Create: `src/shared/contracts/execution-control.ts`
- Modify: `src/shared/contracts/index.ts`（re-export）
- Test: `test/execution-control.test.ts`

**Produces:** `AgentControl`, `ActivationGrant`, `ActivationTicket`, `StopCommand`, `StopOperation`, `ResumeCommand`, `ActivationRequest`, `ActivationDecision`, `EffectIntent`, `EffectPermit`, `HoldReason`, `CHAIN_BUDGET_DEFAULTS`, `mayAutoActivate`, `CONTROL_SCHEMA_VERSION`.

规范接口见设计 §6、§7.2、§8.1、§11.3。`mayAutoActivate` 实现 §6.2 谓词：仅 enabled 不够；根链序号必须晚于 `blockedAutoRootsThroughSeq`；缺少可信根序号 → 不自动准入。

- [ ] 写失败测试（谓词：paused 拒绝；enabled 但旧根序号拒绝；enabled + 新根序号允许；显式 grant 覆盖旧链；无 rootCreatedSeq 拒绝）
- [ ] 实现类型与 `mayAutoActivate`
- [ ] `node --test --import tsx test/execution-control.test.ts` 通过
- [ ] Commit `feat(control): 执行许可与停止契约`

---

### Task 2: RuntimeControlStore

**Files:**
- Create: `src/storage/runtime-control-store.ts`
- Test: `test/runtime-control-store.test.ts`

**Produces:** `RuntimeControlStore`：`transact` 串行队列、纯同步草稿变换、`writeJsonAtomic`、成功后替换内存并 bump `controlSeq`。路径 `.agentbot/control/state.json`（测试用 `dataDir/control/state.json`）。软阈值 48MiB 拒新增 payload，停止/终态仍可写。损坏快照加载时 `faulted=true` 禁止自动执行。

覆盖设计 A08（同 commandId 重复 stop 同一 stopId）、A20（软阈值）、并发 transact 不丢更新。

- [ ] 失败测试：串行事务、幂等 stop commandId、软阈值拒 payload 仍可 stop、损坏文件 faulted
- [ ] 最小实现
- [ ] 测试通过并 commit `feat(control): 单一控制事实源`

---

### Task 3: ActivationCoordinator

**Files:**
- Create: `src/server/runtime/activation-coordinator.ts`
- Test: `test/activation-coordinator.test.ts`

**Produces:** `acceptUserInput` / `tryActivate` / `assertCurrent` / `admitEffect` / `requestStop` / `resumeSelected`。签发 `ActivationTicket`（含 `processEpoch`、`generation`、`admittedSeq`）。paused 主体：旧链 `held`，新用户命令签发新 chain grant 但不改 `autoActivation`。甲的 chainId 不给乙签发许可。

- [ ] 失败测试对应 A05/A06/A14/A15/A17 的协调器层
- [ ] 实现
- [ ] commit `feat(control): 统一准入协调器`

---

### Task 4: 停止协议（不再等用户回合）

**Files:**
- Modify: `src/server/runtime/stop-coordinator.ts`
- Modify: `src/server/runtime/run-executor.ts`（finally 不无条件 resume/drain）
- Modify: `test/preempt-stop.test.ts`（反转「排队等用户回合结束」）
- Test: `test/activation-stop.test.ts`（A01/A08 集成雏形）

**Must change:** `stopFromUser` 不再因 `running.source==='user'` 排队。控制事务先提交 paused+generation++，再生效取消句柄。重复 stop 同 stopId。不再追加重复「在停/停完了」助手对白（稳定 stopId 状态条可暂用现有消息，但同 commandId 不重复写）。

独立同事不级联取消。`registerChild via=dm` 的 SendToAgent 同事不是工人。

- [ ] 先改测试让「排队等待」失败，再改实现
- [ ] commit `feat(control): 停止立即生效`

---

### Task 5: 所有自动入口接线

**Files:**
- Modify: `src/server/runtime.ts` `acceptMessage` / `drainInbox` / `recover`
- Modify: `src/server/runtime/inbox-processor.ts`（claim 后 tryActivate；held 不进模型；不烧 attempts）
- Modify: `src/server/runtime/inbox-scheduler.ts`（`nextWakeAt` 排除 held/cancelled；暂停不 100ms 热轮询）
- Modify: `src/agent/inbox.ts` + `src/storage/ports.ts`（`disposition` 字段）
- Modify: `src/server/runtime/delivery-session.ts`（held 归还不烧重试）
- Modify: `src/agent/execution-guard.ts`（叠加 ticket/generation）
- Modify: `src/agent/continuation.ts`（保存 inputId/chainId/generation）

启动次序：加载控制状态 → 投影/租约 → 最后才 start scheduler。`resumeOwed`/`resumeRecovered`/`drainInbox`/`finally` 全部 `tryActivate`。

- [ ] 测试：A03 claimed 未开始模型时 stop；A13 finally/recover/drain 不能绕过
- [ ] commit `feat(control): 自动入口统一门禁`

---

### Task 6: A 类验收测试

**Files:**
- Test: `test/execution-stop.test.ts`（A01–A20 能在本批证明的项；room_round 未实现则断言 UNSUPPORTED）

必须单独证明：**停止确认以后，旧信不能让当前智能体再调用一次模型。** FakeProvider 计数。

- [ ] 实现并跑通相关测试
- [ ] `npm run typecheck:server` 通过
- [ ] commit `test(control): A 类停止与恢复`

---

### Task 7: DeliveryService 与动作身份

**Files:**
- Create: `src/server/runtime/delivery-service.ts`
- Modify: `src/tools/builtin/room.ts` 改走 DeliveryService
- Modify: `src/agent/agent-loop.ts` 去掉强迫 SendToAgent
- Test: `test/delivery-service.test.ts`（C01–C05 核心）

动作指纹：`actorId + inputId + target.kind/id + payloadHash`。同动作返回原回执。控制事务内分配固定 deliveryId。

- [ ] TDD 后 commit `feat(delivery): 提交仲裁与动作幂等`

---

### Task 8: 幂等投影

**Files:**
- Create: `src/server/runtime/outbox-projector.ts`
- Modify: `src/agent/inbox.ts` `putIfAbsent`
- Modify: `src/room/store.ts` `appendIfAbsent`
- Modify: `src/storage/correspondence-store.ts` `putIfAbsent`
- Test: `test/outbox-projector.test.ts`（C06–C08、C15）

同 ID 不同 payload → 一致性错误。提交后投影失败仍 accepted+pending。

- [ ] commit `feat(delivery): 幂等投影与崩溃补写`

---

### Task 9: 拆除关键词完成门

**Files:**
- Modify: `src/shared/contracts/delivery-contract.ts` 删除 `requiredDeliveryFrom` 硬门（保留 reserved prefix 检查作展示信任边界）
- Modify: `src/server/runtime/run-executor.ts` 不再注入 requiredDelivery
- Modify: `src/tools/builtin/send-to-user.ts` 删除强制门与 `hasFailedDeliveryAttempt` 依赖
- Modify: `src/tools/tool.ts` 移除旧 requiredDelivery 完成判断
- Modify: `src/agent/agent-loop.ts` 三次后笼统「消息尚未发送」路径删除
- Modify: `test/delivery-contract.test.ts` 反转关键词义务断言

B01/B02：创建三人/同事索要 ID 不得产生群投递义务。

- [ ] commit `fix(delivery): 移除全文关键词完成门`

---

### Task 10: 链预算与结构化错误

**Files:**
- Modify: `src/storage/runtime-control-store.ts` 预算计数
- Modify: `src/tools/builtin/room.ts` 深度/预算结构化码
- Modify: `src/shared/contracts/tool-result.ts`
- Modify: `src/agent/agent-loop.ts` 无进展收敛（3 次同拒绝）
- Test: `test/chain-budget.test.ts`（C09–C11、B05）

默认：`maxAutomaticRunsPerChain=24`、`maxDeliveryActionsPerChain=24`、`maxRecipientDeliveriesPerChain=48`、`maxRepeatedNoProgress=3`。必须可配置、可测小预算。

- [ ] commit `feat(delivery): 因果链预算与统一拒绝码`

---

### Task 11: B/C 类测试收束

**Files:** Test 补齐 B03–B16、C12 以外能在本批证明的项（工作台留第四批）。

- [ ] `node --test --import tsx test/delivery-contract.test.ts test/collaboration-delivery.test.ts test/delivery-service.test.ts test/chain-budget.test.ts`
- [ ] commit `test(delivery): B/C 投递与幂等`

---

### Task 12: ReplyFinalizer 与 delivery_refs

**Files:**
- Create: `src/server/runtime/reply-finalizer.ts`
- Modify: `src/tools/builtin/send-to-user.ts` 可选 `delivery_refs`（最多 8）
- Test: `test/reply-finalizer.test.ts`（B04/B07/B09/B10/B11/B13/B14/B17）

Finalizing 单向；核查无写工具；最多一次文案修正。同事/群允许 silent。

- [ ] commit `feat(reply): 出口核验与有界纠正`

---

### Task 13: UI 空泡与控制快照

**Files:**
- Modify: `src/server/presenters.ts`、`web/src/features/chat/message-reducer.ts`、`web/src/components/MessageItem.tsx`
- Modify: `src/shared/contracts/chat-state.ts`、`src/shared/contracts/sse.ts`
- Modify: `src/server/routes/agents.ts` 增加 stop/resume/control（202 + 事件）
- Test: `test/message-reducer.test.ts`、相关 presenter 测试（D01/D08）

`isChatRenderable`：纯 tool_calls 不进外层气泡。

- [ ] commit `feat(ui): 展示类型与停止控制 API`

---

### Task 14: D 类测试

**Files:** `test/control-ui.test.ts` 等 D02–D07。

- [ ] commit `test(ui): 控制展示与空泡`

---

### Task 15: 工作台配额与幂等创建

**Files:**
- Modify: `src/tools/builtin/workbench.ts` 移除 `MAX_AGENTS_PER_TURN=2` 作为用户硬门
- Modify: `src/workbench/service.ts` `createIfAbsent` + expectedRevision
- Create: `src/server/runtime/registry-coordinator.ts`、`src/server/runtime/effect-runner.ts`
- Test: `test/workbench.test.ts` 扩展 C12–C18

默认每用户请求创建上限 6。普通同事消息不能签发 workbench scope。

- [ ] commit `feat(workbench): 请求级配额与幂等创建`

---

### Task 16: 迁移、文档、总验收

**Files:**
- Create: 控制存储迁移（已有智能体默认 paused + `migration_review`）
- Modify: 旧文档与提示词对齐（`docs/聊天运行与恢复协议.md` 等）；反转「停止等待用户任务」文档
- 跑 `npm run typecheck && npm test && npm run build:all`

交接清单见设计 §19。

- [ ] commit `docs(control): 同步协议并完成迁移`

---

## Batch gates

1. 停止确认后旧信不再调用模型。
2. 正确私信成功不被要求另发群；深度上限能结束。
3. 空泡消失；回执状态条来自事实。
4. 三人创建+建群在授权范围内完成；迁移可重复。
