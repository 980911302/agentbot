import { strict as assert } from 'node:assert';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { InteractionBroker } from '../src/interaction/broker.js';
import { InteractionCancelledError, InteractionTimeoutError } from '../src/interaction/types.js';
import { SecretStore } from '../src/secret/store.js';

/** 覆盖《工具与能力.md》第 1 节：卡片交互与密钥框 */
describe('交互代理', () => {
  it('界面作答后工具拿到答案', async () => {
    const broker = new InteractionBroker();
    const promise = broker.request({
      kind: 'choice',
      question: '建到哪个群？',
      options: [{ id: 'opt1', label: '白泽联调' }],
      agentId: 'a',
      agentName: '测试运维',
    });

    const [pending] = broker.list();
    assert.ok(pending, '应该有一条等待中的交互');
    assert.equal(pending.question, '建到哪个群？');
    assert.equal(broker.size, 1);

    broker.resolve(pending.id, { value: 'opt1' });
    const answer = await promise;
    assert.equal(answer.value, 'opt1');
    assert.equal(broker.size, 0, '解决后不该留在表里');
  });

  it('超时按「用户没答」处理', async () => {
    const broker = new InteractionBroker();
    await assert.rejects(
      () =>
        broker.request({
          kind: 'choice',
          question: '要不要继续？',
          options: [
            { id: 'y', label: '要' },
            { id: 'n', label: '不要' },
          ],
          agentId: 'a',
          agentName: '测试运维',
          timeoutMs: 30,
        }),
      InteractionTimeoutError,
    );
  });

  it('回合取消（abort）会让等待中的交互失败', async () => {
    const broker = new InteractionBroker();
    const controller = new AbortController();
    const promise = broker.request({
      kind: 'choice',
      question: '选一个',
      options: [{ id: 'a', label: 'A' }],
      agentId: 'a',
      agentName: '测试运维',
      signal: controller.signal,
    });

    controller.abort();
    await assert.rejects(() => promise, InteractionCancelledError);
    assert.equal(broker.size, 0);
  });

  it('已经 abort 的信号立即失败，不留悬挂状态', async () => {
    const broker = new InteractionBroker();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () =>
        broker.request({
          kind: 'choice',
          question: 'x',
          options: [{ id: 'a', label: 'A' }],
          agentId: 'a',
          agentName: 'A',
          signal: controller.signal,
        }),
      InteractionCancelledError,
    );
    assert.equal(broker.size, 0);
  });

  it('取消接口可用', async () => {
    const broker = new InteractionBroker();
    const promise = broker.request({
      kind: 'secret',
      question: '给个 token',
      name: 'github_token',
      agentId: 'a',
      agentName: 'A',
    });
    const [pending] = broker.list();
    assert.ok(pending);
    assert.equal(broker.cancel(pending.id), true);
    await assert.rejects(() => promise, InteractionCancelledError);
  });

  it('对不存在的 id 作答返回 false', () => {
    const broker = new InteractionBroker();
    assert.equal(broker.resolve('nope', { value: 'x' }), false);
    assert.equal(broker.cancel('nope'), false);
  });

  it('可以按 agentId 过滤正在等待的交互', async () => {
    const broker = new InteractionBroker();
    const p1 = broker.request({
      kind: 'choice',
      question: 'A 的问题',
      options: [{ id: 'x', label: 'X' }],
      agentId: 'agent-a',
      agentName: 'A',
    });
    const p2 = broker.request({
      kind: 'choice',
      question: 'B 的问题',
      options: [{ id: 'x', label: 'X' }],
      agentId: 'agent-b',
      agentName: 'B',
    });

    assert.equal(broker.list({ agentId: 'agent-a' }).length, 1);
    assert.equal(broker.list({ agentId: 'agent-b' })[0]?.question, 'B 的问题');
    assert.equal(broker.list().length, 2);

    for (const item of broker.list()) broker.resolve(item.id, { value: 'x' });
    await Promise.all([p1, p2]);
  });
});

describe('密钥存储', () => {
  let dir: string;
  let store: SecretStore;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'secrets-'));
    store = new SecretStore(dir);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('存进去之后能按名字取回', async () => {
    await store.put('github_token', 'ghp_secret_value');
    assert.equal(await store.read('github_token'), 'ghp_secret_value');
  });

  it('列名字时不含值', async () => {
    const names = await store.names();
    assert.ok(names.includes('github_token'));
    assert.ok(!names.some((name) => name.includes('ghp_')));
  });

  it('put 的返回值不回带明文', async () => {
    const record = await store.put('another', 'value-here');
    assert.equal(record.value, '', '返回值不该带明文');
  });

  it('同名覆盖', async () => {
    await store.put('github_token', 'new_value');
    assert.equal(await store.read('github_token'), 'new_value');
    assert.equal((await store.names()).filter((n) => n === 'github_token').length, 1);
  });

  it('文件权限是 0600', async () => {
    const info = await stat(join(dir, 'secrets.json'));
    assert.equal(info.mode & 0o777, 0o600, '密钥文件不该让同机其他用户读到');
  });

  it('拒绝空名字 / 空值', async () => {
    await assert.rejects(() => store.put('  ', 'x'));
    await assert.rejects(() => store.put('name', ''));
  });

  it('删除', async () => {
    assert.equal(await store.remove('another'), true);
    assert.equal(await store.remove('another'), false);
    assert.equal(await store.read('another'), undefined);
  });
});
