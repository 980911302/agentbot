import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { contextAvailable, fitContextWindow, type WindowState } from '../src/context/window.js';
import { estimateTokens } from '../src/context/budget.js';
import type { LLMMessage } from '../src/llm/provider.js';

/** 一次 Read：调用 + 结果；结果是 14000 个 ASCII 字符（≈3.9K tokens） */
const readGroup = (index: number): LLMMessage[] => [
  {
    role: 'assistant',
    content: null,
    toolCalls: [
      { id: `c${index}`, name: 'Read', arguments: JSON.stringify({ path: `src/file${index}.ts` }) },
    ],
  },
  { role: 'tool', toolCallId: `c${index}`, content: `// file${index}\n` + 'x'.repeat(14000) },
];

const conversation = (count: number): LLMMessage[] => [
  { role: 'system', content: '固定规则' },
  { role: 'user', content: '当前任务：改代码' },
  ...Array.from({ length: count }, (_, index) => readGroup(index)).flat(),
];

const toolContents = (messages: LLMMessage[]) =>
  messages.filter((message) => message.role === 'tool').map((message) => message.content ?? '');

describe('上下文渐进压缩', () => {
  it('从最早的工具结果开始压，最近读过的原文保持完整', () => {
    const input = conversation(12);
    const result = fitContextWindow(input, [], 60_000, '当前任务：改代码');
    const contents = toolContents(result);
    assert.equal(contents.length, 12, '调用与结果都还在，只是早期的被压短');
    assert.ok(contents[0]!.length < 14000, '最早的结果被压缩');
    assert.equal(contents.at(-1)!.length, input.at(-1)!.content!.length, '最近一次读取的原文完整保留');
    assert.equal(contents.at(-2)!.length, input.at(-3)!.content!.length, '倒数第二次读取也完整');
    assert.ok(estimateTokens(JSON.stringify(result)) + 128 <= contextAvailable(60_000));
  });

  it('压缩后留出余量；跨轮沿用压缩边界，下一轮只追加时前缀不变', () => {
    const state: WindowState = { compacted: 0 };
    const first = fitContextWindow(conversation(12), [], 60_000, '当前任务：改代码', [], state);
    const boundary = state.compacted;
    assert.ok(boundary > 0, '记下压到了第几组');
    const second = fitContextWindow(conversation(13), [], 60_000, '当前任务：改代码', [], state);
    assert.equal(state.compacted, boundary, '余量够用时不再移动边界');
    const prefix = first.length - 1;
    assert.deepEqual(second.slice(0, prefix), first.slice(0, prefix), '已发过的前缀原样复用，利于缓存命中');
  });

  it('余量用完才继续往后压，并且仍保持调用/结果成对、不改动调用方数组', () => {
    const state: WindowState = { compacted: 0 };
    fitContextWindow(conversation(12), [], 60_000, '当前任务：改代码', [], state);
    const before = state.compacted;
    const input = conversation(20);
    const snapshot = JSON.stringify(input);
    const result = fitContextWindow(input, [], 60_000, '当前任务：改代码', [], state);
    assert.ok(state.compacted > before);
    assert.equal(JSON.stringify(input), snapshot);
    for (let index = 0; index < result.length; index++) {
      const message = result[index]!;
      if (message.toolCalls) assert.equal(result[index + 1]?.toolCallId, message.toolCalls[0]!.id);
    }
    assert.equal(toolContents(result).at(-1)!.length, input.at(-1)!.content!.length);
  });

  it('放得下时不压缩也不插入提示', () => {
    const input = conversation(2);
    const result = fitContextWindow(input, [], 60_000, '当前任务：改代码');
    assert.deepEqual(result, input);
  });
});
