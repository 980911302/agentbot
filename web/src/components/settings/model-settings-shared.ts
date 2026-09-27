import { lookupModelThinkingInfo, type ThinkingLevel } from '../../../../src/shared/contracts/model-catalog';

/** 模型设置页的类型与纯函数（视图与动作分文件，这里只放能单测的部分）。 */

export interface TestState {
  testing?: boolean;
  latencyMs?: number;
  error?: string;
  ok?: boolean;
}

/** 添加服务商只问四样：名称、地址、Key、第一个模型（没有模型的服务商用不了） */
export interface ProviderDraft {
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

export type ProviderDraftErrors = Partial<Record<'name' | 'baseURL' | 'model', string>>;

export const EMPTY_PROVIDER_DRAFT: ProviderDraft = { name: '', baseURL: '', apiKey: '', model: '' };

/** 必填 + 地址格式；错误落到具体字段上 */
export function providerDraftErrors(draft: ProviderDraft): ProviderDraftErrors {
  const errors: ProviderDraftErrors = {};
  if (!draft.name.trim()) errors.name = '填一个名称';
  const url = baseURLError(draft.baseURL);
  if (url) errors.baseURL = url;
  if (!draft.model.trim()) errors.model = '填一个模型名';
  return errors;
}

export function baseURLError(value: string): string | undefined {
  const url = value.trim();
  if (!url) return '填接口地址';
  if (!/^https?:\/\/\S+$/.test(url)) return '地址要以 http:// 或 https:// 开头';
  return undefined;
}

/** 思考强度：关 / 低 / 中 / 高，对应存储里的 thinkingEnabled + thinkingLevel */
export type ThinkingChoice = 'off' | ThinkingLevel;

export const THINKING_CHOICES: Array<{ value: ThinkingChoice; label: string }> = [
  { value: 'off', label: '关' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

export function thinkingChoiceOf(model: {
  thinkingEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
}): ThinkingChoice {
  return model.thinkingEnabled === false ? 'off' : (model.thinkingLevel ?? 'medium');
}

export function thinkingPatch(choice: ThinkingChoice): {
  thinkingEnabled: boolean;
  thinkingLevel?: ThinkingLevel;
} {
  return choice === 'off' ? { thinkingEnabled: false } : { thinkingEnabled: true, thinkingLevel: choice };
}

/** 新模型的存储记录：显示名跟随模型名，思考按内置目录给默认值 */
export function newModelRecord(
  model: string,
  id = 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
) {
  const name = model.trim();
  const info = lookupModelThinkingInfo(name);
  return {
    id,
    model: name,
    name,
    thinkingEnabled: info.supportsThinking,
    thinkingLevel: info.defaultLevel,
  };
}

export function messageOf(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : '';
  return text || fallback;
}
