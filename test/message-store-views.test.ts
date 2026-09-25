import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonlLog } from '../src/storage/jsonl-log.js';
import { MessageStore } from '../src/store/messages.js';
import { tempDataDir } from './fakes/test-env.js';
import type { Message } from '../src/agent/types.js';

/** OPT-02：只读视图 / 尾部读取 / byRun 过滤 / 缓存淘汰后重新加载 */
const message = (id: number, runId: string, role: Message['role'] = 'assistant'): Message => ({
  id: `m-${id}`, agentId: 'a', role, createdAt: id, runId,
  content: { type: 'text', text: `第 ${id} 条` },
  ...(role === 'user' ? { source: 'user' as const } : {}),
});

describe('JsonlLog 只读视图与尾部读取（OPT-02）', () => {
  it('view 不拷贝、tail 只复制尾部、filter 按谓词过滤', async () => {
    const env = await tempDataDir('jsonl-views');
    try {
      const log = new JsonlLog<{ id: number; tag?: string }>(env.dir);
      for (let i = 1; i <= 5; i++) await log.append('k', { id: i, tag: i % 2 ? 'odd' : 'even' });

      const view = await log.view('k');
      assert.equal(view.length, 5);
      const copied = await log.list('k');
      assert.notEqual(copied, view, 'list 仍然是拷贝，view 是同一份');
      assert.equal(await log.view('k'), view, 'view 每次给同一份数组');

      assert.deepEqual((await log.tail('k', 2)).map((item) => item.id), [4, 5]);
      assert.deepEqual((await log.tail('k', 0)), []);
      assert.deepEqual((await log.tail('k', 99)).map((item) => item.id), [1, 2, 3, 4, 5]);
      assert.deepEqual((await log.filter('k', (item) => item.tag === 'odd')).map((item) => item.id), [1, 3, 5]);
    } finally { await env.cleanup(); }
  });

  it('缓存淘汰后重新加载仍是同一份数据（LRU 上限可配）', async () => {
    const env = await tempDataDir('jsonl-lru');
    try {
      const log = new JsonlLog<{ id: number }>(env.dir, { cacheMaxKeys: 2 });
      for (const key of ['a', 'b', 'c']) await log.append(key, { id: 1 });
      assert.deepEqual(log.cachedKeys().sort(), ['b', 'c'], '最久未访问的 a 被淘汰');
      assert.deepEqual((await log.view('a')).map((item) => item.id), [1], '淘汰后重新读盘，数据不丢');

      // 主动丢弃缓存 → 下次读盘
      log.drop('c');
      assert.ok(!log.cachedKeys().includes('c'));
      await appendFile(join(env.dir, 'c.jsonl'), `${JSON.stringify({ id: 2 })}\n`);
      assert.deepEqual((await log.view('c')).map((item) => item.id), [1, 2], '重新加载能读到外部追加的内容');
    } finally { await env.cleanup(); }
  });
});

describe('MessageStore 按需读取（OPT-02）', () => {
  it('list/recent/latestUser/count/olderThan 行为不变，byRun 只取该回合', async () => {
    const env = await tempDataDir('message-store');
    try {
      const store = new MessageStore(env.dir);
      await store.append(message(1, 'run-a', 'user'));
      await store.append(message(2, 'run-a'));
      await store.append(message(3, 'run-b', 'user'));
      await store.append(message(4, 'run-b'));

      assert.deepEqual((await store.list('a')).map((m) => m.id), ['m-1', 'm-2', 'm-3', 'm-4']);
      assert.deepEqual((await store.list('a', 2)).map((m) => m.id), ['m-3', 'm-4']);
      assert.deepEqual((await store.recent('a', 2)).map((m) => m.id), ['m-3', 'm-4']);
      assert.deepEqual((await store.recent('a', 2, 'm-4')).map((m) => m.id), ['m-2', 'm-3']);
      assert.deepEqual((await store.byRun('a', 'run-b')).map((m) => m.id), ['m-3', 'm-4']);
      assert.deepEqual((await store.byRun('a', 'run-a')).map((m) => m.id), ['m-1', 'm-2']);
      assert.deepEqual((await store.byRun('a', 'run-none')), []);
      assert.equal((await store.latestUser('a'))?.id, 'm-3');
      assert.equal(await store.count('a'), 4);
      assert.deepEqual((await store.olderThan('a', 2, 0)).map((m) => m.id), ['m-1', 'm-2']);

      // appendIfAbsent 仍然幂等，且冲突时报错
      assert.equal(await store.appendIfAbsent(message(1, 'run-a', 'user')), false);
      await assert.rejects(() => store.appendIfAbsent({ ...message(1, 'run-a', 'user'), content: { type: 'text', text: '改了' } }), /MESSAGE_ID_CONFLICT/);

      await store.clear('a');
      assert.equal(await store.count('a'), 0);
    } finally { await env.cleanup(); }
  });

  it('尾部读取不受行数影响：只看末尾，不整条线拷贝', async () => {
    const env = await tempDataDir('message-tail');
    try {
      const dir = join(env.dir, 'messages');
      await mkdir(dir, { recursive: true });
      const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify(message(i + 1, 'run-x'))).join('\n');
      await writeFile(join(dir, 'a.jsonl'), `${lines}\n`);

      const store = new MessageStore(env.dir);
      const tail = await store.list('a', 3);
      assert.deepEqual(tail.map((m) => m.id), ['m-4998', 'm-4999', 'm-5000']);
      assert.equal(await store.count('a'), 5000);
      assert.deepEqual((await store.byRun('a', 'run-x')).length, 5000);
    } finally { await env.cleanup(); }
  });
});
