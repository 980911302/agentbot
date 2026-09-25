/**
 * 后台进程登记簿（E8.4）。
 *
 * 停机时「终止或交接后台进程」要有一个统一的地方能回答两个问题：
 *   1. 现在还有哪些后台进程在跑（写进停机检查点，重启后能核对）；
 *   2. 全部终止掉（Shell 进程组、后台工人）。
 *
 * 为什么不让 ShellSessionManager / WorkerManager 各自为政：这两类进程的归属不同
 * （工具层 vs 运行时层），停机顺序却要求它们在同一步被清掉；登记簿是那张共同的表。
 * 依赖注入式创建（组合根 new 一次传下去），不做模块级全局状态。
 */

export type BackgroundKind = 'shell' | 'worker';

/** 检查点里记的一条后台进程（可读、可核对） */
export interface BackgroundProcessEntry {
  kind: BackgroundKind;
  id: string;
  /** 人能看懂的标签：Shell 是命令摘要，工人是任务标题 */
  label: string;
}

export interface BackgroundTermination {
  terminated: BackgroundProcessEntry[];
  /** 个别进程终止失败时如实记下，不吞掉 */
  failures: string[];
}

interface TrackedProcess extends BackgroundProcessEntry {
  kill: () => void;
}

export class BackgroundProcesses {
  private readonly live = new Map<string, TrackedProcess>();

  /** 登记一个在跑的后台进程；返回注销函数（进程收尾时调用） */
  track(entry: BackgroundProcessEntry & { kill: () => void }): () => void {
    const key = keyOf(entry.kind, entry.id);
    this.live.set(key, entry);
    return () => {
      if (this.live.get(key) === entry) this.live.delete(key);
    };
  }

  /** 此刻还在跑的后台进程（写停机检查点用） */
  list(): BackgroundProcessEntry[] {
    return [...this.live.values()].map(({ kind, id, label }) => ({ kind, id, label }));
  }

  runningCount(kind?: BackgroundKind): number {
    return this.list().filter((entry) => !kind || entry.kind === kind).length;
  }

  /**
   * 停机：终止全部后台进程。
   * 先取快照再逐个终止——快照就是检查点要写的那份清单，也是对账依据。
   * kill 是同步发信号（Shell 杀整个进程组、工人 abort），进程真正退出是随后的事。
   */
  terminateAll(): BackgroundTermination {
    const entries = [...this.live.values()];
    const failures: string[] = [];
    for (const entry of entries) {
      try {
        entry.kill();
      } catch (error) {
        failures.push(`${entry.kind}:${entry.id}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const entry of entries) this.live.delete(keyOf(entry.kind, entry.id));
    return { terminated: entries.map(({ kind, id, label }) => ({ kind, id, label })), failures };
  }
}

function keyOf(kind: BackgroundKind, id: string): string {
  return `${kind}:${id}`;
}
