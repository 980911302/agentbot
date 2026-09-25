import type { JSONSchema } from '../agent/types.js';

/** 字符预算是保守的资源边界，不是计费用量统计。新工具也必须显式登记。 */
export const TOOL_LIMITS: Record<string, { input: number; output: number }> = {
  Read: { input: 5000, output: 14000 },
  ListFiles: { input: 5000, output: 12000 },
  SearchFiles: { input: 6000, output: 12000 },
  Write: { input: 40000, output: 2000 },
  Edit: { input: 40000, output: 2000 },
  Shell: { input: 28000, output: 10000 },
  AwaitShell: { input: 5000, output: 10000 },
  ReadToolOutput: { input: 3000, output: 14000 },
  WebFetch: { input: 6000, output: 14000 },
  WebSearch: { input: 3000, output: 8000 },
  RecallMemory: { input: 3000, output: 10000 },
  update_state: { input: 12000, output: 2000 },
  ListSections: { input: 1000, output: 8000 },
  CreateAgent: { input: 10000, output: 2000 },
  UpdateAgent: { input: 10000, output: 2000 },
  CreateChannel: { input: 3000, output: 2000 },
  UpdateChannel: { input: 3000, output: 2000 },
  SendToAgent: { input: 16000, output: 4000 },
  SendToUser: { input: 24000, output: 4000 },
  Task: { input: 16000, output: 6000 },
  CheckSubagent: { input: 1000, output: 8000 },
  MessageSubagent: { input: 14000, output: 2000 },
  StopSubagent: { input: 1000, output: 2000 },
  TodoWrite: { input: 24000, output: 8000 },
  // ManageRoomFlow（OPT-08）：5 个字符串字段各自 ≤1000 字符 + actors 列表（每个参与者约 40 字符，
  // 够 50 人）→ 输入 8000，与同类控制工具（CreateChannel 3000 / CreateAgent 10000）同量级；
  // status 返回流程摘要 JSON（含 currentActors）→ 输出 4000，与 SendToAgent 同档。
  ManageRoomFlow: { input: 8000, output: 4000 },
};
export const MAX_TOOL_CALLS_PER_TURN = 128;
export const MAX_TOOL_CHARS_PER_TURN = 256000;
export const MAX_TOOL_BATCH = 8;
const FALLBACK = { input: 16000, output: 8000 };
export const limitsFor = (name: string) => TOOL_LIMITS[name] ?? FALLBACK;

export function clipOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const note = '\n…[输出达到字符上限；请缩小范围或分页查询，未显示的内容不代表不存在]…\n';
  const head = Math.floor((max - note.length) * 0.8);
  return text.slice(0, head) + note + text.slice(-(max - head - note.length));
}

const STRING_LIMITS: Record<string, number> = {
  path: 4096, working_directory: 4096, url: 4096, query: 1000, pattern: 500,
  command: 24000, content: 32000, old_text: 16000, new_text: 16000,
  name: 100, title: 200, description: 8000, prompt: 12000, message: 12000,
  text: 20000, fact: 2000, project: 80, helpText: 1000,
};

/** 同一套边界同时给模型 schema 和执行器使用，不能只靠提示词自觉。 */
export function boundedSchema(schema: JSONSchema, toolName: string): JSONSchema {
  const visit = (raw: any, key = '', depth = 0): any => {
    if (!raw || typeof raw !== 'object' || depth > 8) return raw;
    const node = { ...raw };
    if (node.type === 'string') {
      const cap = (toolName === 'TodoWrite' && key === 'content') ? 500
        : (toolName === 'Task' && key === 'description') ? 200
        : STRING_LIMITS[key] ?? 1000;
      node.maxLength = Math.min(node.maxLength ?? cap, cap);
    }
    if (node.type === 'array') {
      node.maxItems = Math.min(node.maxItems ?? 50, 100);
      node.items = visit(node.items ?? { type: 'string', maxLength: 1000 }, '', depth + 1);
    }
    if (node.type === 'object') {
      node.additionalProperties = false;
      node.properties = Object.fromEntries(Object.entries(node.properties ?? {}).map(([k, v]) => [k, visit(v, k, depth + 1)]));
    }
    return node;
  };
  return visit(schema);
}

export function validateToolArgs(name: string, args: unknown, schema: JSONSchema): void {
  const serialized = JSON.stringify(args);
  if (!serialized || serialized.length > limitsFor(name).input) {
    throw new Error(`${name} 参数超过 ${limitsFor(name).input} 字符，请拆成较小的调用；写文件请分块 Write/Edit`);
  }
  const visit = (value: any, rule: any, path: string, depth: number): void => {
    if (depth > 8) throw new Error(`${path} 嵌套超过 8 层`);
    if (rule.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 必须是 object`);
      for (const key of rule.required ?? []) {
        if (value[key] === undefined) throw new Error(`missing required argument: ${path}.${key}`);
      }
      for (const [key, item] of Object.entries(value)) {
        const child = Object.hasOwn(rule.properties ?? {}, key) ? rule.properties[key] : undefined;
        if (!child) throw new Error(`${path}.${key} 是不支持的参数`);
        visit(item, child, `${path}.${key}`, depth + 1);
      }
    } else if (rule.type === 'array') {
      // 兼容旧工作台模型发来的 JSON 数组字符串；仍用同一元素/数量边界校验。
      if (typeof value === 'string' && /\.(?:add_|remove_)?member_ids$/.test(path)) {
        try { value = JSON.parse(value); } catch { throw new Error(`${path} 必须是数组或合法 JSON 数组`); }
      }
      if (!Array.isArray(value)) throw new Error(`${path} 必须是 array`);
      if (value.length < (rule.minItems ?? 0) || value.length > (rule.maxItems ?? 50)) throw new Error(`${path} 数量超限（${rule.minItems ?? 0}–${rule.maxItems ?? 50}）`);
      for (const item of value) visit(item, rule.items, `${path}[]`, depth + 1);
    } else if (rule.type === 'string') {
      if (typeof value !== 'string') throw new Error(`${path} 必须是 string`);
      if (value.length > rule.maxLength || value.length < (rule.minLength ?? 0)) throw new Error(`${path} 长度超限（最大 ${rule.maxLength} 字符）`);
    } else if (rule.type === 'number' || rule.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (rule.type === 'integer' && !Number.isSafeInteger(value))) throw new Error(`${path} 必须是有限${rule.type === 'integer' ? '整数' : '数字'}`);
      if (value < (rule.minimum ?? -Number.MAX_SAFE_INTEGER) || value > (rule.maximum ?? Number.MAX_SAFE_INTEGER)) throw new Error(`${path} 超出允许范围`);
    } else if (rule.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${path} 必须是 boolean`);
    if (rule.enum && !rule.enum.includes(value)) throw new Error(`${path} 不合法；允许：${rule.enum.join(', ')}`);
  };
  visit(args, schema, name, 0);
}
