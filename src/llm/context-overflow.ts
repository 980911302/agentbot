/**
 * 识别「上下文超长」类报错。上下文预算默认 1M，模型实际窗口更小时靠它自动收缩：
 * 读出上限就按上限压，读不出就逐步砍。各家措辞不同——
 *   OpenAI / DeepSeek / vLLM：maximum context length is 131072 tokens
 *   Anthropic 兼容网关：prompt is too long: 205000 tokens > 200000 maximum
 *   只有错误码：context_length_exceeded、413 request too large、中文「超出上下文长度」
 * 限流（429，常带 too many tokens per minute）、鉴权、网络错误都不算。
 */
export interface ContextOverflow {
  /** 能从报错里读出的模型上限（tokens）；读不出时为 undefined */
  limit?: number;
}

const LIMIT_PATTERNS = [
  /maximum context length (?:is|of)\s*(\d[\d,]*)/i,
  /context (?:length|window) (?:is|of)\s*(\d[\d,]*)/i,
  /\d[\d,]*\s*tokens?\s*>\s*(\d[\d,]*)\s*maximum/i,
];

const OVERFLOW_HINTS =
  /context[_ ]length[_ ]exceeded|maximum context|prompt is too long|request too large|input (?:is )?too long|exceeds? (?:the )?(?:model'?s? )?context|上下文.{0,8}(?:超|过长|上限)|(?:输入|请求).{0,8}(?:过长|超出)/i;

export function contextOverflowOf(error: unknown): ContextOverflow | null {
  const text = error instanceof Error ? error.message : '';
  if (!text) return null;
  // 只认请求本身被拒（400/413/422）或流里直接报错；429 限流等不能当成窗口太小
  const status = /failed with (\d{3})/.exec(text)?.[1];
  if (status && !['400', '413', '422'].includes(status)) return null;
  for (const pattern of LIMIT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const limit = Number(match[1]!.replace(/,/g, ''));
    return Number.isSafeInteger(limit) && limit >= 1000 ? { limit } : {};
  }
  return OVERFLOW_HINTS.test(text) ? {} : null;
}
