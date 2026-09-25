import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentServer } from '../src/server/http.js';
import { AgentRuntime } from '../src/server/runtime.js';
import { SettingsStore, isValidTimezone } from '../src/settings/store.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

/** E5.7：主人名等设置落数据目录，CLI / 界面 / 群消息读同一份 */
async function startServer(dataDir: string) {
  const server = await createAgentServer({
    port: 0,
    dataDir,
    rootDir: process.cwd(),
    allowMissingKey: true,
    createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('好') }),
  });
  return { ...server, base: server.url.replace(/\/$/, '') };
}

describe('SettingsStore（E5.7）', () => {
  it('默认值来自配置；update 后落盘，重新打开读得回', async () => {
    const env = await tempDataDir('settings-store');
    try {
      const store = new SettingsStore(env.dir, { ownerName: '默认主人' });
      await store.load();
      assert.equal(store.ownerName, '默认主人');
      assert.equal(store.current().timezone, '');
      assert.deepEqual(store.current().notifications, { done: true, blocked: true, needsAction: true });

      await store.update({
        ownerName: '张林林',
        timezone: 'Asia/Shanghai',
        language: 'zh-CN',
        notifications: { done: false },
      });
      const raw = JSON.parse(await readFile(join(env.dir, 'settings', 'preferences.json'), 'utf8')) as {
        ownerName: string;
      };
      assert.equal(raw.ownerName, '张林林');

      const reopened = new SettingsStore(env.dir, { ownerName: '默认主人' });
      await reopened.load();
      assert.equal(reopened.ownerName, '张林林');
      assert.equal(reopened.current().timezone, 'Asia/Shanghai');
      assert.equal(reopened.current().notifications.done, false);
      assert.equal(reopened.current().notifications.blocked, true, '只改传入的字段');
    } finally {
      await env.cleanup();
    }
  });

  it('非法值明确报错，不静默兜底', async () => {
    const env = await tempDataDir('settings-invalid');
    try {
      const store = new SettingsStore(env.dir, { ownerName: '主人' });
      await store.load();
      await assert.rejects(() => store.update({ ownerName: '   ' }), /主人名不能为空/);
      await assert.rejects(() => store.update({ ownerName: 'x'.repeat(61) }), /最多 60 个字符/);
      await assert.rejects(() => store.update({ timezone: 'Asia/Shangai' }), /时区无法识别/);
      assert.equal(store.ownerName, '主人', '报错后当前值不变');
      assert.equal(isValidTimezone('Asia/Shanghai'), true);
      assert.equal(isValidTimezone(''), true, '空 = 跟随系统');
    } finally {
      await env.cleanup();
    }
  });

  it('文件损坏时抛 SETTINGS_UNREADABLE，不假装回到默认值', async () => {
    const env = await tempDataDir('settings-broken');
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(join(env.dir, 'settings'), { recursive: true });
      await writeFile(join(env.dir, 'settings', 'preferences.json'), '{坏掉的 JSON');
      const store = new SettingsStore(env.dir, { ownerName: '主人' });
      await assert.rejects(
        () => store.load(),
        (error: unknown) => (error as { code?: string }).code === 'SETTINGS_UNREADABLE',
      );
    } finally {
      await env.cleanup();
    }
  });
});

describe('主人名统一（E5.7 验收标准 1）', () => {
  it('改主人名后：CLI 与群消息的显示名一致，health 也报同一个', async () => {
    const env = await tempDataDir('settings-owner');
    try {
      const server = await startServer(env.dir);
      const base = server.base;
      try {
        const initial = (await (await fetch(`${base}/api/health`)).json()) as { ownerName: string };
        assert.equal(initial.ownerName, server.runtime.ownerName());

        // 通过接口改主人名（设置页走的就是这条）
        const saved = await fetch(`${base}/api/settings/preferences`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ownerName: '林林主人' }),
        });
        assert.equal(saved.status, 200);
        assert.equal(
          ((await saved.json()) as { preferences: { ownerName: string } }).preferences.ownerName,
          '林林主人',
        );

        // 1) 界面/健康检查读到的就是新名字
        const after = (await (await fetch(`${base}/api/health`)).json()) as { ownerName: string };
        assert.equal(after.ownerName, '林林主人');

        // 2) 群消息里的发送者名字也是它（不带 per-request ownerName 时）
        const agent = await server.runtime.registry.create({ name: '群里的同事', instructions: '测试' });
        const room = await server.runtime.rooms.create({ name: '主人名核对群', memberIds: [agent.id] });
        await fetch(`${base}/api/rooms/${room.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: '用新名字说一句', clientMessageId: 'owner-name-check' }),
        });
        const timeline = await server.runtime.rooms.messages(room.id);
        const userLine = timeline.find((item) => item.senderKind === 'user');
        assert.equal(userLine?.senderName, '林林主人', '群时间线里的主人名要与设置一致');

        // 3) CLI 入口用同一个数据目录时拿到同一个名字
        const fromCli = new SettingsStore(env.dir, { ownerName: '环境变量里的旧名字' });
        await fromCli.load();
        assert.equal(fromCli.ownerName, '林林主人', 'CLI 读数据目录的设置，而不是环境变量默认值');
      } finally {
        await server.close();
      }
    } finally {
      await env.cleanup();
    }
  });

  it('没有 settings 时回落到构造配置（不传该依赖的调用方行为不变）', async () => {
    const env = await tempDataDir('settings-fallback');
    try {
      const runtime = new AgentRuntime({
        dataDir: env.dir,
        tools: [],
        createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('x') }),
        defaultModel: 'fake',
        knownModels: ['fake'],
        budget: DEFAULT_BUDGET,
        memoryExtraction: false,
        ownerName: '只有配置的主人',
      });
      assert.equal(runtime.ownerName(), '只有配置的主人');
      assert.equal(runtime.preferences().ownerName, '只有配置的主人');
      await assert.rejects(() => runtime.updatePreferences({ ownerName: 'x' }), /没有配置主人设置存储/);
    } finally {
      await env.cleanup();
    }
  });

  it('坏设置值经接口保存会被拒（400 + 错误码）', async () => {
    const env = await tempDataDir('settings-route-invalid');
    try {
      const server = await startServer(env.dir);
      try {
        const bad = await fetch(`${server.base}/api/settings/preferences`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ timezone: 'Not/AZone' }),
        });
        assert.equal(bad.status, 400);
        assert.equal(((await bad.json()) as { code: string }).code, 'INVALID_TIMEZONE');
      } finally {
        await server.close();
      }
    } finally {
      await env.cleanup();
    }
  });
});

describe('群消息显示名以后端设置为准（E5.7 打回点回归）', () => {
  it('请求体里的旧 ownerName 不再覆盖设置：改名后带旧名发群消息，时间线仍是新名字', async () => {
    const env = await tempDataDir('settings-room-owner');
    try {
      const server = await startServer(env.dir);
      try {
        const base = server.base;
        const agent = await server.runtime.registry.create({ name: '群里的同事', instructions: '测试' });
        const room = await server.runtime.rooms.create({ name: '显示名核对群', memberIds: [agent.id] });

        // 改成新名字
        const saved = await fetch(`${base}/api/settings/preferences`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ownerName: '新主人名' }),
        });
        assert.equal(saved.status, 200);

        const send = (clientMessageId: string, body: Record<string, unknown>) =>
          fetch(`${base}/api/rooms/${room.id}/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: '来自群里的发言', clientMessageId, ...body }),
          });

        // 正例：不带 ownerName —— 用设置里的新名字
        assert.equal((await send('k-new', {})).status, 202);
        // 反例（打回点）：带一个旧窗口的 localStorage 缓存名 —— 仍必须是设置里的新名字
        assert.equal((await send('k-old', { ownerName: '旧窗口缓存名' })).status, 202);

        const timeline = await server.runtime.rooms.messages(room.id);
        const userLines = timeline.filter((item) => item.senderKind === 'user');
        assert.equal(userLines.length, 2);
        for (const line of userLines) {
          assert.equal(line.senderName, '新主人名', '群时间线里的主人名只能来自后端设置');
        }
        assert.equal(
          userLines.some((line) => line.senderName === '旧窗口缓存名'),
          false,
          '请求体的旧名字绝不能覆盖设置',
        );
      } finally {
        await server.close();
      }
    } finally {
      await env.cleanup();
    }
  });
});
