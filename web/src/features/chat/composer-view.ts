/**
 * 输入条的纯展示模型（UI 设计规范 §5.9 / UI-07）：
 * 文本域 1~8 行自适应、封顶后内部滚动，以及忙碌态的占位文案。
 *
 * 高度常量必须与 `05-chat.css` 的 `.capsule-input` 一致：CSS 里写不了
 * JS 常量，那边的 `max-height` 用字面量并注释指向本文件。
 */

/** 规范 §5.9：文本域 1~8 行自适应，超出内部滚动 */
export const COMPOSER_MAX_ROWS = 8;
/** 一行的高度 = `--fs-md`（15px）× 1.5 取整，与 .capsule-input 的 line-height 一致 */
export const COMPOSER_LINE_HEIGHT = 24;
/** `.capsule-input` 的上下内边距之和（padding: 4px 2px，border-box） */
export const COMPOSER_PADDING_Y = 8;
export const COMPOSER_MIN_HEIGHT = COMPOSER_LINE_HEIGHT + COMPOSER_PADDING_Y;
export const COMPOSER_MAX_HEIGHT = COMPOSER_MAX_ROWS * COMPOSER_LINE_HEIGHT + COMPOSER_PADDING_Y;

export interface ComposerAreaSize {
  /** 直接写进 textarea 的 style.height */
  height: number;
  /** 是否已封顶：内容更多时改由文本域内部滚动 */
  scrolls: boolean;
}

/**
 * 由文本域的 scrollHeight 算出该给它的高度。
 * 非有限值或空内容回落到一行高；超过 8 行封顶并交给内部滚动。
 */
export function composerAreaSize(contentHeight: number): ComposerAreaSize {
  const wanted = Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : COMPOSER_MIN_HEIGHT;
  if (wanted > COMPOSER_MAX_HEIGHT) return { height: COMPOSER_MAX_HEIGHT, scrolls: true };
  return { height: Math.max(COMPOSER_MIN_HEIGHT, wanted), scrolls: false };
}

/** 占位文案：忙碌时说明「还能发，但会插话」（规范 §5.9） */
export function composerPlaceholder(input: { busy: boolean; isGroup: boolean; botName: string }): string {
  if (input.busy) return '它正在工作，发送会插话';
  if (input.isGroup) return '在群聊中发消息，输入 @ 唤醒指定成员…';
  return `给 ${input.botName || 'Bot'} 发消息`;
}

/** 按频道暂存的输入草稿：切走再切回来还在；发送或清空后删掉这一格 */
export interface ComposerDrafts {
  read(channelId: string): string;
  save(channelId: string, text: string): void;
}

/**
 * 草稿只放内存（本次打开的页面内有效），不写 localStorage：
 * 输入条的半句话不值得跨重启保留，也免得敏感内容落盘。
 * 空白草稿不占格子，读不到回落为空串。
 */
export function createComposerDrafts(): ComposerDrafts {
  const drafts = new Map<string, string>();
  return {
    read: (channelId) => drafts.get(channelId) ?? '',
    save: (channelId, text) => {
      if (text.trim()) drafts.set(channelId, text);
      else drafts.delete(channelId);
    },
  };
}
