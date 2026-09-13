import type {
  RunLedgerPort,
  RunTreeRecord,
  RunTurnRecord,
} from './ports.js';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * RunLedger（E3.1 的第四块边界，E3.3 接线）：回合与任务树的记账。
 *
 * 回合/任务树状态与「谁占着执行位」集中在一处，
 * 执行句柄（AbortController、Promise）只在内存里，不随状态落盘。
 * 内存与 JSON 持久实现沿用同一接口——状态经 put 提交，
 * 句柄永远留在 jobsOf/setJobs 这条内存支路上。
 */
export interface TreeJobHandle {
  abort: () => void;
  label: string;
}

export interface RunLedger extends RunLedgerPort {
  /** 某棵树的执行句柄（内存）；持久实现不保存句柄，恢复时要重新装配 */
  jobsOf(treeId: string): TreeJobHandle[];
  setJobs(treeId: string, jobs: TreeJobHandle[]): void;
}

export class InMemoryRunLedger implements RunLedger {
  private readonly turns = new Map<string, RunTurnRecord>();
  private readonly trees = new Map<string, RunTreeRecord>();
  private readonly running = new Map<string, string>();
  /** 每次开始执行 +1：旧执行迟到写回时凭它被拒（E3.6） */
  private readonly epochs = new Map<string, number>();
  private readonly jobs = new Map<string, TreeJobHandle[]>();

  putTurn(turn: RunTurnRecord): void {
    this.turns.set(turn.id, turn);
  }

  getTurn(id: string): RunTurnRecord | undefined {
    return this.turns.get(id);
  }

  putTree(tree: RunTreeRecord): void {
    this.trees.set(tree.id, tree);
  }

  getTree(id: string): RunTreeRecord | undefined {
    return this.trees.get(id);
  }

  listTrees(): RunTreeRecord[] {
    return [...this.trees.values()];
  }

  /**
   * 开始一次执行：取得执行位 + epoch 前进。
   * 旧执行被抢占后（park/新句）再写回时，runningTurnOf 已不是它，写入被拒。
   */
  beginRun(agentId: string, turnId: string): number {
    const next = (this.epochs.get(agentId) ?? 0) + 1;
    this.epochs.set(agentId, next);
    this.running.set(agentId, turnId);
    return next;
  }

  epochOf(agentId: string): number {
    return this.epochs.get(agentId) ?? 0;
  }

  runningTurnOf(agentId: string): string | undefined {
    return this.running.get(agentId);
  }

  releaseRunning(agentId: string, turnId: string): void {
    if (this.running.get(agentId) === turnId) this.running.delete(agentId);
  }

  acquireRunning(agentId: string, turnId: string): void {
    this.running.set(agentId, turnId);
  }

  jobsOf(treeId: string): TreeJobHandle[] {
    const existing = this.jobs.get(treeId);
    if (existing) return existing;
    const created: TreeJobHandle[] = [];
    this.jobs.set(treeId, created);
    return created;
  }

  setJobs(treeId: string, jobs: TreeJobHandle[]): void {
    this.jobs.set(treeId, jobs);
  }
}

interface RunLedgerDoc {
  turns: RunTurnRecord[];
  trees: RunTreeRecord[];
  epochs: Record<string, number>;
}

/**
 * 持久任务账本：回合/任务树/epoch 跨重启保留，只有 AbortController 等句柄留在内存。
 * 启动时上次的 running 回合改为 parked，由 RunExecutor 走正常续跑，不盲目重放工具。
 */
export class JsonRunLedger implements RunLedger {
  private readonly turns = new Map<string, RunTurnRecord>();
  private readonly trees = new Map<string, RunTreeRecord>();
  private readonly running = new Map<string, string>();
  private readonly epochs = new Map<string, number>();
  private readonly jobs = new Map<string, TreeJobHandle[]>();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'runs', 'ledger.json');
    this.load();
  }

  putTurn(turn: RunTurnRecord): void {
    this.turns.set(turn.id, turn);
    this.persist();
  }

  getTurn(id: string): RunTurnRecord | undefined {
    return this.turns.get(id);
  }

  putTree(tree: RunTreeRecord): void {
    this.trees.set(tree.id, tree);
    this.persist();
  }

  getTree(id: string): RunTreeRecord | undefined {
    return this.trees.get(id);
  }

  listTrees(): RunTreeRecord[] {
    return [...this.trees.values()];
  }

  beginRun(agentId: string, turnId: string): number {
    const next = (this.epochs.get(agentId) ?? 0) + 1;
    this.epochs.set(agentId, next);
    this.running.set(agentId, turnId);
    this.persist();
    return next;
  }

  epochOf(agentId: string): number {
    return this.epochs.get(agentId) ?? 0;
  }

  runningTurnOf(agentId: string): string | undefined {
    return this.running.get(agentId);
  }

  releaseRunning(agentId: string, turnId: string): void {
    if (this.running.get(agentId) === turnId) this.running.delete(agentId);
  }

  acquireRunning(agentId: string, turnId: string): void {
    this.running.set(agentId, turnId);
  }

  jobsOf(treeId: string): TreeJobHandle[] {
    const existing = this.jobs.get(treeId);
    if (existing) return existing;
    const created: TreeJobHandle[] = [];
    this.jobs.set(treeId, created);
    return created;
  }

  setJobs(treeId: string, jobs: TreeJobHandle[]): void {
    if (jobs.length === 0) this.jobs.delete(treeId);
    else this.jobs.set(treeId, jobs);
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<RunLedgerDoc>;
    for (const turn of parsed.turns ?? []) {
      if (turn.status === 'running') turn.status = 'parked';
      // 已交给续跑回合的旧根不再自动重启，避免和 running 子回合同时恢复两次。
      if (turn.status === 'resuming') turn.status = 'incomplete';
      this.turns.set(turn.id, turn);
    }
    for (const tree of parsed.trees ?? []) {
      if (tree.status === 'open' && this.turns.get(tree.rootTurnId)?.status === 'incomplete') tree.status = 'incomplete';
      this.trees.set(tree.id, tree);
    }
    for (const [agentId, epoch] of Object.entries(parsed.epochs ?? {})) {
      if (Number.isFinite(epoch)) this.epochs.set(agentId, epoch);
    }
    this.persist();
  }

  private persist(): void {
    const doc: RunLedgerDoc = {
      turns: [...this.turns.values()],
      trees: [...this.trees.values()],
      epochs: Object.fromEntries(this.epochs),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(doc, null, 2), 'utf8');
      renameSync(temp, this.file);
    } finally {
      rmSync(temp, { force: true });
    }
  }
}
