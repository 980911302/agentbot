/**
 * 思考块（`<think>…</think>`）的纯文本处理：复制按钮与导出会话共用这一个函数，
 * 不再各写一份正则（之前 markdown.tsx 那份结束标记写坏了，复制去不掉思考块）。
 * 渲染侧由 markdown.tsx 的 parseBlocks 丢弃思考块，规则与这里一致：没闭合就吃到末尾。
 */

const THINKING_BLOCK = /<think>[\s\S]*?(?:<\/think>|$)\s*/g;

/** 剥掉正文里的思维链段落（含未闭合的尾巴），只留可见正文并去掉首尾空白 */
export function stripThinkingBlocks(text: string): string {
  return text.replace(THINKING_BLOCK, '').trim();
}
