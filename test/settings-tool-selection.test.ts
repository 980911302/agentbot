import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearOptional,
  isDirty,
  selectionSummary,
  splitTools,
  toggleTool,
  type ToolCatalogEntry,
} from '../web/src/components/settings/tool-selection.js';

/**
 * E5.3 界面侧纯逻辑：把「必需能力不可卸载 / 可选工具可全卸」的规则放在
 * 组件之外，界面只负责渲染，规则由这里守住（与后端 capabilities.ts 同口径）。
 */

const catalog: ToolCatalogEntry[] = [
  { name: 'WebSearch', description: '公网搜索' },
  { name: 'SendToUser', description: '唯一出口', required: true },
  { name: 'Read', description: '读文件' },
  { name: 'ReadToolOutput', description: '读截断原文', required: true },
  { name: 'Shell', description: '跑命令' },
];

describe('工具装卸界面逻辑（E5.3）', () => {
  it('必需能力与可选工具分开，各自按名字稳定排序', () => {
    const groups = splitTools(catalog);
    assert.deepEqual(
      groups.required.map((tool) => tool.name),
      ['ReadToolOutput', 'SendToUser'],
    );
    assert.deepEqual(
      groups.optional.map((tool) => tool.name),
      ['Read', 'Shell', 'WebSearch'],
    );
  });

  it('必需能力勾不动：点它不会加进清单，也不会从清单里被删掉', () => {
    assert.deepEqual(toggleTool(['Read'], 'SendToUser', catalog), ['Read']);
    assert.deepEqual(toggleTool(['Read'], 'ReadToolOutput', catalog), ['Read']);
    assert.deepEqual(toggleTool([], 'ReadToolOutput', catalog), []);
  });

  it('可选工具能勾上也能取消；未知工具不影响清单', () => {
    assert.deepEqual(toggleTool(['Read'], 'WebSearch', catalog), ['Read', 'WebSearch']);
    assert.deepEqual(toggleTool(['Read', 'WebSearch'], 'WebSearch', catalog), ['Read']);
    assert.deepEqual(toggleTool(['Read'], '还没上线的新工具', catalog), ['Read']);
  });

  it('可选工具可全部卸载（空集合），且空集合本身是可保存状态', () => {
    const emptied = clearOptional();
    const selected: string[] = emptied;
    assert.equal(selected.length, 0, '空集合就是空数组');
    assert.deepEqual(
      splitTools(catalog).optional.filter((tool) => selected.includes(tool.name)),
      [],
    );
    // 空集合与「已有清单」不同 → 保存按钮该亮
    assert.equal(isDirty(selected, ['Read', 'WebSearch']), true);
    // 与后端确认过的空集合一致 → 不该再提示保存
    assert.equal(isDirty(selected, []), false);
  });

  it('isDirty 只看集合内容，不看顺序', () => {
    assert.equal(isDirty(['Read', 'Shell'], ['Shell', 'Read']), false);
    assert.equal(isDirty(['Read'], ['Read', 'Shell']), true);
  });

  it('摘要如实报数：必需能力不算进用户勾选', () => {
    assert.equal(selectionSummary(splitTools(catalog), ['Read', 'WebSearch']), '2 个可选工具 + 2 个必需能力');
    assert.equal(selectionSummary(splitTools(catalog), []), '0 个可选工具 + 2 个必需能力');
  });
});
describe('工具装卸界面契约（源码与样式守卫，E5.3）', () => {
  const settingsDir = join(process.cwd(), 'web/src/components/settings');
  const read = (name: string) => readFileSync(join(settingsDir, name), 'utf8');

  it('设置页有「工具装卸」入口，并把 activeTab 接到该分区', () => {
    assert.match(read('ProviderList.tsx'), /工具装卸/);
    assert.match(read('ProviderList.tsx'), /setActiveTab\('agent-tools'\)/);
    assert.match(read('SettingsDialog.tsx'), /activeTab === 'agent-tools'/);
    assert.match(read('SettingsDialog.tsx'), /<AgentToolsSection \/>/);
  });

  it('必需能力渲染成 locked 只读行，且不参与勾选回调', () => {
    const source = read('AgentToolsSection.tsx');
    assert.match(source, /agent-tool-row locked/);
    // 必需能力的勾选框固定 checked + disabled，并且没有 onChange（点它不会改清单）
    const lockedBlock = source.slice(
      source.indexOf('agent-tool-row locked'),
      source.indexOf('settings-section-title">可选工具'),
    );
    assert.match(lockedBlock, /checked disabled/);
    assert.equal(/onChange/.test(lockedBlock), false);
    // 只有可选工具才走 toggleTool
    assert.match(source, /toggleTool\(current, tool\.name, catalog\)/);
  });

  it('可选工具用后端标的 required 区分，不在前端硬编码清单', () => {
    const source = read('AgentToolsSection.tsx');
    assert.match(source, /fetchHealth\(\)/);
    assert.equal(/SendToUser|ReadToolOutput/.test(source), false, '必需清单只能来自后端 /api/health');
  });

  it('保存条吸底：保证工具列表再长也看得见「保存」（UI-06 的几何教训）', () => {
    const css = readFileSync(join(process.cwd(), 'web/src/styles/07-dialog.css'), 'utf8');
    const block = css.slice(
      css.indexOf('.agent-tools-savebar {'),
      css.indexOf('.agent-tools-savebar-actions'),
    );
    assert.match(block, /position:\s*sticky/);
    assert.match(block, /bottom:\s*0/);
    // 只用语义令牌，不写死颜色/间距
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(block), false, '保存条样式不许出现十六进制颜色');
  });
});
