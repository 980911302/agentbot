import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const writes = new Map<string, Promise<void>>();
let tempSequence = 0;

export function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

/**
 * 同一文件串行、同目录临时文件 + rename 替换。
 * payload 在入队前就做快照，后来的写一定最后落盘，避免旧快照反覆盖新状态。
 */
export async function writeJsonAtomic(
  file: string,
  value: unknown,
  options: { mode?: number } = {},
): Promise<void> {
  const payload = JSON.stringify(value, null, 2);
  const previous = writes.get(file)?.catch(() => undefined) ?? Promise.resolve();
  const sequence = ++tempSequence;
  const pending = previous.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${sequence}.tmp`;
    try {
      await writeFile(temp, payload, { encoding: 'utf8', ...(options.mode ? { mode: options.mode } : {}) });
      await rename(temp, file);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  });
  writes.set(file, pending);
  try {
    await pending;
  } finally {
    if (writes.get(file) === pending) writes.delete(file);
  }
}
