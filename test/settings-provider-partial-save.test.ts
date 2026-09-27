import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAgentServer } from '../src/server/http.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

/**
 * 模型设置页改成「一项一项即时保存」后，请求里只带改动的字段。
 * 服务端不能把没带的字段当成默认值写回去——以前没带 enabled 就按 true 存，
 * 停用的服务商一改名、一改地址就被悄悄重新启用。
 */
describe('服务商局部保存不改动没带的字段', () => {
  it('停用后只改名称/地址，仍保持停用；新建服务商默认启用', async () => {
    const env = await tempDataDir('settings-partial-save');
    const server = await createAgentServer({
      port: 0,
      dataDir: env.dir,
      rootDir: process.cwd(),
      createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('收到') }),
      allowMissingKey: true,
    });
    const save = async (provider: Record<string, unknown>) => {
      const res = await fetch(`${server.url}api/settings/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'save_provider', provider }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        providers: Array<{ id: string; name: string; enabled: boolean; baseURL: string }>;
      };
      return body.providers.find((item) => item.id === provider.id)!;
    };
    try {
      const created = await save({
        id: 'p_local',
        name: '本地',
        baseURL: 'http://127.0.0.1:8000/v1',
        models: [{ id: 'm1', model: 'step-5-preview', name: 'step-5-preview' }],
      });
      assert.equal(created.enabled, true, '新建默认启用');
      assert.equal((await save({ id: 'p_local', enabled: false })).enabled, false);
      const renamed = await save({ id: 'p_local', name: '本地 Step' });
      assert.equal(renamed.name, '本地 Step');
      assert.equal(renamed.enabled, false, '只改名不能把停用的服务商重新启用');
      const moved = await save({ id: 'p_local', baseURL: 'http://127.0.0.1:9000/v1' });
      assert.equal(moved.baseURL, 'http://127.0.0.1:9000/v1');
      assert.equal(moved.enabled, false);
    } finally {
      await server.close();
      await env.cleanup();
    }
  });
});
