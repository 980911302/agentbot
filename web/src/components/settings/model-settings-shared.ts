import type { ThinkingLevel } from '../../../../src/shared/contracts/model-catalog';

/** 设置页的类型与纯校验（UI-08 拆分：状态、动作、视图各自成文件）。 */

export interface TestState {
  testing?: boolean;
  latencyMs?: number;
  error?: string;
  ok?: boolean;
}

export interface ProviderFormErrors {
  name?: string;
  baseURL?: string;
}

export interface ModelFormErrors {
  model?: string;
}

export interface ProviderDraft {
  name: string;
  group: string;
  baseURL: string;
  apiFormat: 'openai' | 'responses';
  apiKey: string;
}

export interface ModelDraft {
  model: string;
  name: string;
  contextWindow: string;
  thinkingEnabled: boolean;
  thinkingLevel: ThinkingLevel;
  setActive: boolean;
}

export const EMPTY_PROVIDER_DRAFT: ProviderDraft = {
  name: '',
  group: '自定义供应商',
  baseURL: 'https://api.openai.com/v1',
  apiFormat: 'openai',
  apiKey: '',
};

export const EMPTY_MODEL_DRAFT: ModelDraft = {
  model: '',
  name: '',
  contextWindow: '200K',
  thinkingEnabled: true,
  thinkingLevel: 'medium',
  setActive: false,
};

/** 必填 + 格式检查（规范 §5.2：错误要落到具体字段上，不只弹全局提示） */
export function providerDraftErrors(draft: ProviderDraft): ProviderFormErrors {
  const errors: ProviderFormErrors = {};
  if (!draft.name.trim()) errors.name = '请填供应商名称';
  if (!draft.baseURL.trim()) errors.baseURL = '请填 Base URL';
  else if (!/^https?:\/\//.test(draft.baseURL.trim()))
    errors.baseURL = 'Base URL 要以 http:// 或 https:// 开头';
  return errors;
}

export function messageOf(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : '';
  return text || fallback;
}
