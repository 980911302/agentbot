import type { ToolCall, ToolSchema } from '../agent/types.js';
import type { Tool, ToolContext } from './tool.js';
import { boundedSchema, limitsFor, MAX_TOOL_CALLS_PER_TURN, MAX_TOOL_CHARS_PER_TURN, validateToolArgs } from './limits.js';
import { boundResult, normalizeResult, toolError, type ToolResult } from './result.js';

type AnyTool = Tool<any>;

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  static from(tools: AnyTool[]): ToolRegistry {
    const registry = new ToolRegistry();
    registry.registerAll(tools);
    return registry;
  }

  register(tool: AnyTool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: AnyTool[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 这个工具是否只在当前回合有效、不写进历史 */
  isEphemeral(name: string): boolean {
    return this.tools.get(name)?.ephemeral === true;
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  getSchemas(): ToolSchema[] {
    return this.list().sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  async execute(call: ToolCall, context: ToolContext): Promise<string> {
    return (await this.executeResult(call, context)).content;
  }

  async executeResult(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    context.signal?.throwIfAborted();
    if (context.turnState) {
      if (context.turnState.toolLimitReason) return toolError('TOOL_LIMIT', context.turnState.toolLimitReason + '；该调用未执行，只能整理阶段交接');
      context.turnState.toolCalls = (context.turnState.toolCalls ?? 0) + 1;
      if (context.turnState.toolCalls > MAX_TOOL_CALLS_PER_TURN) {
        context.turnState.toolLimitReason = '本轮工具调用已达上限';
        return toolError('TOOL_LIMIT', context.turnState.toolLimitReason + '；该调用未执行');
      }
      context.turnState.toolInputChars = (context.turnState.toolInputChars ?? 0) + call.arguments.length;
      if (context.turnState.toolInputChars > MAX_TOOL_CHARS_PER_TURN || (context.turnState.toolOutputChars ?? 0) + limitsFor(call.name).output > MAX_TOOL_CHARS_PER_TURN) {
        context.turnState.toolLimitReason = `本轮工具输入/输出额度不足（各限 ${MAX_TOOL_CHARS_PER_TURN} 字符）`;
        return toolError('TOOL_LIMIT', context.turnState.toolLimitReason + '；该调用未执行，请整理阶段交接');
      }
    }
    if (call.arguments.length > limitsFor(call.name).input) return toolError('INPUT_LIMIT', `${call.name} 参数超过 ${limitsFor(call.name).input} 字符，请分块调用`);
    const tool = this.tools.get(call.name);
    if (!tool) {
      const available = [...this.tools.keys()].join(', ') || 'none';
      return toolError('UNKNOWN_TOOL', `unknown tool "${call.name}". Available tools: ${available}`);
    }

    let args: Record<string, unknown>;
    if (call.arguments.trim() === '') {
      args = {};
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.arguments);
      } catch (error) {
        return toolError('INVALID_ARGUMENTS', `arguments for "${call.name}" are not valid JSON: ${(error as Error).message}`);
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return toolError('INVALID_ARGUMENTS', `arguments for "${call.name}" must be a JSON object`);
      }
      args = parsed as Record<string, unknown>;
    }

    const missing = (tool.parameters.required ?? []).filter((key) => !(key in args));
    if (missing.length > 0) {
      return toolError('INVALID_ARGUMENTS', `missing required argument(s) for "${call.name}": ${missing.join(', ')}`);
    }

    try {
      validateToolArgs(call.name, args, boundedSchema(tool.parameters, call.name));
      const raw = tool.executeResult ? await tool.executeResult(args, context) : await tool.execute(args, context);
      const result = boundResult(normalizeResult(raw), limitsFor(call.name).output, context.agentId, context.outputs);
      if (context.turnState) context.turnState.toolOutputChars = (context.turnState.toolOutputChars ?? 0) + result.content.length;
      return result;
    } catch (error) {
      if (context.signal?.aborted) throw error;
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'TOOL_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      return toolError(code, code === 'TOOL_FAILED' ? `tool "${call.name}" failed: ${message}` : message);
    }
  }
}
