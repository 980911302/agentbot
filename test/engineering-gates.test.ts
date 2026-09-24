import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CHECK_IMPORTS = join(ROOT, 'scripts/check-imports.mjs');
const CHECK_FORMAT = join(ROOT, 'scripts/check-format.mjs');

/** 在临时目录搭一个最小源码树，返回其根（用完即删） */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agentbot-imports-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function runChecker(root: string): { status: number; output: string } {
  const result = spawnSync('node', [CHECK_IMPORTS, root], { encoding: 'utf8' });
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('E1.4 跨层 import 约束', () => {
  it('真实仓库满足四条规则', () => {
    const result = runChecker(ROOT);
    assert.equal(result.status, 0, result.output);
  });

  it('R1：契约层引用 node:crypto 被拒', () => {
    const root = fixture({
      'src/shared/contracts/bad.ts':
        "import { createHmac } from 'node:crypto';\nexport const x = createHmac;\n",
    });
    try {
      const result = runChecker(root);
      assert.equal(result.status, 1);
      assert.match(result.output, /R1 契约层禁止引用 Node/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('R1：契约层引用契约之外的模块被拒', () => {
    const root = fixture({
      'src/shared/contracts/bad.ts':
        "import { SecretStore } from '../../secret/store.js';\nexport const x = SecretStore;\n",
      'src/secret/store.ts': 'export class SecretStore {}\n',
    });
    try {
      const result = runChecker(root);
      assert.equal(result.status, 1);
      assert.match(result.output, /R1 契约层禁止引用契约之外/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('R2：前端值导入后端非契约模块被拒，import type 放行', () => {
    const root = fixture({
      'web/src/bad.ts':
        "import { SecretStore } from '../../src/secret/store.js';\nexport const x = SecretStore;\n",
      'src/secret/store.ts': 'export class SecretStore {}\n',
      'web/src/good.ts':
        "import type { SecretStore } from '../../src/secret/store.js';\nexport const y = (x: SecretStore) => x;\n",
    });
    try {
      const result = runChecker(root);
      assert.equal(result.status, 1);
      assert.match(result.output, /R2/);
      assert.doesNotMatch(result.output, /good\.ts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('R2：前端值导入 contracts 纯模块放行（vite 可打包）', () => {
    const root = fixture({
      'web/src/ok.ts':
        "import { maskApiKey } from '../../shared/contracts/model-catalog.js';\nexport const x = maskApiKey('k');\n",
      'src/shared/contracts/model-catalog.ts': 'export function maskApiKey(key: string) { return key; }\n',
    });
    try {
      const result = runChecker(root);
      assert.equal(result.status, 0, result.output);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('R3：路由直连 storage 被拒', () => {
    const root = fixture({
      'src/server/routes/bad.ts':
        "import { SecretStore } from '../../storage/secret.js';\nexport const x = SecretStore;\n",
      'src/storage/secret.ts': 'export class SecretStore {}\n',
    });
    try {
      const result = runChecker(root);
      assert.equal(result.status, 1);
      assert.match(result.output, /R3/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('R4：工具引用 runtime 门面被拒', () => {
    const root = fixture({
      'src/tools/builtin/bad.ts':
        "import { AgentRuntime } from '../../server/runtime.js';\nexport const x = AgentRuntime;\n",
      'src/server/runtime.ts': 'export class AgentRuntime {}\n',
    });
    try {
      const result = runChecker(root);
      assert.equal(result.status, 1);
      assert.match(result.output, /R4/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('E1.4 受管清单', () => {
  it('.prettierfiles 非空且登记的文件都存在', () => {
    const entries = readFileSync(join(ROOT, '.prettierfiles'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    assert.ok(entries.length > 0, '.prettierfiles 不应为空');
    for (const entry of entries) {
      assert.ok(existsSync(join(ROOT, entry)), `受管清单里的文件不存在：${entry}`);
    }
  });

  it('check-format 对受管清单通过', () => {
    const result = spawnSync('node', [CHECK_FORMAT], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  });
});
