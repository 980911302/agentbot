import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineTool } from '../tool.js';

const MAX_READ_BYTES = 256 * 1024;

/**
 * Read —— 对齐《内置工具清单.md》1.7。
 *
 * Grok 语义：读自己机器上的文本（带行号），绝对路径；offset 负数从末尾数。
 * 没有云电脑，所以没有 machineId。
 */

export function createReadTool() {
  return defineTool<{ path: string; offset?: number; limit?: number }>({
    name: 'Read',
    description: [
      '读本机上的文本文件，返回带行号的内容；绝对路径。',
      'offset 从 1 开始（负数表示从末尾往前数），limit 是行数。',
      '图片 / PDF 暂不支持；大文件自动截断。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        offset: { type: 'number', description: '起始行，从 1 开始；负数=从末尾数' },
        limit: { type: 'number', description: '读取行数，默认全部' },
      },
      required: ['path'],
    },
    async execute({ path, offset, limit }) {
      if (!path || !path.trim()) throw new Error('path 不能为空');
      const absolute = resolve(path.trim());
      const info = await stat(absolute).catch(() => null);
      if (!info?.isFile()) throw new Error(`找不到这个文件：${absolute}`);
      if (info.size > MAX_READ_BYTES) {
        throw new Error(`文件超过 ${MAX_READ_BYTES} 字节，用 Shell 的 head/tail 或指定 offset/limit 分段读`);
      }

      const raw = await readFile(absolute, 'utf8');
      const lines = raw.split('\n');
      const total = lines.length;

      let start = offset === undefined ? 1 : offset;
      if (start < 0) start = Math.max(1, total + 1 + start);
      start = Math.max(1, start);
      let end = limit === undefined ? total : start - 1 + Math.max(0, limit);
      end = Math.min(total, end);

      const body = lines
        .slice(start - 1, end)
        .map((line, index) => `${String(start + index).padStart(5)}  ${line}`)
        .join('\n');

      return `${absolute}（共 ${total} 行${end < total ? `，显示 ${start}-${end} 行` : ''}）\n${body}`;
    },
  });
}
