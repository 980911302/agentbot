import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { DisplayMessage } from '../web/src/types.js';
import { conversationMarkdown, exportTimestamp } from '../web/src/features/chat/export-view.js';

/** 本地时间构造，避免跑测试机器的时区影响断言 */
const at = (h: number, m: number) => new Date(2026, 8, 25, h, m).toISOString();

const msg = (id: string, role: 'user' | 'assistant', over: Partial<DisplayMessage> = {}): DisplayMessage => ({
  id,
  role,
  content: `内容-${id}`,
  toolCalls: [],
  createdAt: at(10, 0),
  ...over,
});

describe('exportTimestamp：导出用的本地时间', () => {
  it('ISO 与毫秒都转成 YYYY-MM-DD HH:mm', () => {
    assert.equal(exportTimestamp(at(9, 5)), '2026-09-25 09:05');
    assert.equal(exportTimestamp(new Date(2026, 0, 2, 23, 59).getTime()), '2026-01-02 23:59');
  });

  it('解析不了给空串', () => {
    assert.equal(exportTimestamp('not-a-date'), '');
  });
});

describe('conversationMarkdown：当前频道整理成 Markdown', () => {
  const base = {
    title: '小审',
    isGroup: false,
    ownerName: '林林',
    botName: '小审',
    now: new Date(2026, 8, 25, 12, 0).getTime(),
  };

  it('每条带发送者、时间、正文；私聊没带名字时用主人名 / 同事名', () => {
    const { markdown, count } = conversationMarkdown({
      ...base,
      messages: [
        msg('m1', 'user', { content: '帮我看下日志', createdAt: at(10, 1) }),
        msg('m2', 'assistant', { content: '好的，**已看完**', createdAt: at(10, 2) }),
      ],
    });
    assert.equal(count, 2);
    assert.match(markdown, /^# 小审（私聊）\n\n导出于 2026-09-25 12:00 · 共 2 条消息/);
    assert.ok(markdown.includes('**林林** · 2026-09-25 10:01\n\n帮我看下日志'));
    assert.ok(markdown.includes('**小审** · 2026-09-25 10:02\n\n好的，**已看完**'));
    assert.ok(markdown.includes('\n\n---\n\n'), '消息之间用水平线隔开');
  });

  it('群聊按各自的 senderName 标注', () => {
    const { markdown } = conversationMarkdown({
      ...base,
      title: '白泽联调',
      isGroup: true,
      botName: undefined,
      messages: [
        msg('m1', 'assistant', { senderName: '白泽' }),
        msg('m2', 'assistant', { sender: { kind: 'agent', id: 'a2', name: '机柜' } }),
      ],
    });
    assert.ok(markdown.startsWith('# 白泽联调（群聊）'));
    assert.ok(markdown.includes('**白泽** · '));
    assert.ok(markdown.includes('**机柜** · '));
  });

  it('思考块不导出；工具过程只列调用名，不带参数', () => {
    const { markdown } = conversationMarkdown({
      ...base,
      messages: [
        msg('m1', 'assistant', {
          content: '<think>先想想</think>结论是 42',
          toolCalls: [
            { id: 'c1', name: 'Read', arguments: '{"path":"/secret"}', status: 'ok' },
            { id: 'c2', name: 'Shell', arguments: '{}', status: 'ok' },
          ],
        }),
      ],
    });
    assert.ok(!markdown.includes('先想想'));
    assert.ok(markdown.includes('结论是 42'));
    assert.ok(markdown.includes('_执行过程：2 次调用（Read、Shell）_'));
    assert.ok(!markdown.includes('/secret'));
  });

  it('错误消息标「出错」；空正文且无工具的消息不导出也不计数', () => {
    const { markdown, count } = conversationMarkdown({
      ...base,
      messages: [
        msg('m1', 'assistant', { content: '请求超时', error: true }),
        msg('m2', 'assistant', { content: '  ' }),
      ],
    });
    assert.equal(count, 1);
    assert.ok(markdown.includes('**小审**（出错） · '));
  });

  it('同事往来以引用块导出，标出双方', () => {
    const { markdown } = conversationMarkdown({
      ...base,
      messages: [
        msg('m1', 'assistant', {
          content: '',
          correspondence: {
            id: 't1',
            from: { kind: 'agent', id: 'a1', name: '小审' },
            to: { kind: 'agent', id: 'a2', name: '白泽' },
            text: '第一行\n第二行',
            createdAt: Date.parse(at(10, 3)),
          },
        }),
      ],
    });
    assert.ok(markdown.includes('**小审 → 白泽**（同事往来）'));
    assert.ok(markdown.includes('> 第一行\n> 第二行'));
  });

  it('没有消息时只有标题与计数 0', () => {
    const { markdown, count } = conversationMarkdown({ ...base, messages: [] });
    assert.equal(count, 0);
    assert.ok(markdown.includes('共 0 条消息'));
  });
});
