import { defineTool } from '../tool.js';

export function createReadToolOutputTool() {
  return defineTool<{ output_id: string; offset?: number; limit?: number; query?: string }>({
    name: 'ReadToolOutput',
    description: [
      '分页读取或按字面文本搜索工具的已落盘原文。只允许自己的 output_id；offset/next_offset 是 UTF-8 字节。',
      '不带 query：默认读 8000 字节，limit 是本页字节数（4–12000）。',
      '带 query：字面匹配，一次最多扫描 256 KiB；limit 是本次最多返回几个命中（有效 1–30，缺省 30）；query 按 UTF-8 字节计，最多 1000 字节。',
      '两种情况都按 next_offset 继续。日志默认保留 7 天，受磁盘配额约束。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        output_id: { type: 'string' },
        offset: { type: 'integer', minimum: 0, description: 'UTF-8 字节偏移，从 0 起' },
        limit: {
          type: 'integer',
          // 下限取两种模式的更小者：搜索模式只要 1 个命中（读取模式的 4–12000 字节
          // 由 store 兜底——那里已经有「limit 必须在 4–12000 字节之间」的校验）。
          // 原先写 4 会让「搜索模式有效 1–30」这句描述与 schema 自相矛盾（E5.8 打回点）。
          minimum: 1,
          maximum: 12000,
          description: '读取模式：本页最多几个字节（4–12000）；搜索模式：最多几个命中（1–30，缺省 30）',
        },
        query: {
          type: 'string',
          maxLength: 1000,
          description: '字面文本，按 UTF-8 字节计最多 1000 字节（约 333 个汉字）',
        },
      },
      required: ['output_id'],
    },
    execute(args, context) {
      if (!context.outputs) throw new Error('当前运行时未配置持久日志存储');
      const page =
        args.query === undefined
          ? context.outputs.read(args.output_id, context.agentId, args.offset, args.limit)
          : context.outputs.search(args.output_id, context.agentId, args.query, args.offset, args.limit);
      const { record, nextOffset } = page;
      const remaining = nextOffset < record.retainedBytes;
      return {
        status: 'ok' as const,
        content: `output_id: ${record.id}\n已保存/总输出：${record.retainedBytes}/${record.totalBytes} 字节${record.storageTruncated ? '（存储配额已满，原文未完整保存）' : ''}\n${'text' in page ? page.text : page.matches.map((offset) => `命中字节 offset=${offset}`).join('\n') || '本扫描范围没有匹配'}\nnext_offset: ${nextOffset}${remaining ? '（仍有未读/未扫描内容）' : record.closed ? '（已到末尾）' : '（当前末尾，进程仍可能追加）'}`,
        output: {
          handle: record.id,
          truncated: remaining,
          nextOffset,
          totalBytes: record.totalBytes,
          retainedBytes: record.retainedBytes,
          storageTruncated: record.storageTruncated,
        },
        ...(record.execution ? { execution: record.execution } : {}),
      };
    },
  });
}
