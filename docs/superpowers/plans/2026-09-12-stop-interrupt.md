# 停止与插话 实施计划

> REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Spec: docs/superpowers/specs/2026-09-12-stop-interrupt-design.md

### Task 1: 停止词 + 收件箱 kind
- [ ] `src/config.ts`：`stopWords`（默认表 + `AGENT_STOP_WORDS` 追加）
- [ ] `src/agent/inbox.ts`：`InboxItem.kind?: 'message'|'stop'|'stop-ack'`、`treeId?`；`drain()` 同批 stop 排最前
- [ ] 测试：停止词匹配（trim 标点/大小写/可配）；drain 排序
- [ ] Commit `feat(runtime): 停止词表与收件箱 stop 信`

### Task 2: turn/tree + 抢占调度
- [ ] `src/agent/types.ts`：`RunResult.stopReason += 'parked' | 'stopped'`
- [ ] `src/server/runtime.ts`：
  - turns/trees/runningTurn/pendingStops 内存表
  - runTurn：用户来源遇忙 → park（自有 AbortController abort，旧 turn=parked、树 open）；非用户来源遇忙维持 AgentBusyError
  - 回合结束处理序：pendingStop → resume（cap 3/树）
  - resume：内部回合 skipPersist + 简报带原任务文本
- [ ] `src/server/http.ts`：私聊两处 `isBusy→409` 移除
- [ ] 测试：抢占后新句先跑、旧树 open 欠着、结束后 resume 补跑、resume cap
- [ ] Commit `feat(runtime): 插话抢占式调度 —— 新句开新回合，旧树挂起欠账`

### Task 3: 停止令执行 + 派活记账
- [ ] `src/tools/tool.ts`：TurnState + treeId/registerChild/registerJob
- [ ] `src/tools/examples/room.ts` send_to_agent、`src/tools/examples/workbench.ts` post_to_room → registerChild
- [ ] runtime：`isStopSentence` 分流 kind=stop；机械执行（在停→砍树→children 下发→stop-ack/30s 超时→停完了）；pendingStop 队列；用户回合保护
- [ ] drainInbox：stop 先处理、递归砍树、回 stop-ack
- [ ] 新用户回合作废未答选项卡（broker.cancel + interaction_closed）
- [ ] 测试：停止砍树、dm 下发、stop-ack 计数、用户回合不被打断、新树不被旧停止牵连
- [ ] Commit `feat(runtime): 停止令 —— 砍任务树并递归下发，派活记账`

### Task 4: 群停止语义
- [ ] `src/room/turn.ts`：`buildRoomBrief` 增加 `stopRequested` 行
- [ ] `src/server/runtime.ts`：postToRoom 触发文本命中停止词 → wave-1 简报置位
- [ ] 测试：简报包含停止行；未点名者简报不含
- [ ] Commit `feat(room): 群里的停止令下一轮生效`

### Task 5: 前端
- [ ] App：busy 计数、忙碌可发、sid 守卫 liveText、done(parked) 状态行、忙碌归零拉真相、停止按钮（发送「停」）
- [ ] Composer：去忙碌禁用；忙碌时显示「停止」pill
- [ ] build 过
- [ ] Commit `feat(web): 插话与停止的界面 —— 忙碌可发、停止按钮、挂起状态行`

### Task 6: 收尾
- [ ] typecheck / 全量单测 / 双端 build
- [ ] 冒烟（隔离数据目录）：连发两句验证抢占与 resume；发「停」验证停止链
- [ ] 勾计划 + 汇报
