import { join } from 'node:path';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import { JsonlLog } from '../storage/jsonl-log.js';
import type { InstanceLockInfo } from '../storage/instance-lock.js';
import type {
  BackgroundProcessEntry,
  BackgroundProcesses,
  BackgroundTermination,
} from '../tools/services/background-processes.js';

/**
 * 优雅停机的唯一编排点（E8.4）。
 *
 * 顺序是硬要求，也是本文件存在的理由：
 *   1. stop_accepting      停止接新工作（关监听、停内部调度）
 *   2. checkpoint          写检查点（此刻还在跑的后台进程、锁记录、是否还在接活）
 *   3. terminate_background 终止后台进程（Shell 进程组 / 后台工人）
 *   4. close_storage       收尾在飞回合 → 等存储写入落盘 → 再补一次后台清场
 *   5. release_lock        放掉单实例锁（最后一步：锁在，别人不会进来）
 *
 * 为什么检查点在终止之前：检查点是「重启后能核对现场」的依据，必须记下**终止之前**
 * 真实在跑的清单；反过来先杀再写就只剩一份猜。检查点里 `acceptingNewWork` 取自
 * 真实 http.Server.listening，不是常量——顺序被改坏时它会变成 true。
 *
 * 每一步都落一行 `lifecycle/shutdown-steps.jsonl`：停机走到哪一步、哪一步失败，
 * 事后可查；步骤失败不阻断后面的步骤（尤其是放锁，必须走到）。
 */

const LIFECYCLE_DIR = 'lifecycle';
const STEPS_KEY = 'shutdown-steps';
const CHECKPOINT_FILE = 'shutdown.json';
const TERMINATION_FILE = 'background-termination.json';
const DEFAULT_STEP_TIMEOUT_MS = 15_000;

export type ShutdownStepName =
  'stop_accepting' | 'checkpoint' | 'terminate_background' | 'close_storage' | 'release_lock';

export interface ShutdownStep {
  step: ShutdownStepName;
  at: number;
  detail?: string;
  /** 这一步失败了也要继续；失败原因如实留痕 */
  error?: string;
}

/** 停机检查点：重启后核对「上次停机时还挂着什么」 */
export interface ShutdownCheckpoint {
  at: number;
  pid: number;
  reason: string;
  /** 写检查点这一刻 HTTP 服务是否还在接新连接 */
  acceptingNewWork: boolean;
  /** 终止之前真实在跑的后台进程清单 */
  background: BackgroundProcessEntry[];
  lock?: InstanceLockInfo;
}

export interface ShutdownReport {
  reason: string;
  startedAt: number;
  endedAt: number;
  steps: ShutdownStep[];
  background: BackgroundTermination;
  checkpointFile?: string;
}

export interface ShutdownDeps {
  reason: string;
  dataDir: string;
  /** 后台进程登记簿（检查点清单与终止都走它） */
  background: BackgroundProcesses;
  /** 停止接新工作：关监听、停调度 */
  stopAcceptingNewWork: () => Promise<void> | void;
  /** 真实状态读取（写检查点用）：这一刻还在接新工作吗 */
  acceptingNewWork: () => boolean;
  /** 收尾在飞回合并等存储写入落盘 */
  closeStorage: () => Promise<void> | void;
  /** 释放单实例锁 */
  releaseLock: () => Promise<void> | void;
  lockSnapshot?: () => InstanceLockInfo | undefined;
  /** 单步超时（默认 15s）：停机不允许被某一步无限拖住 */
  stepTimeoutMs?: number;
  log?: (line: string) => void;
}

export async function runShutdownSequence(deps: ShutdownDeps): Promise<ShutdownReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const startedAt = Date.now();
  const steps: ShutdownStep[] = [];
  const trace = new JsonlLog<ShutdownStep>(join(deps.dataDir, LIFECYCLE_DIR));
  const checkpointFile = join(deps.dataDir, LIFECYCLE_DIR, CHECKPOINT_FILE);
  let background: BackgroundTermination = { terminated: [], failures: [] };

  const record = async (entry: ShutdownStep): Promise<void> => {
    steps.push(entry);
    // 台账写不进去不能反过来阻断停机
    await trace.append(STEPS_KEY, entry).catch(() => undefined);
    const summary = `${entry.step}${entry.detail ? `（${entry.detail}）` : ''}${entry.error ? ` ✗ ${entry.error}` : ''}`;
    log(`停机：${summary}`);
  };

  const runStep = async (
    step: ShutdownStepName,
    action: () => Promise<void> | void,
    detail?: string,
  ): Promise<void> => {
    const at = Date.now();
    try {
      await withTimeout(action(), deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS, step);
      await record({ step, at, ...(detail ? { detail } : {}) });
    } catch (error) {
      await record({
        step,
        at,
        ...(detail ? { detail } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // 1. 停止接新工作
  await runStep('stop_accepting', deps.stopAcceptingNewWork, '关监听 + 停内部调度');
  // 2. 写检查点（必须先于终止：记下终止前真实在跑的后台进程）
  await runStep(
    'checkpoint',
    async () => {
      const lock = deps.lockSnapshot?.();
      const checkpoint: ShutdownCheckpoint = {
        at: Date.now(),
        pid: process.pid,
        reason: deps.reason,
        acceptingNewWork: safeAccepting(deps),
        background: deps.background.list(),
        ...(lock ? { lock } : {}),
      };
      await writeJsonAtomic(checkpointFile, checkpoint);
    },
    '后台进程清单 + 锁记录',
  );
  // 3. 终止后台进程
  await runStep(
    'terminate_background',
    async () => {
      background = deps.background.terminateAll();
      await writeJsonAtomic(join(deps.dataDir, LIFECYCLE_DIR, TERMINATION_FILE), {
        at: Date.now(),
        ...background,
      });
    },
    'Shell 进程组 / 后台工人',
  );
  // 4. 收尾在飞回合 → 等存储落盘 → 补一次后台清场（收尾期间可能又起了进程）
  await runStep(
    'close_storage',
    async () => {
      await deps.closeStorage();
      const leftover = deps.background.terminateAll();
      background = {
        terminated: [...background.terminated, ...leftover.terminated],
        failures: [...background.failures, ...leftover.failures],
      };
    },
    '等在飞回合与写入落盘',
  );
  // 5. 释放锁：最后一步
  await runStep('release_lock', deps.releaseLock, '单实例锁');

  return {
    reason: deps.reason,
    startedAt,
    endedAt: Date.now(),
    steps,
    background,
    checkpointFile,
  };
}

/**
 * 装 SIGTERM / SIGINT 处理器（服务端入口与故障夹具用同一条路径）。
 * - 第一次信号：跑完整停机顺序，然后退出；
 * - 第二次信号：用户等不及了，立即退出（不让收尾无限期挂着）；
 * - 返回卸载函数（测试用）。
 */
export function installShutdownHandlers(
  handle: { close: () => Promise<ShutdownReport | void> },
  options: {
    signals?: NodeJS.Signals[];
    exit?: (code: number) => void;
    onReport?: (report: ShutdownReport | void) => void;
  } = {},
): () => void {
  const signals = options.signals ?? (['SIGINT', 'SIGTERM'] as NodeJS.Signals[]);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const listeners = new Map<NodeJS.Signals, () => void>();
  let handling = false;

  for (const signal of signals) {
    const listener = (): void => {
      if (handling) {
        console.error(`再次收到 ${signal}：不再等收尾，立即退出`);
        exit(1);
        return;
      }
      handling = true;
      console.log(`收到 ${signal}：开始优雅停机（停新工作 → 检查点 → 终止后台进程 → 关存储 → 放锁）`);
      Promise.resolve()
        .then(() => handle.close())
        .then((report) => {
          options.onReport?.(report);
          printShutdownReport(report);
          exit(0);
        })
        .catch((error: unknown) => {
          console.error(
            `停机失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
          );
          exit(1);
        });
    };
    process.on(signal, listener);
    listeners.set(signal, listener);
  }

  return () => {
    for (const [signal, listener] of listeners) process.off(signal, listener);
  };
}

export function printShutdownReport(report: ShutdownReport | void): void {
  if (!report) return;
  const terminated = report.background.terminated.length;
  const failures = report.background.failures.length;
  console.log(
    `停机完成：${report.steps.length} 步，终止后台进程 ${terminated} 个${failures > 0 ? `，失败 ${failures} 个` : ''}`,
  );
  for (const failure of report.background.failures) console.error(`  后台进程终止失败：${failure}`);
  for (const step of report.steps.filter((item) => item.error)) {
    console.error(`  步骤失败：${step.step} —— ${step.error}`);
  }
}

function safeAccepting(deps: ShutdownDeps): boolean {
  try {
    return deps.acceptingNewWork();
  } catch {
    // 读不到状态时按「还在接活」记：宁可让重启核对偏向保守
    return true;
  }
}

function withTimeout<T>(value: T | Promise<T>, timeoutMs: number, what: string): Promise<void> {
  return new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${what} 超过 ${timeoutMs}ms 未完成`)), timeoutMs);
    Promise.resolve(value).then(
      () => {
        clearTimeout(timer);
        done();
      },
      (error: unknown) => {
        clearTimeout(timer);
        fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
