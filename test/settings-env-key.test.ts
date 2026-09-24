import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createAgentServer, type AgentServerHandle } from '../src/server/http.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

/**
 * 只在 .env / 环境变量配 Key 时，设置页必须如实显示「已配置」（bug_epxdph16hjut）。
 *
 * 原实现用 (context.runtime as any).deps?.apiKey 取环境默认值，而 AgentRuntime
 * 根本没有 deps 属性，恒为 undefined——于是设置页显示「没有 Key」，用户只改默认
 * 模型并保存后，运行时 Provider 又被换成空 Key，之后所有对话鉴权失败直到重启。
 */

const ENV_KEY = 'sk-from-dotenv-SECRET-77';
const ENV_BASE_URL = 'https://api.deepseek.com/v1';

let saved: Record<string, string | undefined> = {};

/** 只在环境里留 Key，不在设置页建任何供应商 */
async function startServer(prefix: string) {
  const env = await tempDataDir(prefix);
  let server: AgentServerHandle | undefined;
  try {
    server = await createAgentServer({
      port: 0,
      dataDir: env.dir,
      rootDir: process.cwd(),
      createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('收到') }),
      allowMissingKey: true,
    });
  } catch (error) {
    await env.cleanup();
    throw error;
  }
  return { env, server, close: async () => { await server?.close(); await env.cleanup(); } };
}

describe('设置页如实反映环境变量里的 Key', () => {
  before(() => {
    saved = { AGENT_API_KEY: process.env.AGENT_API_KEY, AGENT_BASE_URL: process.env.AGENT_BASE_URL };
    process.env.AGENT_API_KEY = ENV_KEY;
    process.env.AGENT_BASE_URL = ENV_BASE_URL;
  });

  after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('只在 .env 配 Key 时，设置页显示已配置且打码', async () => {
    const { server, close } = await startServer('settings-env-key');
    try {
      const res = await fetch(`${server.url}api/settings/model`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        config: { hasKey: boolean; apiKey: string; baseURL: string };
        providers: Array<{ apiKey: string }>;
      };
      assert.equal(body.config.hasKey, true, '环境里明明有 Key，不能显示没配置');
      assert.match(body.config.apiKey, /••••/, '回显必须打码');
      assert.ok(!body.config.apiKey.includes(ENV_KEY), '不能把明文 Key 回给界面');
      assert.equal(body.config.baseURL, ENV_BASE_URL);
    } finally {
      await close();
    }
  });

  it('只改默认模型并保存后，Key 不被抹掉，运行时仍用环境 Key', async () => {
    const { server, close } = await startServer('settings-env-save');
    try {
      const saved = await fetch(`${server.url}api/settings/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'save', model: 'deepseek-reasoner' }),
      });
      assert.equal(saved.status, 200);
      const body = (await saved.json()) as {
        ok: boolean;
        config: { hasKey: boolean; apiKey: string; baseURL: string; model: string };
      };
      assert.equal(body.ok, true);
      assert.equal(body.config.hasKey, true, '没填 Key 就该沿用环境里的 Key');
      assert.equal(body.config.baseURL, ENV_BASE_URL, '没改地址就该沿用环境里的地址');
      assert.equal(body.config.model, 'deepseek-reasoner');

      // 持久化后再读一次：环境 Key 必须还在（否则重启前都会用空 Key 请求）
      const reread = await fetch(`${server.url}api/settings/model`);
      const after = (await reread.json()) as { config: { hasKey: boolean } };
      assert.equal(after.config.hasKey, true, '保存后环境 Key 不能被抹掉');
    } finally {
      await close();
    }
  });
});
