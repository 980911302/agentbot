/**
 * 工具装卸的纯逻辑（E5.3）：组件只负责渲染与调用，规则在这里、可单测。
 *
 * 与后端 `src/tools/capabilities.ts` 同一套口径：
 *   - `required` 是后端 /api/health 标出来的必需能力，恒定可用、不可卸载；
 *   - 其余是可选工具，由用户按同事勾选，允许全不勾（空集合 = 只留必需能力）。
 */

export interface ToolCatalogEntry {
  name: string;
  description: string;
  required?: boolean;
}

export interface ToolGroups {
  required: ToolCatalogEntry[];
  optional: ToolCatalogEntry[];
}

/** 把后端工具面拆成「必需能力」与「可选工具」，各自按名字稳定排序 */
export function splitTools(catalog: readonly ToolCatalogEntry[]): ToolGroups {
  const byName = (left: ToolCatalogEntry, right: ToolCatalogEntry): number =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  return {
    required: catalog.filter((tool) => tool.required === true).slice().sort(byName),
    optional: catalog.filter((tool) => tool.required !== true).slice().sort(byName),
  };
}

/**
 * 勾选 / 取消一个可选工具。
 * 必需能力不可装卸：传进来的名字即使不在清单里也原样返回（不静默改动用户意图）。
 */
export function toggleTool(selected: readonly string[], name: string, catalog: readonly ToolCatalogEntry[]): string[] {
  const entry = catalog.find((tool) => tool.name === name);
  if (!entry || entry.required === true) return [...selected];
  return selected.includes(name) ? selected.filter((item) => item !== name) : [...selected, name];
}

/** 全卸可选工具（必需能力不在这个清单里，由后端恒定叠加） */
export function clearOptional(): string[] {
  return [];
}

/** 与后端已确认清单是否一致（用来决定保存按钮是否可点） */
export function isDirty(selected: readonly string[], persisted: readonly string[]): boolean {
  if (selected.length !== persisted.length) return true;
  const saved = new Set(persisted);
  return selected.some((name) => !saved.has(name));
}

/** 面向用户的勾选摘要，例如「3 个可选工具 + 2 个必需能力」 */
export function selectionSummary(groups: ToolGroups, selected: readonly string[]): string {
  const chosen = groups.optional.filter((tool) => selected.includes(tool.name)).length;
  return `${chosen} 个可选工具 + ${groups.required.length} 个必需能力`;
}