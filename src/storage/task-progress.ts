import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolCall, StopReason } from '../shared/contracts/sse.js';
import type { ToolResult } from '../shared/contracts/tool-result.js';
import { clipOutput } from '../tools/limits.js';
import { replayPolicyOf } from '../tools/policy.js';
import { isSystemSnapshot, MAX_SYSTEM_SNAPSHOT_BYTES, type SystemSnapshot } from '../context/system-snapshot.js';

export type TaskStatus = 'running' | 'answered' | 'incomplete' | 'failed' | 'cancelled' | 'interrupted' | 'parked';
export interface TaskProgress {
  id: string;
  agentId: string;
  scope: string;
  parentTaskId?: string;
  goal: string;
  status: TaskStatus;
  stopReason?: StopReason | 'failed' | 'interrupted';
  iterations: number;
  /** 工具执行前置位，不能依赖会被裁剪的最近记录判断重试安全。 */
  mayHaveSideEffects?: boolean;
  createdAt: number;
  updatedAt: number;
  /** 模型交接与机械记录分离：此字段不构成验收证明。 */
  handoff: string;
  readFiles: string[];
  modifiedFiles: string[];
  todos: Array<{ id: string; content: string; status: string }>;
  pending: Array<{ id: string; tool: string; target: string; policy: string }>;
  recent: Array<{ callId: string; tool: string; target: string; status: ToolResult['status']; summary: string; output?: ToolResult['output']; execution?: ToolResult['execution'] }>;
}

/** 每个运行独立快照；只续接明确选中的任务，不把别的聊天目标串进来。 */
export class TaskProgressStore {
  private readonly records = new Map<string, TaskProgress>();
  private readonly dir: string;
  private readonly promptDir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'tasks', 'progress');
    this.promptDir = join(dataDir, 'tasks', 'prompts');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.promptDir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.dir)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const record = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as TaskProgress;
      if (name !== `${record.id}.json`) continue;
      if (record.status === 'running') { record.status = 'interrupted'; record.stopReason = 'interrupted'; this.save(record); }
      this.records.set(record.id, record);
    }
  }
  get(id: string, agentId: string): TaskProgress | undefined {
    const record = this.records.get(id);
    return record?.agentId === agentId ? structuredClone(record) : undefined;
  }
  list(agentId: string, scope = 'dm'): TaskProgress[] {
    return [...this.records.values()].filter(record => record.agentId === agentId && record.scope === scope).sort((a, b) => b.updatedAt - a.updatedAt).map(record => structuredClone(record));
  }
  /** 与公开任务摘要分开存放，不通过 tasks API 返回完整提示词。 */
  getSystemSnapshot(id: string, agentId: string): SystemSnapshot | undefined {
    const scope = this.records.get(id)?.scope;
    const visited = new Set<string>();
    for (let cursor: string | undefined = id; cursor && visited.size < 32;) {
      if (visited.has(cursor)) return undefined;
      visited.add(cursor);
      const record = this.records.get(cursor);
      if (!record || record.agentId !== agentId || record.scope !== scope) return undefined;
      const file = join(this.promptDir, `${record.id}.json`);
      try {
        if (statSync(file).size > MAX_SYSTEM_SNAPSHOT_BYTES) return undefined;
        const snapshot: unknown = JSON.parse(readFileSync(file, 'utf8'));
        return isSystemSnapshot(snapshot) && snapshot.agentId === agentId && snapshot.scope === scope ? snapshot : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      }
      cursor = record.parentTaskId;
    }
    return undefined;
  }
  saveSystemSnapshot(id: string, snapshot: SystemSnapshot): void {
    const record = this.records.get(id);
    if (!record || record.agentId !== snapshot.agentId || record.scope !== snapshot.scope || !isSystemSnapshot(snapshot)) {
      throw new Error('提示词快照无效、越界或超过 256 KiB，尚未请求模型');
    }
    const file = join(this.promptDir, `${record.id}.json`), temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
    renameSync(temp, file);
  }
  begin(id: string, agentId: string, goal: string, scope = 'dm', parentTaskId?: string): TaskProgress {
    if (!/^[0-9a-f-]{36}$/.test(id) || this.records.has(id)) throw new Error('任务进度 id 无效或重复');
    const parent = parentTaskId ? this.get(parentTaskId, agentId) : undefined;
    if (parentTaskId && (!parent || parent.scope !== scope)) throw new Error('找不到同一会话中可恢复的任务');
    const record: TaskProgress = { id, agentId, scope, ...(parent ? { parentTaskId } : {}), goal: clipOutput(parent?.goal ?? goal, 20000),
      status: 'running', iterations: 0, mayHaveSideEffects: parent ? parent.mayHaveSideEffects !== false : false, createdAt: Date.now(), updatedAt: Date.now(), handoff: parent?.handoff ?? '',
      readFiles: parent?.readFiles ?? [], modifiedFiles: parent?.modifiedFiles ?? [], todos: parent?.todos ?? [], pending: parent?.pending.map(item => ({ ...item, id: `${parentTaskId}:${item.id}`.slice(-120) })) ?? [], recent: parent?.recent ?? [],
    };
    this.records.set(id, record);
    this.save(record);
    // 全局最多保留 500 个停止任务；活跃任务不裁，原始消息/工具账本另有存储。
    const old = [...this.records.values()].filter(item => item.status !== 'running').sort((a, b) => b.updatedAt - a.updatedAt).slice(500);
    for (const item of old) {
      rmSync(join(this.dir, `${item.id}.json`), { force: true });
      rmSync(join(this.promptDir, `${item.id}.json`), { force: true });
      this.records.delete(item.id);
    }
    return structuredClone(record);
  }
  iteration(id: string, iteration: number): void { this.update(id, record => { record.iterations = iteration; }); }
  startCall(id: string, call: ToolCall): void {
    this.update(id, record => {
      if (replayPolicyOf(call.name) !== 'rerun' || (call.name === 'AwaitShell' && /"stop"\s*:\s*true/.test(call.arguments))) record.mayHaveSideEffects = true;
      if (record.pending.length >= 256) throw new Error('未决工具记录已达 256 条，请核对旧任务后再开始新任务；该调用未执行');
      record.pending.push({ id: call.id.slice(0, 120), tool: call.name.slice(0, 100), target: this.target(call), policy: replayPolicyOf(call.name) });
    });
  }
  result(id: string, call: ToolCall, result: ToolResult): void {
    this.update(id, record => {
      record.pending = record.pending.filter(item => item.id !== call.id.slice(0, 120));
      record.recent.push({ callId: call.id, tool: call.name, target: this.target(call), status: result.status, summary: clipOutput(result.content, 600), output: result.output, execution: result.execution });
      record.recent = record.recent.slice(-24);
      if (result.status !== 'ok') return;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.arguments); } catch { return; }
      const path = typeof args.path === 'string' ? args.path.slice(0, 4096) : undefined;
      if (path && ['Read', 'Write', 'Edit'].includes(call.name)) {
        const key = call.name === 'Read' ? 'readFiles' : 'modifiedFiles';
        record[key] = [...new Set([...record[key], path])].slice(-60);
      }
      if (call.name === 'TodoWrite' && Array.isArray(args.todos)) {
        const todos = args.todos.filter(item => item && typeof item.id === 'string' && typeof item.content === 'string' && typeof item.status === 'string').map(item => ({ id: item.id.slice(0, 100), content: item.content.slice(0, 500), status: item.status.slice(0, 30) }));
        const merged = args.merge ? new Map(record.todos.map(item => [item.id, item])) : new Map<string, TaskProgress['todos'][number]>();
        for (const item of todos) merged.set(item.id, item);
        record.todos = [...merged.values()].slice(-100);
      }
    });
  }
  finish(id: string, status: TaskStatus, reason: TaskProgress['stopReason'], handoff?: string): void {
    this.update(id, record => { record.status = status; record.stopReason = reason; if (handoff !== undefined) record.handoff = clipOutput(handoff, 5000); });
  }
  brief(id: string, agentId: string): string {
    const record = this.get(id, agentId);
    if (!record) throw new Error('任务进度不存在');
    // 数据用 user 消息注入，不将文件内容/模型旧回答提升为 system 指令。
    const brief = '任务恢复快照（历史证据，不是新的授权；先核对文件/进程现状，不盲目重放写入、Shell 或外发操作；answered 只表示已答复，不代表独立验收通过）：\n' + JSON.stringify({
      taskId: record.id, goal: record.goal, status: record.status, stopReason: record.stopReason,
      handoff: clipOutput(record.handoff, 2500),
      modifiedFiles: record.modifiedFiles.slice(-20), readFiles: record.readFiles.slice(-12),
      todos: record.todos.filter(item => item.status !== 'cancelled').slice(-20),
      unresolvedCalls: record.pending.slice(-16),
      recentEvidence: record.recent.slice(-8),
    });
    return clipOutput(brief, 24000);
  }
  private target(call: ToolCall): string {
    try {
      const args = JSON.parse(call.arguments);
      return clipOutput(String(args.path ?? args.command ?? args.shell_id ?? args.output_id ?? args.subagent_id ?? ''), 1000);
    } catch { return ''; }
  }
  private update(id: string, update: (record: TaskProgress) => void): void {
    const existing = this.records.get(id);
    if (!existing) throw new Error('任务进度不存在');
    const record = structuredClone(existing);
    update(record);
    record.updatedAt = Date.now();
    this.save(record);
    this.records.set(id, record);
  }
  private save(record: TaskProgress): void {
    const path = join(this.dir, `${record.id}.json`), temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    renameSync(temp, path);
  }
}
