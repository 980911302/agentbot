/**
 * 事实归一化与去重。
 * 文档第 5 节：重复的会去重，同一件事不会堆很多份。
 *
 * 判定顺序（先保守后激进）：
 *   0. 数字守卫：两条事实的数字不同 → 一定是两件事，不合并
 *   1. 归一化后完全相同
 *   2. 词面高度重合（Jaccard）
 *   3. 去掉虚词后剩下的实词高度重合 —— 处理「我叫张林」与「用户叫张林」这类改写
 */

const PUNCTUATION = /[\s，。、；：！？""''（）()【】\[\]{}<>《》,.;:!?'"`~@#$%^&*_+=|\\/-]+/g;

/** 虚词与泛化动词：判定「同一件事」时不该成为证据 */
const STOP_CHARS = new Set(
  [
    '我', '你', '他', '她', '它', '们', '的', '了', '是', '在', '有', '和', '与', '及', '或',
    '这', '那', '个', '都', '也', '就', '很', '要', '会', '不', '没', '请', '让', '把', '被',
    '给', '对', '从', '到', '而', '并', '且', '但', '以', '为', '着', '过', '吗', '呢', '吧',
    '叫', '说', '称', '呼', '做', '用', '来', '去', '想', '知', '道', '好', '样', '些', '时候',
  ].join(''),
);

export function normalizeText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(PUNCTUATION, '')
    .replace(/[０-９ａ-ｚＡ-Ｚ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

export function memoryKey(text: string): string {
  return normalizeText(text).slice(0, 120);
}

export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  const tokens: string[] = [];

  for (const match of normalized.matchAll(/[a-z0-9]{2,}/g)) tokens.push(match[0]);

  const cjk = [...normalized].filter((char) => /[\u3400-\u9fff]/.test(char));
  if (cjk.length === 1) tokens.push(cjk[0] as string);
  for (let index = 0; index + 1 < cjk.length; index += 1) {
    tokens.push(`${cjk[index]}${cjk[index + 1]}`);
  }
  return tokens;
}

/** 去掉虚词后剩下的实词，用来判断「说的是不是同一个东西」 */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokenize(text)) {
    if ([...token].some((char) => STOP_CHARS.has(char))) continue;
    out.add(token);
  }
  return out;
}

export function numbersIn(text: string): string[] {
  return [...normalizeText(text).matchAll(/\d+/g)].map((match) => match[0]);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let inter = 0;
  for (const token of left) if (right.has(token)) inter += 1;
  return inter / (left.size + right.size - inter);
}

/** 较小一侧被覆盖的比例 */
function overlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let inter = 0;
  for (const token of left) if (right.has(token)) inter += 1;
  return inter / Math.min(left.size, right.size);
}

export function similarity(left: string, right: string): number {
  return jaccard(new Set(tokenize(left)), new Set(tokenize(right)));
}

export const DEDUP_THRESHOLD = 0.86;
export const CONTENT_OVERLAP = 0.75;

export type DuplicateReason = 'exact' | 'similar' | 'content' | 'digits-conflict' | null;

export interface DuplicateVerdict {
  duplicate: boolean;
  reason: DuplicateReason;
  score: number;
}

/**
 * 判断 candidate 是否与 existing 中的某条是同一件事。
 * `existing` 传入候选文本自身，保证数字集合完整。
 */
export function judgeDuplicate(candidate: string, existing: string): DuplicateVerdict {
  const candidateDigits = new Set(numbersIn(candidate));
  const existingDigits = new Set(numbersIn(existing));

  if (candidateDigits.size > 0 && existingDigits.size > 0) {
    let same = true;
    for (const digit of candidateDigits) if (!existingDigits.has(digit)) same = false;
    if (!same) return { duplicate: false, reason: 'digits-conflict', score: 0 };
  }

  const key = memoryKey(candidate);
  if (key && key === memoryKey(existing)) {
    return { duplicate: true, reason: 'exact', score: 1 };
  }

  const jac = similarity(candidate, existing);
  if (jac >= DEDUP_THRESHOLD) return { duplicate: true, reason: 'similar', score: jac };

  const content = overlap(contentTokens(candidate), contentTokens(existing));
  if (content >= CONTENT_OVERLAP) return { duplicate: true, reason: 'content', score: content };

  return { duplicate: false, reason: null, score: Math.max(jac, content) };
}
