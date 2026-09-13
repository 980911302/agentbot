import { defineTool } from '../tool.js';

export function createReadToolOutputTool() {
  return defineTool<{ output_id: string; offset?: number; limit?: number; query?: string }>({
    name: 'ReadToolOutput',
    description: '分页读取或按字面文本搜索工具的已落盘原文。只允许自己的 output_id；offset/next_offset 是 UTF-8 字节。默认读 8000 字节；搜索每次最多扫描 256 KiB、返回 30 个命中位置，按 next_offset 继续。日志默认保留 7 天，受磁盘配额约束。',
    parameters: { type: 'object', properties: {
      output_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 4, maximum: 12000 }, query: { type: 'string', maxLength: 1000 },
    }, required: ['output_id'] },
    execute(args, context) {
      if (!context.outputs) throw new Error('当前运行时未配置持久日志存储');
      const page = args.query === undefined
        ? context.outputs.read(args.output_id, context.agentId, args.offset, args.limit)
        : context.outputs.search(args.output_id, context.agentId, args.query, args.offset);
      const { record, nextOffset } = page;
      const remaining = nextOffset < record.retainedBytes;
      return { status: 'ok' as const,
        content: `output_id: ${record.id}\n已保存/总输出：${record.retainedBytes}/${record.totalBytes} 字节${record.storageTruncated ? '（存储配额已满，原文未完整保存）' : ''}\n${'text' in page ? page.text : page.matches.map(offset => `命中字节 offset=${offset}`).join('\n') || '本扫描范围没有匹配'}\nnext_offset: ${nextOffset}${remaining ? '（仍有未读/未扫描内容）' : record.closed ? '（已到末尾）' : '（当前末尾，进程仍可能追加）'}`,
        output: { handle: record.id, truncated: remaining, nextOffset, totalBytes: record.totalBytes, retainedBytes: record.retainedBytes, storageTruncated: record.storageTruncated },
        ...(record.execution ? { execution: record.execution } : {}),
      };
    },
  });
}
