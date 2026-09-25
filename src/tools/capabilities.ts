/**
 * 工具装卸的静态分类（E5.3）：必需能力 vs 可选工具。
 *
 * 「必需能力」= 卸掉之后同事就废掉、且没有任何正当关闭理由的能力。
 *   它不写进 `AgentRecord.toolNames`，而是在装配工具面时恒定叠加：
 *   `toolNames` 只表达「用户给这位同事勾了哪些可选工具」（可以是空集合），
 *   必需能力永远不参与增删，所以从结构上就卸不掉。
 *
 * 「可选工具」= 用户在设置里按同事勾选/取消的授权，跟随 `toolNames` 持久化；
 *   卸载后不被启动迁移补回（见 `AgentRegistry.syncDefaultTools` 只补 default 记录）。
 *
 * 只做纯分类与归一：不碰存储、不认识运行时（与 limits.ts / policy.ts 同层）。
 */

/**
 * 必需能力清单（顺序无关，改动必须同步 docs/工具参考.md 与本文件理由）：
 *
 *   SendToUser
 *     群/私聊的唯一出口（红线：唯一出口就是它）。卸了同事说不了话，
 *     「被点名必须用出口回应」这条群纪律也就无法履行——这是「废掉同事」的定义本身。
 *
 *   ReadToolOutput
 *     所有工具结果被截断后的唯一回读通道：`src/tools/result.ts` 超出输出上限时
 *     只回一段摘要加 `output_id`，并明确提示模型「用 ReadToolOutput 分页/搜索原文」。
 *     卸了它，模型会照着提示去调一个不存在的工具（UNKNOWN_TOOL），
 *     超长结果变成静默丢失的数据。它只读「该同事自己已经产生的输出」，
 *     不扩大任何数据边界，因此关掉它只有坏处、没有正当用途。
 *
 * 为什么 Read / Shell / WebSearch / 派工族 **不在**清单里：
 *   它们都是真实的权限旋钮——Read 决定这位同事能不能看本机文件、Shell 决定能不能执行命令、
 *   WebSearch 决定能不能联网、Task 族决定能不能派工。用户可以合法地只给某位同事一部分，
 *   这属于最小授权而不是「把同事弄坏」，所以一律留在可选工具里按需勾选。
 */
export const REQUIRED_TOOL_NAMES: readonly string[] = ['SendToUser', 'ReadToolOutput'];

const REQUIRED = new Set(REQUIRED_TOOL_NAMES);

/** 这个工具是不是必需能力（UI 用它把勾选框锁成只读） */
export function isRequiredTool(name: string): boolean {
  return REQUIRED.has(name);
}

/**
 * 「用户勾选的可选工具」→ 这位同事实际可用的工具名：
 * 保留用户的选择与顺序，把缺的必需能力补上；必选项不因用户没勾而消失。
 */
export function effectiveToolNames(selected: readonly string[]): string[] {
  const result: string[] = [];
  for (const name of selected) if (!result.includes(name)) result.push(name);
  for (const name of REQUIRED_TOOL_NAMES) if (!result.includes(name)) result.push(name);
  return result;
}

/** 从运行时全量工具面里挑出可选工具（装机清单用它决定哪些能勾掉） */
export function optionalToolNames(all: readonly string[]): string[] {
  return all.filter((name) => !REQUIRED.has(name));
}
