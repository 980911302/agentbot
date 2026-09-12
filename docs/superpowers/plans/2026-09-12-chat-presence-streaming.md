# 聊天面板净化、流式与在场感 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 聊天面板只呈现对话（过程收进抽屉时间线）、私聊真流式、群聊在场状态、头像即状态、清假数据、智能体可编辑（PATCH 接线）。

**Architecture:** 后端给 `OpenAIProvider` 加 SSE 流式解析、`AgentEvent` 加 `delta` 事件（仅私聊路径接线）；前端新增 `liveText` 增量渲染、`BotScreen` 时间线、头像状态动效；编辑能力接已存在的 `PATCH /api/bots/:id` 与 `PATCH /api/rooms/:id`。

**Tech Stack:** TypeScript 7 strict · Node 原生 http/SSE · React 19 · node:test

**Spec:** `docs/superpowers/specs/2026-09-12-chat-presence-streaming-design.md`

---

### Task 0: 基线 —— 验证并提交工作区里已有的右键删除功能

**Files:** 已修改未提交：`src/server/http.ts`、`web/src/App.tsx`、`web/src/api.ts`、`web/src/components/Sidebar.tsx`、`web/src/styles.css`、`web/src/components/ConfirmDialog.tsx`

- [ ] Step 1: `npm run typecheck && npm test` —— 必须全绿；红了先修
- [ ] Step 2: 提交

```bash
git add -A && git commit -m "feat(ui): 侧边栏右键删除智能体/解散群，bots GET/PATCH/DELETE 路由"
```

---

### Task 1: 后端流式 —— provider SSE + delta 事件

**Files:**
- Modify: `src/llm/provider.ts`（ChatOptions 加 onDelta）
- Modify: `src/llm/openai-provider.ts`（chatStream 路径）
- Modify: `src/agent/types.ts`（AgentEvent 加 delta）
- Modify: `src/agent/agent-loop.ts`（透传 onDelta）
- Modify: `src/server/runtime.ts`（SendOptions.onDelta → send → runTurn → AgentLoop）
- Test: `test/provider-stream.test.ts`、`test/agent-loop-delta.test.ts`

- [ ] **Step 1: provider 流式解析的失败测试**

```ts
// test/provider-stream.test.ts
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { OpenAIProvider } from '../src/llm/openai-provider.js';

test('chat with onDelta parses SSE stream: deltas, content, tool calls, usage', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"web_search","arguments":"{\\"q\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"测试\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n',
    'data: [DONE]\n\n',
  ];
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) response.write(chunk);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const provider = new OpenAIProvider({ apiKey: 'k', model: 'm', baseURL: `http://127.0.0.1:${port}` });
    const deltas: string[] = [];
    const result = await provider.chat(
      [{ role: 'user', content: 'hi' }],
      { onDelta: (text) => deltas.push(text) },
    );
    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.equal(result.content, 'Hello');
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.id, 'c1');
    assert.equal(result.toolCalls[0]!.name, 'web_search');
    assert.equal(result.toolCalls[0]!.arguments, '{"q":"测试"}');
    assert.equal(result.usage?.totalTokens, 18);
  } finally {
    server.close();
  }
});
```

Run: `npx tsx --test test/provider-stream.test.ts` → FAIL（onDelta 不存在 / 类型错误）

- [ ] **Step 2: agent-loop delta 顺序的失败测试**

```ts
// test/agent-loop-delta.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop } from '../src/agent/agent-loop.js';
import type { LLMResponse, LLMMessage, ChatOptions } from '../src/llm/provider.js';
import type { BuiltContext } from '../src/context/builder.js';
import { MemoryStore } from '../src/memory/store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = {
  name: 'fake',
  async chat(_messages: LLMMessage[], options: ChatOptions = {}): Promise<LLMResponse> {
    options.onDelta?.('你');
    options.onDelta?.('好');
    return { content: '你好', toolCalls: [], finishReason: 'stop', usage: null };
  },
};

test('AgentLoop emits delta events before the persisted message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentbot-loop-'));
  const messages = new MemoryStore() as never; // 按 MemoryStore 构造函数实际签名调整
  const events: Array<{ type: string }> = [];
  const loop = new AgentLoop({
    provider: provider as never,
    messages: messages as never,
    onEvent: (event) => events.push({ type: event.type }),
    onDelta: (text) => events.push({ type: `delta:${text}` }),
  });
  const agent = { id: 'a1', name: '测试', tools: [] } as never;
  const built = { messages: [] } as unknown as BuiltContext;
  await loop.run(agent, built);
  const deltaIndex = events.findIndex((event) => event.type === 'delta:你');
  const messageIndex = events.findIndex((event) => event.type === 'message');
  assert.ok(deltaIndex >= 0 && messageIndex > deltaIndex, 'delta 必须先于 message');
});
```

（写测试时先看一眼现有测试怎么构造 `MemoryStore` / `Agent`，按同样方式写，不要 `as never` 硬凑。）

Run: `npx tsx --test test/agent-loop-delta.test.ts` → FAIL（AgentLoopDeps 无 onDelta）

- [ ] **Step 3: 实现**

`src/llm/provider.ts` 的 `ChatOptions` 加：

```ts
export interface ChatOptions {
  tools?: ToolSchema[];
  temperature?: number;
  signal?: AbortSignal;
  /** 提供即走流式；每段增量文本回调一次 */
  onDelta?: (text: string) => void;
}
```

`src/agent/types.ts` 的 `AgentEvent` 加一行：

```ts
  | { type: 'delta'; text: string }
```

`src/agent/agent-loop.ts`：`AgentLoopDeps` 加 `onDelta?: (text: string) => void`；`run()` 里 `provider.chat` 调用改为：

```ts
const response = await this.deps.provider.chat(conversation, {
  tools: registry.getSchemas(),
  signal: this.deps.signal,
  onDelta: this.deps.onDelta,
});
```

`src/llm/openai-provider.ts`：`chat()` 开头分流 `if (options.onDelta) return this.chatStream(messages, options);`，新增（完整实现，wire 类型放文件顶部接口区）：

```ts
interface StreamDelta {
  content?: string | null;
  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
}

interface StreamChunk {
  choices?: Array<{ delta?: StreamDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message: string };
}

private async chatStream(messages: LLMMessage[], options: ChatOptions): Promise<LLMResponse> {
  const body: Record<string, unknown> = {
    model: this.model,
    messages: messages.map(toWireMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map(toWireTool);
    body.tool_choice = 'auto';
  }
  const temperature = options.temperature ?? this.temperature;
  if (temperature !== undefined) body.temperature = temperature;

  const timeout = AbortSignal.timeout(this.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(`${this.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `LLM request failed with ${response.status} ${response.statusText}` +
        (detail ? `: ${detail.slice(0, 500)}` : ''),
    );
  }
  if (!response.body) throw new Error('LLM streaming response contained no body');

  const onDelta = options.onDelta!;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason: string | null = null;
  let usage: TokenUsage | null = null;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();

  const handleLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      return;
    }
    if (chunk.error?.message) throw new Error(`LLM returned an error: ${chunk.error.message}`);
    if (chunk.usage) usage = toUsage(chunk.usage);
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (choice.delta?.content) {
      content += choice.delta.content;
      onDelta(choice.delta.content);
    }
    for (const piece of choice.delta?.tool_calls ?? []) {
      const slot = calls.get(piece.index) ?? { id: '', name: '', arguments: '' };
      if (piece.id) slot.id = piece.id;
      if (piece.function?.name) slot.name = piece.function.name;
      if (piece.function?.arguments) slot.arguments += piece.function.arguments;
      calls.set(piece.index, slot);
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  if (buffer.trim()) handleLine(buffer);

  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, slot]) => ({ id: slot.id || `call_${slot.name}`, name: slot.name, arguments: slot.arguments || '{}' }));
  return { content: content || null, toolCalls, finishReason, usage };
}
```

`src/server/runtime.ts`：`SendOptions` 加 `onDelta?: (text: string) => void`；`send()` 改为：

```ts
return this.runTurn(agentId, task, { brief: undefined, onDelta: options.onDelta }, options);
```

`runTurn` 的 turn 参数类型加 `onDelta?: (text: string) => void;`，构造 `AgentLoop` 时加 `onDelta: turn.onDelta,`。**群路径（postToRoom 的各波 runTurn 调用）不传 onDelta。**

- [ ] **Step 4: 两个测试跑绿，然后 `npm test && npm run typecheck`**
- [ ] **Step 5: Commit**

```bash
git add src/llm src/agent src/server/runtime.ts test/ && git commit -m "feat(llm): 私聊真流式 —— provider SSE 解析 + AgentEvent delta"
```

---

### Task 2: 前端流式渲染 + 聊天面板净化

**Files:**
- Modify: `web/src/types.ts`（AgentEvent 加 delta）
- Modify: `web/src/App.tsx`（liveText 状态 + 流式 handler + 传给 ChatView）
- Modify: `web/src/components/ChatView.tsx`（live 气泡）
- Modify: `web/src/components/MessageItem.tsx`（删内嵌 ToolCallCard）
- Modify: `web/src/styles.css`（live 气泡 + 光标）

- [ ] Step 1: `web/src/types.ts` 的 `AgentEvent` 加 `{ type: 'delta'; text: string }`（与后端一致）
- [ ] Step 2: `MessageItem.tsx` 删除 `tools-container` 块与 `ToolCallCard` 导入 —— 气泡里只剩 `RichText`
- [ ] Step 3: App.tsx：`const [liveText, setLiveText] = useState('')`；私聊 `streamChat` 的 `onEvent` 里：

```ts
if (event.type === 'delta') {
  setLiveText((current) => current + event.text);
  return;
}
if (event.type === 'message' && event.message.role === 'assistant' && event.message.content.type === 'text') {
  setLiveText('');
}
```

`onDone` / `onError` 里 `setLiveText('')`。发送开始时 `setLiveText('')`。
- [ ] Step 4: ChatView 增加 `liveText?: string` prop；消息列表末尾：`liveText` 非空时渲染 live 气泡（复用 working-bubble 结构，内容为 `liveText` + 闪烁光标 `<span className="type-caret" />`），替代三个点；为空且 busy 时保留现有三点泡。
- [ ] Step 5: styles.css 加 `.type-caret`（2px 竖条 blink 动画）与 live 气泡样式（`white-space: pre-wrap`）。
- [ ] Step 6: `npm --prefix web run build` 过 → Commit `feat(web): 私聊流式打字机 + 消息流去掉工具卡片`

---

### Task 3: BotScreen 时间线重构

**Files:**
- Modify: `web/src/components/BotScreen.tsx`、`web/src/styles.css`

- [ ] Step 1: 重写 `BotScreen`：
  - `const timeline = messages.flatMap((message) => message.toolCalls)`（保持顺序，天然旧→新）
  - `current = timeline.find((call) => call.status === 'running') ?? timeline[timeline.length - 1] ?? null`
  - 布局：头部（状态点 + 「XX 的屏幕」+ 全屏/关闭）→ 当前动作区（`current` 复用 `ToolCallCard`，无调用时空闲 BotFace + 提示文案）→ **时间线列表**（全部 `timeline.map((call) => <ToolCallCard key={call.id} call={call} />)`，running 的排最上高亮）→ 产物列表（原样保留）
  - 删除 `tool://` 假地址栏（stage-bar/stage-url 及相关 JSX）
- [ ] Step 2: styles.css：`.tool-timeline`（纵向列表、running 置顶样式 `.tool-card-item.running { border-color: ... }`），删除不再引用的 stage 样式
- [ ] Step 3: build 过 → Commit `feat(web): 「屏幕」抽屉升级为完整工具执行时间线`

---

### Task 4: 在场感 —— 群进行中气泡、头像状态动效、悬停看动作

**Files:**
- Modify: `web/src/App.tsx`（roundActive 带成员对象；busy→done 闪角标；channel.status）
- Modify: `web/src/components/Sidebar.tsx`（working 脉冲环）
- Modify: `web/src/components/ChatView.tsx`（群成员 working 气泡、头像动效类、done 勾、title 悬停）
- Modify: `web/src/components/Sidebar.tsx` 的 `ChannelItem`（加 `status?: BotStatus`）
- Modify: `web/src/styles.css`

- [ ] Step 1: `ChannelItem` 加 `status?: 'idle' | 'thinking' | 'working' | 'error'`；App 构建智能体频道时从 `backendAgents` 取 `status`。
- [ ] Step 2: Sidebar 频道行头像外包一层 `<span className={'avatar-status' + (channel.status === 'working' ? ' working' : '')}>`，CSS 脉冲环 `@keyframes pulse-ring`。
- [ ] Step 3: 群：`roundActive` 从 `string | null` 改为 `{ id: string; name: string; color: string } | null`（`round_start` 事件有 agentId/agentName，颜色从 `backendAgents` 查，查不到用默认色）。`room_message` 到达时 `setRoundActive(null)`。ChatView 群区渲染成员 working 气泡（成员头像 + 名字 + 三点 + 「正在回复…」）替换现在的「正在看这一轮…」文本行；`silentNotes` 逻辑不动。
- [ ] Step 4: 悬停：ChatView 计算最近 running toolCall（私聊），working 气泡与顶栏头像 `title` = `read_file package.json` 这类 `name(args前80字符)`；群用成员名。
- [ ] Step 5: done 闪角标：App 里 `useEffect` 监听 `busy` true→false，置 `doneFlash=true` 2.5s；ChatView 顶栏头像加 `.done-flash` 绿勾角标（CSS 动画结束后自动消失）。
- [ ] Step 6: build 过 → Commit `feat(web): 在场感 —— 群回合成员气泡、头像状态动效、悬停看当前动作`

---

### Task 5: 假数据清理

**Files:**
- Modify: `web/src/components/ChatView.tsx`、`web/src/App.tsx`、`src/server/http.ts`

- [ ] Step 1: ChatView `title` 兜底「白泽联调」→「对话」。
- [ ] Step 2: `currentBotSummary` 重写：真实 record（`backendAgents` 里找）+ `busy`/`liveText` 推导 status；`activity` = 最近 running toolCall 的 `name`（无则 ''，UI 层空时显示「正在处理…」）；`conversationCount` 用 `record?.conversationCount ?? 0`，**删除所有前端编造的字符串**。
- [ ] Step 3: `src/server/http.ts` `toBotView` 改 async，`conversationCount: await context.runtime.messages.count(record.id)`；调用处 `await`。
- [ ] Step 4: `npm test && npm run typecheck && npm --prefix web run build` → Commit `fix: 清理假数据 —— 状态/计数走真实数据源，兜底标题去「白泽联调」`

---

### Task 6: 智能体编辑（PATCH 接线）+ 群重命名

**Files:**
- Modify: `web/src/api.ts`（updateBot / renameRoom）
- Create: `web/src/components/BotProfileDialog.tsx`、`web/src/components/RenameDialog.tsx`
- Modify: `web/src/App.tsx`、`web/src/components/Sidebar.tsx`、`web/src/styles.css`

- [ ] Step 1: api.ts 增：

```ts
export async function updateBot(
  id: string,
  input: { name?: string; instructions?: string; color?: string },
): Promise<BotSummary> {
  const data = await request<{ bot: BotSummary }>(`/api/bots/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return data.bot;
}

export async function renameRoom(roomId: string, name: string): Promise<void> {
  await request(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}
```

- [ ] Step 2: `BotProfileDialog`：props `{ bot, onClose, onSaved }`；本地 state name / instructions / color；色板 `['#a855f7','#38bdf8','#30d158','#f97316','#f472b6','#facc15','#5eead4','#60a5fa']`；`BotAvatar` 实时预览；保存 → `api.updateBot(bot.id, { name, instructions, color })` → `onSaved(bot)`。空名字禁用保存。
- [ ] Step 3: `RenameDialog`：单输入框 + 确认/取消，props `{ title, initial, onSubmit(name), onClose }`。
- [ ] Step 4: 入口接线：
  - ChatView 顶栏标题在私聊时变按钮（`onOpenProfile` prop）→ App `setEditingBot(当前 bot)`
  - Sidebar 右键菜单加「编辑智能体」（bot 频道）/「重命名」（群频道）→ App 对应打开
  - App 保存回调：更新 `backendAgents`、`channels`（name/color/time 不动）、若编辑的是当前频道同步标题
  - 群重命名成功后更新 channels + 顶栏
- [ ] Step 5: build 过 → Commit `feat(web): 智能体资料编辑（名字/职责/颜色）+ 群重命名，接通 PATCH`

---

### Task 7: 收尾验证

- [ ] `npm test`、`npm run typecheck`、`npm run build`、`npm --prefix web run build` 全绿
- [ ] `git log --oneline` 核对分批提交完整；最终汇报

---

## Self-Review 记录

- 规格覆盖：设计 §1→Task 1/2，§2→Task 2/3，§3→Task 4，§4→Task 5，§5→Task 6 ✅
- 群不流式、主人名不动、头像上传不做 —— 非目标已排除 ✅
- 类型一致性：`onDelta` 链路（ChatOptions → AgentLoopDeps → runTurn → send）与前端 `AgentEvent delta` 两端同步修改 ✅
