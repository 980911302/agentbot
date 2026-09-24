import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import http from 'node:http';
import type { Server } from 'node:http';
import { createAgentServer, type AgentServerHandle } from '../src/server/http.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

/**
 * 「测试连接」必须不能把已保存的 API Key 发往请求体指定的任意地址（bug_3ezzio75c6h2）。
 *
 * 原实现里 baseURL 优先取请求体、apiKey 却回退到已存储的值，
 * 于是 { providerId, baseURL: 任意地址 } 就能让对端收到 Authorization: Bearer <已保存的 Key>。
 */

interface Received {
  authorization?: string;
  url?: string;
}

/** 收包方：记录每个请求带过来的 Authorization，用来断言 Key 有没有被发出去 */
async function startCollector(): Promise<{ server: Server; port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    received.push({
      authorization: request.headers.authorization,
      url: request.url,
    });
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { server, port, received };
}

const close = (server: Server): Promise<void> => new Promise((done) => server.close(() => done()));

const STORED_KEY = 'sk-stored-secret-999';

describe('测试连接：已保存的 Key 不外泄', () => {
  it('请求体改了 baseURL 却不给新 Key 时 400，且一个字节都不发出去', async () => {
    const env = await tempDataDir('settings-key-test');
    const collector = await startCollector();
    let server: AgentServerHandle | undefined;
    try {
      server = await createAgentServer({
        port: 0,
        dataDir: env.dir,
        rootDir: process.cwd(),
        createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('收到') }),
        allowMissingKey: true,
      });

      const saved = await fetch(`${server.url}api/settings/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'save_provider',
          provider: {
            id: 'p1',
            name: '测试供应商',
            enabled: true,
            baseURL: `http://127.0.0.1:${collector.port}/v1`,
            apiKey: STORED_KEY,
            models: [{ id: 'm1', model: 'm1' }],
          },
        }),
      });
      assert.equal(saved.status, 200);
      const before = collector.received.length;

      const forged = await fetch(`${server.url}api/settings/model/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'p1', baseURL: 'http://attacker.example/v1' }),
      });

      assert.equal(forged.status, 400, '改了地址又没给新 Key 必须拒绝');
      const payload = (await forged.json()) as { ok: boolean; error?: string };
      assert.equal(payload.ok, false);
      assert.match(payload.error ?? '', /API Key/);
      assert.equal(collector.received.length, before, '不该向已保存的地址或指定地址发出任何请求');
    } finally {
      await server?.close();
      await close(collector.server);
      await env.cleanup();
    }
  });

  it('前端回填的打码 Key 同样不算「新 Key」，改了地址照样 400', async () => {
    const env = await tempDataDir('settings-key-masked');
    const collector = await startCollector();
    let server: AgentServerHandle | undefined;
    try {
      server = await createAgentServer({
        port: 0,
        dataDir: env.dir,
        rootDir: process.cwd(),
        createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('收到') }),
        allowMissingKey: true,
      });

      await fetch(`${server.url}api/settings/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'save_provider',
          provider: {
            id: 'p1',
            name: '测试供应商',
            enabled: true,
            baseURL: `http://127.0.0.1:${collector.port}/v1`,
            apiKey: STORED_KEY,
            models: [{ id: 'm1', model: 'm1' }],
          },
        }),
      });
      const before = collector.received.length;

      const masked = await fetch(`${server.url}api/settings/model/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'p1', baseURL: 'http://attacker.example/v1', apiKey: 'sk-s••••e-999' }),
      });

      assert.equal(masked.status, 400);
      assert.equal(collector.received.length, before, '打码值不是真 Key，不能拿已保存的 Key 顶替');
    } finally {
      await server?.close();
      await close(collector.server);
      await env.cleanup();
    }
  });

  it('测试已保存的供应商时不带地址，照常用已保存的 Key 打已保存的地址', async () => {
    const env = await tempDataDir('settings-key-normal');
    const collector = await startCollector();
    let server: AgentServerHandle | undefined;
    try {
      server = await createAgentServer({
        port: 0,
        dataDir: env.dir,
        rootDir: process.cwd(),
        createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('收到') }),
        allowMissingKey: true,
      });

      await fetch(`${server.url}api/settings/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'save_provider',
          provider: {
            id: 'p1',
            name: '测试供应商',
            enabled: true,
            baseURL: `http://127.0.0.1:${collector.port}/v1`,
            apiKey: STORED_KEY,
            models: [{ id: 'm1', model: 'm1' }],
          },
        }),
      });

      const tested = await fetch(`${server.url}api/settings/model/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'p1' }),
      });

      assert.equal(tested.status, 200);
      assert.equal(collector.received.length, 1, '正常路径仍要真的去测连通');
      assert.equal(collector.received[0]?.authorization, `Bearer ${STORED_KEY}`);
    } finally {
      await server?.close();
      await close(collector.server);
      await env.cleanup();
    }
  });

  it('换了新地址又给了新 Key 时，只发新 Key，已保存的 Key 不出门', async () => {
    const env = await tempDataDir('settings-key-new');
    const stored = await startCollector();
    const other = await startCollector();
    let server: AgentServerHandle | undefined;
    try {
      server = await createAgentServer({
        port: 0,
        dataDir: env.dir,
        rootDir: process.cwd(),
        createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('收到') }),
        allowMissingKey: true,
      });

      await fetch(`${server.url}api/settings/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'save_provider',
          provider: {
            id: 'p1',
            name: '测试供应商',
            enabled: true,
            baseURL: `http://127.0.0.1:${stored.port}/v1`,
            apiKey: STORED_KEY,
            models: [{ id: 'm1', model: 'm1' }],
          },
        }),
      });

      const tested = await fetch(`${server.url}api/settings/model/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerId: 'p1',
          baseURL: `http://127.0.0.1:${other.port}/v1`,
          apiKey: 'sk-new-key-123',
        }),
      });

      assert.equal(tested.status, 200);
      assert.equal(other.received.length, 1, '新地址应该收到请求');
      assert.equal(other.received[0]?.authorization, 'Bearer sk-new-key-123');
      assert.equal(stored.received.length, 0, '已保存的 Key 不能被带去别处');
    } finally {
      await server?.close();
      await close(stored.server);
      await close(other.server);
      await env.cleanup();
    }
  });
});
