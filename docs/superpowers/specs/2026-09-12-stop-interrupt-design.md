# 停止与插话 —— 实现设计

日期：2026-09-12
契约：`停止与插话.md`（用户已定稿）
拍板：①parked=断流记欠；②群召唤忙成员维持跳过；③停止词整句匹配可配

## 核心模型

- **RuntimeTurn**（内存）：`{ id, agentId, source: user|agent|room|resume, kind: normal|stop, text, treeId, status: running|parked|done|cancelled, createdAt }`
- **TaskTree**（内存）：`{ id, rootTurnId, agentId, jobs: [{abort, label}], children: [{agentId, via, roomId?}], status: open|cancelling|cancelled, resumeCount }`
- 执行仍**串行**：每智能体同一时刻只有一个 running 回合；新用户句把旧的**断流并标 parked**（树保持 open 记欠），新句立即开新回合。非用户来源（同事信/群/例程）维持忙即跳过。
- **resume**：用户/resume 回合结束后，若有 `status=parked 的 open 树`，运行时补一个内部回合（skipPersist + 简报"继续之前没做完的事：…"）；每棵树最多自动续 3 次。

## 停止令

- 识别在运行时：`send()` 收到**整句**命中停止词（trim + 去尾部标点 + 拉丁小写；默认表：停/停止/先别做了/取消/别做了/不用了/halt/cancel/stop；`AGENT_STOP_WORDS` 可追加）→ `kind=stop`。
- 执行（机械，不经模型）：
  1. 持久化助手消息「好的，在停。」并 emit
  2. 作废该 agent 创建时间早于本次停止的 open 树：jobs 全部 abort、status=cancelling
  3. children：`via=dm` → 收件箱塞 `kind=stop, priority=true, treeId`；`via=room` → 只发普通群文本「先停，别继续了。」
  4. 等各 dm 子节点回 `kind=stop-ack` 或 30s 超时 → 「停完了。」+ done(`stopped`)
  5. 子节点收到 stop：同样递归砍自己的树；正在跑用户回合则挂 pendingStop 队列，回合结束立刻处理
- **排队规则**：停止令撞上正在跑的用户回合 → 挂起等（发起停止的那条 SSE 保持打开，15s 心跳照常），回合一结束立即处理，处理顺序在 resume 之前；处理时只砍"早于停止令创建"的树，用户新句的新树不受牵连。
- 收件箱 drain：同批有 stop 先处理 stop，再照常处理普通信；stop-ack 不进模型，只用于计数。

## 派活记账

- `TurnState` 增加 `treeId` / `registerChild(agentId, via, roomId?)` / `registerJob(abort, label)`；`send_to_agent`、`post_to_room` 调 `registerChild`；回合自身的 AbortController 启动即 `registerJob`。
- 群 @ 扇出不算 child（那是扇出不是雇的下级）。

## 其它契约点

- 新用户回合开始前：作废该智能体未回答的选项卡（broker.cancel + emit interaction_closed）。
- 群里触发文本是停止词：wave-1 简报注入一行「主人叫停了，先停手上的活」；群里不发紧急、不砍树。
- 私聊路由取消 `isBusy→409`。

## 前端

- busy 从布尔改计数；忙碌时可继续发送（抢占）；流按 `sid` 守卫 liveText，防旧流 done 清掉新流的字。
- `done(stopReason='parked')` → 频道内轻状态行「旧任务已挂起」；忙碌时输入框旁出现「停止」按钮 = 发送停止词回合。
- 忙碌计数归零时**拉一次当前频道真相**（fetchSession / fetchRoomMessages），让 resume/后台信件的落库内容可见。

## 非目标

- 树/回合的跨重启持久化（内存即可；消息本身已落盘）
- 后台 shell pid 类 job（当前无此工具，jobs 只记 AbortController）
- 群停止令的紧急下发（契约明确：群只能下一轮看见）
