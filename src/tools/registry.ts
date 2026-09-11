import type { ToolCall, ToolSchema } from '../agent/types.js';
import type { Tool, ToolContext } from './tool.js';

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
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  async execute(call: ToolCall, context: ToolContext): Promise<string> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      const available = [...this.tools.keys()].join(', ') || 'none';
      return `Error: unknown tool "${call.name}". Available tools: ${available}`;
    }

    let args: Record<string, unknown>;
    if (call.arguments.trim() === '') {
      args = {};
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.arguments);
      } catch (error) {
        return `Error: arguments for "${call.name}" are not valid JSON: ${(error as Error).message}`;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return `Error: arguments for "${call.name}" must be a JSON object`;
      }
      args = parsed as Record<string, unknown>;
    }

    const missing = (tool.parameters.required ?? []).filter((key) => !(key in args));
    if (missing.length > 0) {
      return `Error: missing required argument(s) for "${call.name}": ${missing.join(', ')}`;
    }

    try {
      return await tool.execute(args, context);
    } catch (error) {
      return `Error: tool "${call.name}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
}
