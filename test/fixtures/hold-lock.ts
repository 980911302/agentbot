/**
 * 故障测试夹具（E3.6）：真实子进程占住数据目录的单实例锁。
 *
 * 用法：node --import tsx test/fixtures/hold-lock.ts <dataDir>
 * 占住后打印 LOCK_HELD，等父进程杀掉（模拟另一个还在跑的后端）。
 */
import { DataDirLock } from '../../src/storage/instance-lock.js';

const [dir] = process.argv.slice(2);
if (!dir) {
  console.error('用法：hold-lock.ts <dataDir>');
  process.exit(2);
}

const lock = new DataDirLock(dir);
const info = await lock.acquire();
console.log(`LOCK_HELD pid=${info.pid}`);
setTimeout(() => process.exit(0), 30_000);
