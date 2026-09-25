import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileTools, createReadTool } from '../src/tools/builtin/files.js';
import {
  ENV_EXAMPLE_FILE,
  shellCommandSensitiveHit,
  shellRefusalMessage,
  sensitivePathHit,
  sensitivePaths,
  type SensitivePaths,
} from '../src/tools/sensitive-paths.js';
import { tempDataDir } from './fakes/test-env.js';
import type { Tool } from '../src/tools/tool.js';

/** Read/Write/Edit 只用到 context.signal，其余字段给空 */
const context = () => ({ signal: undefined }) as never;
const find = (tools: Tool<never>[], name: string): Tool<never> => {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `没有找到工具 ${name}`);
  return tool;
};

const SECRET_BODY = '{"apiKey":"sk-live-绝不能被工具读到"}';

describe('密钥文件默认拒绝（OPT-07）', () => {
  let env: { dir: string; cleanup: () => Promise<void> };
  let root: string;
  let dataDir: string;
  let paths: SensitivePaths;
  let tools: Tool<never>[];

  before(async () => {
    env = await tempDataDir('sensitive-paths');
    root = env.dir;
    dataDir = join(root, '.agentbot');
    await mkdir(join(dataDir, 'room-flows'), { recursive: true });
    await writeFile(join(dataDir, 'secrets.json'), SECRET_BODY);
    await writeFile(join(dataDir, 'model-config.json'), '{"providers":[]}');
    await writeFile(join(dataDir, 'room-flows', 'secret.key'), 'room-flow-signing-key');
    await writeFile(join(root, '.env'), 'API_KEY=sk-should-not-be-read');
    await writeFile(join(root, '.env.local'), 'AGENT_DATA_DIR=/tmp/x');
    await writeFile(join(root, ENV_EXAMPLE_FILE), 'API_KEY=');
    await writeFile(join(root, 'notes.txt'), '普通笔记：可以读。');
    // 符号链接两条路：文件软链、目录软链
    await symlink(join(dataDir, 'secrets.json'), join(root, 'link-to-secrets.txt'));
    await symlink(dataDir, join(root, 'data-link'));
    paths = sensitivePaths(root, dataDir);
    tools = createFileTools(root, paths) as Tool<never>[];
  });

  after(async () => { await env.cleanup(); });

  it('Read 拒绝数据目录里的三个密钥文件', async () => {
    const read = find(tools, 'Read');
    for (const rel of ['.agentbot/secrets.json', '.agentbot/model-config.json', '.agentbot/room-flows/secret.key']) {
      await assert.rejects(() => read.execute({ path: rel }, context()), /拒绝访问密钥文件/, rel);
    }
  });

  it('Read 拒绝项目根的 .env 家族，但放行 .env.example', async () => {
    const read = find(tools, 'Read');
    await assert.rejects(() => read.execute({ path: '.env' }, context()), /拒绝访问密钥文件/);
    await assert.rejects(() => read.execute({ path: '.env.local' }, context()), /拒绝访问密钥文件/);
    const example = await read.execute({ path: ENV_EXAMPLE_FILE }, context());
    assert.match(example, /API_KEY=/);
  });

  it('符号链接绕不过去（文件软链、目录软链都不行）', async () => {
    const read = find(tools, 'Read');
    await assert.rejects(() => read.execute({ path: 'link-to-secrets.txt' }, context()), /拒绝访问密钥文件/);
    await assert.rejects(() => read.execute({ path: 'data-link/secrets.json' }, context()), /拒绝访问密钥文件/);
    await assert.rejects(() => read.execute({ path: 'data-link/room-flows/secret.key' }, context()), /拒绝访问密钥文件/);
    // 绝对路径与 ../ 绕行同样按真实路径判断
    await assert.rejects(() => read.execute({ path: join(root, '.agentbot', 'secrets.json') }, context()), /拒绝访问密钥文件/);
    await assert.rejects(() => read.execute({ path: 'notes.txt/../.env' }, context()), /拒绝访问密钥文件/);
  });

  it('数据目录自身是软链时，真实目录下的路径也照样拒绝', async () => {
    const real = join(root, 'real-data');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'secrets.json'), SECRET_BODY);
    await symlink(real, join(root, 'data-through-link'));
    const linked = sensitivePaths(root, join(root, 'data-through-link'));
    const read = createReadTool(root, linked);
    await assert.rejects(() => read.execute({ path: 'data-through-link/secrets.json' }, context()), /拒绝访问密钥文件/);
    await assert.rejects(() => read.execute({ path: 'real-data/secrets.json' }, context()), /拒绝访问密钥文件/);
  });

  it('普通文件不受影响', async () => {
    const read = find(tools, 'Read');
    const text = await read.execute({ path: 'notes.txt' }, context());
    assert.match(text, /普通笔记/);
    assert.equal(await sensitivePathHit(join(root, 'notes.txt'), paths), undefined);
  });

  it('非隐藏的数据目录同样不进列表、不进搜索', async () => {
    const plainData = join(root, 'plain-data');
    await mkdir(plainData, { recursive: true });
    await writeFile(join(plainData, 'secrets.json'), SECRET_BODY);
    const plain = sensitivePaths(root, plainData);
    const plainTools = createFileTools(root, plain) as Tool<never>[];

    await assert.rejects(() => find(plainTools, 'Read').execute({ path: 'plain-data/secrets.json' }, context()), /拒绝访问密钥文件/);
    await assert.rejects(() => find(plainTools, 'SearchFiles').execute({ query: 'sk-live', path: 'plain-data/secrets.json' }, context()), /拒绝访问密钥文件/);
    const listed = await find(plainTools, 'ListFiles').execute({ path: '.' }, context());
    assert.ok(!listed.includes('plain-data/secrets.json'), '列表里不该出现密钥文件：' + listed);
    const searched = await find(plainTools, 'SearchFiles').execute({ query: 'sk-live', path: '.' }, context());
    assert.ok(!searched.includes('plain-data/secrets.json'), '搜索结果里不该出现密钥文件：' + searched);
    // 同一份数据目录按自己的策略看是密钥，按别的策略看就是普通文件——这是刻意的：名单只保护配置里的数据目录
    assert.equal(await sensitivePathHit(join(plainData, 'secrets.json'), plain), join(plainData, 'secrets.json'));
  });

  it('Write / Edit 不允许工具改写密钥文件', async () => {
    await assert.rejects(
      () => find(tools, 'Write').execute({ path: '.agentbot/secrets.json', content: '{}', overwrite: true }, context()),
      /拒绝访问密钥文件/,
    );
    await assert.rejects(
      () => find(tools, 'Edit').execute({ path: '.env', old_text: 'API_KEY=', new_text: 'API_KEY=x' }, context()),
      /拒绝访问密钥文件/,
    );
  });
});

describe('Shell 的保守字面检查（OPT-07）', () => {
  const root = '/tmp/agentbot-shell-check';
  const paths = sensitivePaths(root, join(root, '.agentbot'));

  it('命令里出现密钥路径就拒绝', () => {
    const hits = [
      `cat ${join(root, '.agentbot', 'secrets.json')}`,
      'cat .agentbot/secrets.json',
      'cat .agentbot/model-config.json',
      'cat .agentbot/room-flows/secret.key',
      'cat $HOME/.agentbot/secrets.json',
      'grep -r API_KEY .env',
      'cat ./.env.local',
      'head .env.production',
    ];
    for (const command of hits) {
      assert.ok(shellCommandSensitiveHit(command, paths), `应拒绝：${command}`);
      assert.match(shellRefusalMessage(command, 'x'), /拒绝执行/);
    }
  });

  it('不误伤环境变量、模板文件与普通命令', () => {
    const safe = [
      'npm test',
      'node -e "console.log(process.env.PORT)"',
      'cat .env.example',
      'printenv | sort',
      'grep -rn "process.env" src',
      'git status --short',
      `cat ${join(root, 'notes.txt')}`,
    ];
    for (const command of safe) {
      assert.equal(shellCommandSensitiveHit(command, paths), undefined, `不该拒绝：${command}`);
    }
  });
});
