import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { createAgentServer, type AgentServerHandle } from '../src/server/http.js';
import { checkRequest, isAllowedOrigin, isLoopbackHost, hostnameOf } from '../src/server/transport/request-guard.js';
import { DEFAULT_BUDGET } from '../src/context/budget.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

/**
 * 本机 API 的请求守卫：只接受本应用自身发来的请求。
 *
 * 攻击面（见缺陷单 bug_yc9t7bf99uf1）：
 * - 外站网页用 text/plain 这类「简单请求」绕过 CORS 预检，直接建删同事、驱动机器人跑本机命令；
 * - DNS 重绑定把 attacker.example 解析到 127.0.0.1，同源读取全部数据；
 * - 伪造 Host 头让后端把它当成本机请求。
 */

interface RawResponse {
  status: number;
  text: string;
}

/** 用 node:http 直发，才能伪造 Host / Origin 这类浏览器不让脚本改的头 */
function raw(
  server: AgentServerHandle,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: server.port, path, method, headers },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
      },
    );
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

const fakeRequest = (method: string, headers: IncomingHttpHeaders) => ({ method, headers });

describe('请求守卫：主机名判定', () => {
  it('Host 只认回环地址，端口可有可无', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:8787', 'localhost', 'localhost:5173', '[::1]', '[::1]:8787', '::1', '127.5.5.5:8787']) {
      assert.equal(isLoopbackHost(hostnameOf(host)), true, host);
    }
  });
  it('外站域名、带后缀的假回环、空值都不算回环', () => {
    for (const host of ['attacker.example', 'attacker.example:8787', '127.0.0.1.evil.com', 'localhost.evil.com', '', '0.0.0.0:8787', 'evil.com']) {
      assert.equal(isLoopbackHost(hostnameOf(host)), false, host);
    }
  });
});

describe('请求守卫：来源判定', () => {
  it('本应用自己的来源放行：同源、Vite 开发端口、IPv6 回环、桌面端 file://', () => {
    for (const origin of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://localhost:5173', 'http://[::1]:8787', 'file://']) {
      assert.equal(isAllowedOrigin(origin), true, origin);
    }
  });
  it('外站来源、沙箱 iframe 的 null、畸形值一律拒绝', () => {
    for (const origin of ['https://evil.example', 'http://attacker.example', 'null', '', 'not-a-url', 'http://127.0.0.1.evil.com']) {
      assert.equal(isAllowedOrigin(origin), false, origin);
    }
  });
});

describe('请求守卫：判定规则', () => {
  it('Host 不是回环就 403，挡住 DNS 重绑定与伪造 Host', () => {
    const rejection = checkRequest(fakeRequest('GET', { host: 'attacker.example' }));
    assert.equal(rejection?.status, 403);
    assert.equal(rejection?.code, 'FORBIDDEN_HOST');
  });
  it('缺 Host 的请求一律 403', () => {
    assert.equal(checkRequest(fakeRequest('GET', {}))?.code, 'FORBIDDEN_HOST');
  });
  it('外站 Origin 的写操作 403：复现单子里的跨站 fetch', () => {
    const rejection = checkRequest(
      fakeRequest('POST', { host: '127.0.0.1:8787', origin: 'https://evil.example', 'content-type': 'application/json' }),
    );
    assert.equal(rejection?.status, 403);
    assert.equal(rejection?.code, 'FORBIDDEN_ORIGIN');
  });
  it('Origin 为 null（沙箱 iframe）同样 403', () => {
    assert.equal(checkRequest(fakeRequest('POST', { host: '127.0.0.1:8787', origin: 'null' }))?.code, 'FORBIDDEN_ORIGIN');
  });
  it('浏览器发来的写操作必须带 application/json，挡住 text/plain 简单请求', () => {
    const rejection = checkRequest(
      fakeRequest('POST', {
        host: '127.0.0.1:8787',
        origin: 'http://127.0.0.1:8787',
        'content-type': 'text/plain',
        'content-length': '30',
      }),
    );
    assert.equal(rejection?.status, 403);
    assert.equal(rejection?.code, 'FORBIDDEN_CONTENT_TYPE');
  });
  it('同源或桌面端来源的正常写操作放行', () => {
    assert.equal(checkRequest(fakeRequest('POST', { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'content-type': 'application/json' })), null);
    assert.equal(checkRequest(fakeRequest('POST', { host: '127.0.0.1:8787', origin: 'file://', 'content-type': 'application/json' })), null);
  });
  it('不带 Origin 的本地调用（CLI、curl、测试）放行，且不强制 Content-Type', () => {
    assert.equal(checkRequest(fakeRequest('POST', { host: '127.0.0.1:8787', 'content-type': 'application/json' })), null);
    assert.equal(checkRequest(fakeRequest('POST', { host: '127.0.0.1:8787' })), null);
  });
  it('没有 body 的写操作不要求 Content-Type', () => {
    assert.equal(checkRequest(fakeRequest('POST', { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' })), null);
    assert.equal(checkRequest(fakeRequest('DELETE', { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' })), null);
  });
  it('读请求只校验 Host：响应能否被跨站读走由浏览器 CORS 自己挡', () => {
    assert.equal(checkRequest(fakeRequest('GET', { host: '127.0.0.1:8787', origin: 'https://evil.example' })), null);
  });
});

describe('请求守卫：真实服务回归', () => {
  let server: AgentServerHandle | undefined;
  let dir = '';
  let cleanup: (() => Promise<void>) | undefined;

  const setup = async () => {
    const temp = await tempDataDir('guard-test');
    dir = temp.dir;
    cleanup = temp.cleanup;
    server = await createAgentServer({
      port: 0,
      dataDir: dir,
      rootDir: process.cwd(),
      createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('收到') }),
      allowMissingKey: true,
    });
  };

  const teardown = async () => {
    await server?.close();
    await cleanup?.();
    server = undefined;
  };

  it('外站 Origin + text/plain 的跨站建同事请求返回 403，且没有建出同事', async () => {
    await setup();
    try {
      const forged = await raw(
        server!,
        'POST',
        '/api/agents',
        { 'content-type': 'text/plain', origin: 'https://evil.example' },
        JSON.stringify({ name: '外站建的同事' }),
      );
      assert.equal(forged.status, 403);
      assert.equal(JSON.parse(forged.text).code, 'FORBIDDEN_ORIGIN');

      const list = await raw(server!, 'GET', '/api/agents', { host: '127.0.0.1' });
      assert.equal(list.status, 200);
      assert.ok(!list.text.includes('外站建的同事'), '外站请求不该留下任何数据');
    } finally {
      await teardown();
    }
  });

  it('伪造 Host 头的请求被 403 挡掉', async () => {
    await setup();
    try {
      const rebound = await raw(server!, 'GET', '/api/health', { host: 'attacker.example' });
      assert.equal(rebound.status, 403);
      assert.equal(JSON.parse(rebound.text).code, 'FORBIDDEN_HOST');
    } finally {
      await teardown();
    }
  });

  it('应用自己（同源 Origin + JSON）的写操作照常成功', async () => {
    await setup();
    try {
      const created = await raw(
        server!,
        'POST',
        '/api/agents',
        { 'content-type': 'application/json', origin: `http://127.0.0.1:${server!.port}` },
        JSON.stringify({ name: '正常同事' }),
      );
      assert.equal(created.status, 201);

      const list = await raw(server!, 'GET', '/api/agents', { host: '127.0.0.1' });
      assert.ok(list.text.includes('正常同事'), '本应用的请求不该被挡住');
    } finally {
      await teardown();
    }
  });

  it('SSE 订阅与静态资源这类本机读请求不受影响', async () => {
    await setup();
    try {
      const health = await raw(server!, 'GET', '/api/health', { host: '127.0.0.1' });
      assert.equal(health.status, 200);
    } finally {
      await teardown();
    }
  });
});
