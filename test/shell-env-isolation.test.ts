import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellSessionManager } from '../src/tools/services/shell-session-manager.js';

/**
 * Shell 子进程不能拿到模型密钥（bug_cge6m9yewecs）。
 *
 * .env 里的 AGENT_API_KEY 等被 loadEnvFile 写进 process.env，spawn 不传 env
 * 时子进程原样继承——智能体一句 env 就能把密钥读进上下文和落盘日志。
 */

const SECRETS: Record<string, string> = {
  AGENT_API_KEY: 'sk-from-dotenv-SECRET-42',
  AGENT_BASE_URL: 'https://api.example.com/v1',
  OPENAI_API_KEY: 'sk-openai-SECRET-43',
  OPENAI_BASE_URL: 'https://openai.example.com/v1',
  AGENT_WEB: 'off',
  AGENT_STOP_WORDS: '停一下',
};

let saved: Record<string, string | undefined> = {};
const command = (name: string): string =>
  process.platform === 'win32' ? `echo %${name}%` : `printf '%s' "$${name}"`;

/** 后台 job 不在等待范围：同步跑完就退出 */
async function run(manager: ShellSessionManager, script: string): Promise<string> {
  const shell = manager.start(script, undefined, undefined, { timeoutMs: 10_000 });
  while (!shell.done) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(shell.code, 0, `命令没跑成功：${shell.output}`);
  return shell.output.trim();
}

describe('Shell 子进程环境变量隔离', () => {
  before(() => {
    saved = {};
    for (const name of Object.keys(SECRETS)) {
      saved[name] = process.env[name];
      process.env[name] = SECRETS[name];
    }
  });

  after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('密钥类变量对子进程不可见：env 输出里找不到 AGENT_/OPENAI_ 的 Key', async () => {
    const manager = new ShellSessionManager();
    const output = await run(manager, process.platform === 'win32' ? 'set' : 'env');
    for (const name of ['AGENT_API_KEY', 'OPENAI_API_KEY', 'AGENT_BASE_URL', 'OPENAI_BASE_URL']) {
      assert.ok(!output.includes(SECRETS[name]!), `${name} 泄露到了子进程环境`);
      assert.ok(!new RegExp(`^${name}=`, 'm').test(output), `${name} 出现在子进程环境里`);
    }
  });

  it('直接读单个变量也拿不到：子进程看到的密钥是空', async () => {
    const manager = new ShellSessionManager();
    for (const name of ['AGENT_API_KEY', 'OPENAI_API_KEY']) {
      const value = await run(manager, command(name));
      assert.equal(value, '', `子进程读到了 ${name}`);
    }
  });

  it('非密钥的 AGENT_* 运行配置一样不继承：避免整片泄漏', async () => {
    const manager = new ShellSessionManager();
    for (const name of ['AGENT_WEB', 'AGENT_STOP_WORDS', 'AGENT_BASE_URL']) {
      const value = await run(manager, command(name));
      assert.equal(value, '', `子进程读到了 ${name}`);
    }
  });

  it('PATH 等必要变量仍然可用，命令能正常执行', async () => {
    const manager = new ShellSessionManager();
    const path = await run(manager, command('PATH'));
    assert.ok(path.length > 0, '子进程拿不到 PATH，普通命令会全挂');
    const echoed = await run(manager, process.platform === 'win32' ? 'echo shell-works' : 'echo shell-works');
    assert.equal(echoed, 'shell-works');
  });

  it('落盘的完整日志里也不含密钥', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shell-env-log-'));
    const { ToolOutputStore } = await import('../src/tools/services/tool-output-store.js');
    const manager = new ShellSessionManager();
    const outputs = new ToolOutputStore(dir);
    const shell = manager.start(process.platform === 'win32' ? 'set' : 'env', undefined, undefined, { timeoutMs: 10_000, outputs });
    while (!shell.done) await new Promise((resolve) => setTimeout(resolve, 20));
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const logDir = join(dir, 'tools', 'outputs');
    const files = readdirSync(logDir).filter((name) => name.endsWith('.log'));
    assert.ok(files.length > 0, '应该留下工具输出日志');
    for (const file of files) {
      const text = readFileSync(join(logDir, file), 'utf8');
      assert.ok(!text.includes(SECRETS.AGENT_API_KEY!), '落盘的完整日志里有密钥');
      assert.ok(!text.includes('OPENAI_API_KEY'), '落盘的完整日志里有 OpenAI Key');
    }
    assert.ok(statSync(join(logDir, files[0]!)).size > 0);
  });
});
