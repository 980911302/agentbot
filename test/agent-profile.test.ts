import { strict as assert } from 'node:assert';
import { mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resolveAvatarFile, writeAvatarFile, removeAvatarFile } from '../src/agent/avatar-store.js';
import { agentAvatarUrl } from '../web/src/features/agents/avatar-view.js';
import { createAgentServer, type AgentServerHandle } from '../src/server/http.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';
import { tinyPngBytes, tinyPngDataUrl } from './fakes/avatar-fixture.js';

/**
 * E5.1 同事资料统一：name / title / description / instructions 分开，
 * 界面接口（/api/bots、/api/agents）与工具（update_state）走同一个资料服务，
 * 头像落数据目录的头像目录、经资源接口展示，clear 有明确清空语义。
 */
describe('同事资料统一（E5.1）', () => {
  let env: { dir: string; cleanup: () => Promise<void> };
  let server: AgentServerHandle;
  let base: string;
  let agentId: string;

  const api = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
  const jsonPatch = (path: string, body: unknown) =>
    api(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jsonPost = (path: string, body: unknown) =>
    api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const readAgent = async (id = agentId) => {
    const response = await api(`/api/agents/${id}`);
    assert.equal(response.status, 200);
    const data = (await response.json()) as { agent: Record<string, string | null> };
    return data.agent;
  };

  before(async () => {
    env = await tempDataDir('agent-profile');
    server = await createAgentServer({
      port: 0,
      dataDir: env.dir,
      rootDir: process.cwd(),
      allowMissingKey: true,
      createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('好') }),
    });
    base = server.url.replace(/\/$/, '');
    const created = await jsonPost('/api/bots', { name: '资料同事', instructions: '原职责' });
    assert.equal(created.status, 201);
    agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
  });

  after(async () => {
    await server.close();
    await env.cleanup();
  });

  it('name / title / description / instructions 四个字段分开，改一个不碰另一个', async () => {
    await jsonPatch(`/api/agents/${agentId}`, { title: '联调负责人' });
    let agent = await readAgent();
    assert.equal(agent.title, '联调负责人');
    assert.equal(agent.description, '', 'description 不该被 title 顶替');
    assert.equal(agent.instructions, '原职责', 'instructions 不该被 title 顶替');

    await jsonPatch(`/api/agents/${agentId}`, { description: '负责接口联调与验收' });
    agent = await readAgent();
    assert.equal(agent.title, '联调负责人', 'description 写入不该动 title');
    assert.equal(agent.description, '负责接口联调与验收');
    assert.equal(agent.instructions, '原职责', 'description 不再写进 instructions');

    await jsonPatch(`/api/agents/${agentId}`, { instructions: '你是联调负责人：先看契约再动手。' });
    agent = await readAgent();
    assert.equal(agent.instructions, '你是联调负责人：先看契约再动手。');
    assert.equal(agent.description, '负责接口联调与验收', 'instructions 写入不该动 description');

    await jsonPatch(`/api/agents/${agentId}`, { name: '联调同事' });
    agent = await readAgent();
    assert.equal(agent.name, '联调同事');
    assert.equal(agent.title, '联调负责人');
    assert.equal(agent.description, '负责接口联调与验收');
  });

  it('界面接口与 update_state 改的是同一份资料（工具改完，界面立刻读到）', async () => {
    const tool = server.runtime.tools.find((item) => item.name === 'update_state');
    assert.ok(tool, 'update_state 应该在工具面里');
    const context = {
      agentId,
      projectIds: [],
      turnState: { workbench: { agentsCreated: 0, roomsCreated: 0 } },
    };
    await tool.execute(
      { target: 'profile', action: 'set', title: '工具写的头衔', description: '工具写的简介' },
      context as never,
    );

    const agent = await readAgent();
    assert.equal(agent.title, '工具写的头衔');
    assert.equal(agent.description, '工具写的简介');
    // 同一份：界面接口再改一次，工具下次读到的也是新值
    await jsonPatch(`/api/agents/${agentId}`, { title: '界面改的头衔' });
    assert.equal((await readAgent()).title, '界面改的头衔');
    assert.equal(join(server.runtime.dataDir), env.dir);
  });

  it('头像：上传落盘在数据目录的头像目录，资源接口回原字节', async () => {
    const before = await readAgent();
    assert.equal(before.avatarUrl, null, '还没上传时不该有资源地址');

    const response = await jsonPost(`/api/agents/${agentId}/avatar`, { dataUrl: tinyPngDataUrl() });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { agent: { avatar: string }; avatarUrl: string };
    assert.match(payload.agent.avatar, /^avatars\/[A-Za-z0-9-]+\.png$/);
    assert.equal(payload.avatarUrl, `/api/agents/${agentId}/avatar?v=${(await readAgent()).updatedAt}`);

    // 文件真的在数据目录的头像目录下
    const onDisk = await stat(join(env.dir, payload.agent.avatar));
    assert.equal(onDisk.isFile(), true);
    assert.deepEqual(
      Buffer.from(await (await api(`/api/agents/${agentId}/avatar`)).arrayBuffer()),
      tinyPngBytes(),
    );

    const image = await api(`/api/agents/${agentId}/avatar`);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');

    // 两套接口都报同一个资源地址
    const bots = (await (await api('/api/bots')).json()) as {
      bots: Array<{ id: string; avatarUrl: string | null }>;
    };
    const listed = bots.bots.find((item) => item.id === agentId);
    assert.equal(listed?.avatarUrl, payload.avatarUrl);
  });

  it('「未传」不碰头像；avatar=null 主动清空：文件删除 + 字段置空', async () => {
    const uploaded = await readAgent();
    assert.match(String(uploaded.avatar), /^avatars\//);
    const file = join(env.dir, String(uploaded.avatar));

    // 只改名字：头像文件与字段都不动
    await jsonPatch(`/api/agents/${agentId}`, { name: '改名不动头像' });
    const untouched = await readAgent();
    assert.equal(untouched.avatar, uploaded.avatar, '未传 avatar 时字段不该变');
    assert.equal((await stat(file)).isFile(), true, '未传 avatar 时文件不该被删');

    // 明确清空
    const cleared = await jsonPatch(`/api/agents/${agentId}`, { avatar: null });
    assert.equal(cleared.status, 200);
    const after = await readAgent();
    assert.equal(after.avatar, '', '清空后字段应为空串');
    assert.equal(after.avatarUrl, null);
    await assert.rejects(() => stat(file), '清空后头像文件应该真的没了');
    const missing = await api(`/api/agents/${agentId}/avatar`);
    assert.equal(missing.status, 404);
  });

  it('头像资源接口拒绝跨站来源（bug_yc9t7bf99uf1 的教训）', async () => {
    await jsonPost(`/api/agents/${agentId}/avatar`, { dataUrl: tinyPngDataUrl() });

    const crossSite = await api(`/api/agents/${agentId}/avatar`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(((await crossSite.json()) as { code: string }).code, 'FORBIDDEN_ORIGIN');

    const foreign = await api(`/api/agents/${agentId}/avatar`, {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(foreign.status, 403);

    // 本应用自己的 Origin 放行
    const own = await api(`/api/agents/${agentId}/avatar`, {
      headers: { origin: base, 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(own.status, 200);
  });

  it('头像资源接口不能变成任意文件读取', async () => {
    // 1) HTTP 不接受本机路径（只收 data URL）：否则浏览器能让服务端读任意图片再读回来
    const hostile = await jsonPatch(`/api/agents/${agentId}`, { avatar: '/etc/hosts' });
    assert.equal(hostile.status, 400);
    assert.match(((await hostile.json()) as { error: string }).error, /data URL/);

    // 2) 头像目录里指向外面的软链：真实路径不在头像目录，一律当作没有
    await mkdir(join(env.dir, 'avatars'), { recursive: true });
    await writeFile(join(env.dir, 'outside.png'), Buffer.from('NOT-AN-AVATAR'));
    await symlink(join(env.dir, 'outside.png'), join(env.dir, 'avatars', 'escape.png'));
    await server.runtime.registry.update(agentId, { avatar: 'avatars/escape.png' });
    const escaped = await api(`/api/agents/${agentId}/avatar`);
    assert.equal(escaped.status, 404);
    assert.doesNotMatch(await escaped.text(), /NOT-AN-AVATAR/);

    // 3) 引用里带路径分隔符 / 绝对路径：连引用形状都不合法
    for (const ref of ['avatars/../outside.png', 'avatars/../../etc/hosts', '/etc/hosts', 'outside.png']) {
      assert.equal(await resolveAvatarFile(env.dir, ref), undefined, ref);
    }

    // 收尾：把头像恢复成正常的一张，别把软链留在记录里影响后面的用例
    const restored = await jsonPost(`/api/agents/${agentId}/avatar`, { dataUrl: tinyPngDataUrl() });
    assert.equal(restored.status, 200);
  });

  it('历史数据兼容：avatar 是 emoji 时不当作图片，正常上传仍能覆盖', async () => {
    await server.runtime.registry.update(agentId, { avatar: '🛠' });
    const legacy = await readAgent();
    assert.equal(legacy.avatar, '🛠', '旧值原样保留');
    assert.equal(legacy.avatarUrl, null, '非资源引用不给图片地址');
    assert.equal((await api(`/api/agents/${agentId}/avatar`)).status, 404);

    const uploaded = await jsonPost(`/api/agents/${agentId}/avatar`, { dataUrl: tinyPngDataUrl() });
    assert.equal(uploaded.status, 200);
    const replaced = await readAgent();
    assert.match(String(replaced.avatar), /^avatars\//);
    assert.notEqual(replaced.avatarUrl, null);
  });

  it('bots 是兼容接口：字段与 agents 一致，写操作委托同一个资料服务', async () => {
    // 走 bots（历史接口，含 role 别名）
    const viaBots = await jsonPatch(`/api/bots/${agentId}`, {
      title: '兼容接口的头衔',
      description: '兼容接口的简介',
      role: '兼容接口的职责',
    });
    assert.equal(viaBots.status, 200);
    const payload = (await viaBots.json()) as {
      agent: { title: string; description: string; instructions: string };
      bot: { title: string; description: string; instructions: string };
    };
    assert.deepEqual(
      {
        title: payload.agent.title,
        description: payload.agent.description,
        instructions: payload.agent.instructions,
      },
      { title: '兼容接口的头衔', description: '兼容接口的简介', instructions: '兼容接口的职责' },
    );
    assert.equal(payload.bot.instructions, '兼容接口的职责');

    // 走 agents（统一接口）：同一份数据
    await jsonPatch(`/api/agents/${agentId}`, { title: '统一接口的头衔' });
    const readBack = await readAgent();
    assert.equal(readBack.title, '统一接口的头衔');
    assert.equal(readBack.description, '兼容接口的简介', '两个接口改的是同一份');
    assert.equal(readBack.instructions, '兼容接口的职责');

    const viaBotsAgain = (await (await api(`/api/bots/${agentId}`)).json()) as {
      bot: { title: string; description: string; instructions: string; avatarUrl: string | null };
    };
    assert.equal(viaBotsAgain.bot.title, '统一接口的头衔');
    assert.equal(viaBotsAgain.bot.description, '兼容接口的简介');
  });
});

describe('头像落盘与引用（E5.1 单元）', () => {
  it('removeAvatarFile 只删头像目录内的合法引用', async () => {
    const env = await tempDataDir('avatar-store');
    try {
      const ref = await writeAvatarFile(env.dir, tinyPngBytes(), '.png');
      assert.match(ref, /^avatars\//);
      assert.equal((await stat(join(env.dir, ref))).isFile(), true);
      assert.equal(await removeAvatarFile(env.dir, ref), true);
      await assert.rejects(() => stat(join(env.dir, ref)));

      assert.equal(await removeAvatarFile(env.dir, '../../etc/hosts'), false);
      assert.equal(await removeAvatarFile(env.dir, '/etc/hosts'), false);
      assert.equal(await removeAvatarFile(env.dir, 'avatars/nope.png'), false);
    } finally {
      await env.cleanup();
    }
  });
});

describe('前端头像地址（E5.1 单元）', () => {
  it('服务端给了 avatarUrl 就用它；否则按引用自己拼（带 updatedAt 版本）', () => {
    const id = 'a1';
    assert.equal(agentAvatarUrl({ id, avatar: '🛠' }), null, 'emoji / 绝对路径不当作图片');
    assert.equal(agentAvatarUrl({ id }), null);
    assert.equal(
      agentAvatarUrl({ id, avatar: 'avatars/x.png', updatedAt: '2026-01-01T00:00:00.000Z' }),
      `/api/agents/${id}/avatar?v=${encodeURIComponent('2026-01-01T00:00:00.000Z')}`,
    );
    assert.equal(agentAvatarUrl({ id, avatar: 'avatars/x.png' }), `/api/agents/${id}/avatar`);
    assert.equal(
      agentAvatarUrl({ id, avatar: 'avatars/x.png', avatarUrl: '/api/agents/a1/avatar?v=9' }),
      '/api/agents/a1/avatar?v=9',
      '服务端地址优先（App 拼快照时可能没带上，兜底才走上面那条）',
    );
    assert.equal(agentAvatarUrl({ id, avatar: 'avatars/../secret.png' }), null, '非法引用不给地址');
  });
});
