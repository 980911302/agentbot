import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BUDGET, type ContextBudget } from './context/budget.js';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_MODEL = 'deepseek-chat';
export const DEFAULT_PORT = 8787;
export const DEFAULT_DATA_DIR = '.agentbot';
/** 未配置主人名时的中性占位，不写死具体姓名 */
export const DEFAULT_OWNER_NAME = '主人';

export interface ModelOption {
  id: string;
  label: string;
  hint: string;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  { id: 'deepseek-chat', label: 'Chat', hint: '通用对话 · 支持工具调用' },
  { id: 'deepseek-reasoner', label: 'Reasoner', hint: '深度推理 · 支持工具调用' },
];

export interface AppConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  dataDir: string;
  budget: ContextBudget;
  memoryExtraction: boolean;
  /** 主人在群里的显示名 */
  ownerName: string;
  /** 是否启用联网工具（web_search / web_fetch） */
  web: boolean;
  /** 停止词：私聊整句命中即视作停止令（见 docs/架构设计.md「插话、停止和等待」） */
  stopWords: string[];
}

/** 停止词默认表；AGENT_STOP_WORDS 可追加（逗号/空格分隔） */
export const DEFAULT_STOP_WORDS = [
  '停',
  '停止',
  '先别做了',
  '取消',
  '别做了',
  '不用了',
  'halt',
  'cancel',
  'stop',
];

/**
 * 整句匹配：trim、去尾部标点、拉丁转小写后全等。
 * 只认整句是刻意的——不靠模型猜「这句是不是在叫停」。
 */
export function isStopSentence(text: string, stopWords: string[]): boolean {
  const cleaned = text
    .trim()
    .replace(/[!！?？。，,；;：:~～—–-\s]+$/g, '')
    .toLowerCase();
  if (!cleaned) return false;
  return stopWords.some((word) => word.trim().toLowerCase() === cleaned);
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      [
        '未配置模型 API Key。请任选一种方式：',
        '  1. 项目根目录创建 .env 文件，写入 AGENT_API_KEY=sk-...',
        '  2. 设置环境变量 export AGENT_API_KEY=sk-...',
        '  3. 使用其他兼容 OpenAI 接口的服务：AGENT_BASE_URL=... AGENT_API_KEY=... AGENT_MODEL=...',
      ].join('\n'),
    );
    this.name = 'MissingApiKeyError';
  }
}

/**
 * 极简 .env 读取（零依赖）。
 * 只做 KEY=VALUE，支持 # 注释与引号，不展开变量。
 * 已存在的进程环境变量优先——命令行传入的应能覆盖 .env。
 */
export function loadEnvFile(rootDir: string, into: NodeJS.ProcessEnv = process.env): void {
  let raw = '';
  try {
    raw = readFileSync(join(rootDir, '.env'), 'utf8');
  } catch {
    return; // 没有 .env 是正常情况
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key || key in into) continue;

    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);

    into[key] = value;
  }
}

export interface ResolveConfigOptions {
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  /** 读 .env 后再解析（CLI/服务端启动用） */
  loadEnvFile?: boolean;
  /** 测试或特殊场景允许无 key（调用模型时会再报错） */
  allowMissingKey?: boolean;
}

export function resolveConfig(options: ResolveConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? process.cwd();

  if (options.loadEnvFile !== false) loadEnvFile(rootDir, env);

  const apiKey = env.AGENT_API_KEY ?? env.OPENAI_API_KEY ?? '';
  if (!apiKey && !options.allowMissingKey) throw new MissingApiKeyError();

  return {
    apiKey,
    baseURL: env.AGENT_BASE_URL ?? env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
    model: env.AGENT_MODEL ?? DEFAULT_MODEL,
    dataDir: env.AGENT_DATA_DIR ?? join(rootDir, DEFAULT_DATA_DIR),
    budget: DEFAULT_BUDGET,
    memoryExtraction: env.AGENT_MEMORY_EXTRACTION !== 'off',
    ownerName:
      (env.AGENT_OWNER_NAME ?? '').trim() ||
      (env.AGENT_OWNER ?? '').trim() ||
      DEFAULT_OWNER_NAME,
    web: env.AGENT_WEB !== 'off',
    stopWords: Array.from(
      new Set([
        ...DEFAULT_STOP_WORDS,
        ...(env.AGENT_STOP_WORDS ?? '')
          .split(/[,，\s]+/)
          .map((word) => word.trim())
          .filter(Boolean),
      ]),
    ),
  };
}
