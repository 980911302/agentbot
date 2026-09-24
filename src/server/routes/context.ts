import type { AppConfig, ModelOption } from '../../config.js';
import { RoomError } from '../../room/store.js';
import type { AgentRuntime } from '../runtime.js';

/** 路由层共享上下文：装配好的运行时 + 本次启动的静态配置 */
export interface RouteContext {
  runtime: AgentRuntime;
  staticDir?: string;
  model: string;
  models: ModelOption[];
  tools: Array<{ name: string; description: string }>;
  budget: AppConfig['budget'];
  ownerName: string;
  /**
   * 启动时从环境变量解析出的模型默认值（bug_epxdph16hjut）。
   *
   * 只在 .env / 环境变量配 Key、没在设置页建供应商时，设置页要靠它如实显示
   * 「已配置」，保存时也要靠它沿用环境 Key，不能把运行时 Provider 换成空 Key。
   */
  envDefaults?: { baseURL?: string; apiKey?: string };
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function messageOf(error: unknown): string {
  if (error instanceof RoomError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** 按 id 找智能体，找不到再按名字找（前端历史上有用名字直连的场景） */
export async function resolveAgent(context: RouteContext, idOrName: string) {
  const byId = await context.runtime.registry.get(idOrName);
  if (byId) return byId;
  const list = await context.runtime.registry.list();
  const wanted = idOrName.trim();
  return list.find((item) => item.name === wanted);
}
