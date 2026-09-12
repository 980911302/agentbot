import type {
  RunLedgerPort,
  RunTreeRecord,
  RunTurnRecord,
} from './ports.js';

/**
 * RunLedger（E3.1 的第四块边界，E3.3 接线）：回合与任务树的记账。
 *
 * 内存实现：回合/任务树状态与「谁占着执行位」集中在一处，
 * 执行句柄（AbortController、Promise）只在内存里，不随状态落盘。
 * 后续持久实现（SQLite / 文件）沿用同一接口——状态经 put 提交，
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
