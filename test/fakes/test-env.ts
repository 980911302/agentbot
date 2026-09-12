import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 共享测试夹具（E1.6）：隔离环境与异步等待工具。
 *
 * tempDataDir：mkdtemp 的语义化包装，测试绝不读写用户的 .agentbot。
 * waitFor：轮询断言，超时给可读错误。
 * latch：事件门闩——把"等某个回调发生"从 sleep 换成确定性的 await。
 */

export async function tempDataDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${what}`);
    await sleep(20);
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface Latch {
  readonly promise: Promise<void>;
  release: () => void;
}

export function createLatch(): Latch {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
