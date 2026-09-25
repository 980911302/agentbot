import { createHash } from 'node:crypto';
import type { ReplayPolicy, ToolInvocationRecord } from '../storage/ports.js';

/**
 * 工具调用的恢复策略（E3.5，对应 docs/架构设计.md §7.3）。
 *
 * 只做纯分类与纯计算：不碰存储、不认识运行时。
 *   - operationKeyOf：稳定业务键，同一请求跨重试不变（不掺 runId / 时间戳）
 *   - replayPolicyOf：这个工具中断后该怎么对待
 *   - planRecovery：一条（可能没结果的）调用具体怎么收尾
 */

/** 纯读取/搜索：可以重读，只需注明时间变化 */
const RERUN_TOOLS = new Set([
  'Read',
  'ListFiles',
  'SearchFiles',
  'WebSearch',
  'WebFetch',
  'RecallMemory',
  'ListSections',
  'CheckSubagent',
  'AwaitShell',
  'ReadToolOutput',
]);

/** 本地写入（待办/资料/工作台）：先核对产物，再决定是否重做 */
const VERIFY_TOOLS = new Set([
  'TodoWrite',
  'Write',
  'Edit',
  'update_state',
  'CreateAgent',
  'UpdateAgent',
  'CreateChannel',
  'UpdateChannel',
]);

/**
 * 有副作用且无法自证是否已生效：结果未知时不自动重做，先核对外部状态再问用户。
 * ManageRoomFlow（OPT-08）在这里：它改的是群流程的授权链，重放会重复推进流程。
 */
const MANUAL_TOOLS = new Set([
  'Shell',
  'Task',
  'MessageSubagent',
  'StopSubagent',
  'SendToAgent',
  'SendToUser',
  'ManageRoomFlow',
]);

/** 显式登记的分类；没登记的工具返回 undefined（只有 replayPolicyOf 会回退成 manual） */
export function declaredReplayPolicyOf(tool: string): ReplayPolicy | undefined {
  if (RERUN_TOOLS.has(tool)) return 'rerun';
  if (VERIFY_TOOLS.has(tool)) return 'verify';
  if (MANUAL_TOOLS.has(tool)) return 'manual';
  return undefined;
}

/** 只读取可重读 / 本地写入先核对 / 其余（壳、派工、外发、控制面、未知工具）一律不盲目重跑 */
export function replayPolicyOf(tool: string): ReplayPolicy {
  return declaredReplayPolicyOf(tool) ?? 'manual';
}

/**
 * 稳定业务键：同一 agent + 工具 + 参数（键序无关）永远得到同一个键。
 * 恢复时用它问「这件事是不是已经做过」；将来接外部幂等接口也复用它当业务键。
 */
export function operationKeyOf(input: { agentId: string; tool: string; args?: string }): string {
  return createHash('sha256')
    .update(`${input.agentId}\u0000${input.tool}\u0000${canonicalArgs(input.args)}`)
    .digest('hex')
    .slice(0, 32);
}

export type RecoveryAction = 'none' | 'rerun' | 'retry' | 'verify' | 'manual';

export interface RecoveryPlan {
  action: RecoveryAction;
  reason: string;
}

/** 一条调用该怎么收尾：已经有结果的不用动；没结果的按策略分类 */
export function planRecovery(record: ToolInvocationRecord): RecoveryPlan {
  if (record.status === 'ok') return { action: 'none', reason: '已有结果，不需要恢复' };
  switch (record.replayPolicy) {
    case 'rerun':
      return { action: 'rerun', reason: '纯读取：可以重读（注明时间变化）' };
    case 'idempotent':
      return { action: 'retry', reason: '支持业务幂等键：用同一 operationKey 重试' };
    case 'verify':
      return { action: 'verify', reason: '本地写入：先核对产物，再决定是否重做' };
    default:
      return {
        action: 'manual',
        reason: '未知副作用（shell/外发）：先查产物与外部状态，无法判断就问用户',
      };
  }
}

/** 参数规范化：键序无关、去掉空白差异；解析失败就用原文 */
function canonicalArgs(raw?: string): string {
  if (!raw) return '';
  try {
    return stableStringify(JSON.parse(raw) as unknown);
  } catch {
    return raw.trim();
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
