import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentServer } from '../src/server/http.js';
import { FakeProvider } from './fakes/fake-provider.js';
import { tempDataDir } from './fakes/test-env.js';

/** OPT-06：控制存储损坏后的修复入口（POST /api/control/repair） */
async function startServer(dataDir: string) {
  return createAgentServer({
    port: 0,
    dataDir,
    rootDir: process.cwd(),
    allowMissingKey: true,
    createProvider: () => new FakeProvider({ auto: () => FakeProvider.text('好') }),
  }).then((server) => ({ ...server, base: server.url.replace(/\/$/, '') }));
}

const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('控制存储修复接口（OPT-06）', () => {
  it('不带确认字段拒绝；带确认后重建控制存储，损坏文件备份保留、已知同事全部 paused', async () => {
    const env = await tempDataDir('control-repair-route');
    try {
      // 先起一次服务建出同事（也建出控制存储），再写坏 control/state.json
      const first = await startServer(env.dir);
      const agent = await first.runtime.registry.create({ name: '控制修复', instructions: '测试' });
      await first.close();

      const stateFile = join(env.dir, 'control', 'state.json');
      const broken = '{"controlSeq": 5, 坏掉的 JSON';
      await writeFile(stateFile, broken);

      let server: Awaited<ReturnType<typeof startServer>> | undefined;
      try {
        server = await startServer(env.dir);
        const brokenView = await (await fetch(`${server.base}/api/agents/${agent.id}/control`)).json();
        assert.equal(brokenView.faulted, true, '损坏文件应让控制存储进入保护模式');

        const denied = await post(server.base, '/api/control/repair', {});
        assert.equal(denied.status, 400, '没有 confirm 不能修复');
        assert.equal((await denied.json()).code, 'CONFIRM_REQUIRED');

        const repaired = await post(server.base, '/api/control/repair', { confirm: 'repair' });
        assert.equal(repaired.status, 200);
        const body = (await repaired.json()) as {
          ok: boolean;
          faulted: boolean;
          pausedAgents: number;
          corruptBackup?: string;
        };
        assert.equal(body.ok, true);
        assert.equal(body.faulted, false);
        assert.ok(body.pausedAgents >= 1, `已知同事应被置 paused，实际 ${body.pausedAgents}`);
        assert.match(body.corruptBackup ?? '', /\.corrupt-\d{4}-/, '损坏文件应改名备份');
        assert.equal(await readFile(body.corruptBackup!, 'utf8'), broken, '损坏内容原样保留');

        const repairedView = await (await fetch(`${server.base}/api/agents/${agent.id}/control`)).json();
        assert.equal(repairedView.faulted, false);
        assert.equal(repairedView.autoActivation, 'paused', '修复后需要用户核对，不能默认放行');
      } finally {
        await server?.close();
      }
    } finally {
      await env.cleanup();
    }
  });
});
