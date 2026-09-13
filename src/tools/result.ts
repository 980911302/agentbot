import type { ToolResult } from '../shared/contracts/tool-result.js';
import type { ToolOutputStore } from './services/tool-output-store.js';
import { clipOutput } from './limits.js';

export type { ToolResult };

export function toolError(code: string, message: string): ToolResult {
  const bounded = clipOutput(message, 1800);
  return { status: 'error', content: `Error: ${bounded}`, error: { code, message: bounded } };
}

export function normalizeResult(value: string | ToolResult): ToolResult {
  if (typeof value === 'string') return { status: 'ok', content: value };
  if (!value || !['ok', 'error', 'running'].includes(value.status) || typeof value.content !== 'string') {
    throw new Error('工具返回了无效的结构化结果');
  }
  // 只保留线上契约字段，不允许任意巨大对象混入历史。
  return { status: value.status, content: value.content,
    ...(value.error ? { error: { code: value.error.code.slice(0, 100), message: clipOutput(value.error.message, 1800) } } : {}),
    ...(value.output ? { output: {
      truncated: value.output.truncated === true,
      ...(typeof value.output.handle === 'string' ? { handle: value.output.handle.slice(0, 100) } : {}),
      ...(Number.isSafeInteger(value.output.nextOffset) && value.output.nextOffset! >= 0 ? { nextOffset: value.output.nextOffset } : {}),
      ...(Number.isSafeInteger(value.output.totalBytes) && value.output.totalBytes! >= 0 ? { totalBytes: value.output.totalBytes } : {}),
      ...(Number.isSafeInteger(value.output.retainedBytes) && value.output.retainedBytes! >= 0 ? { retainedBytes: value.output.retainedBytes } : {}),
      storageTruncated: value.output.storageTruncated === true,
    } } : {}),
    ...(value.execution ? { execution: {
      id: value.execution.id.slice(0, 100), state: value.execution.state,
      exitCode: value.execution.exitCode, ...(value.execution.signal ? { signal: value.execution.signal.slice(0, 100) } : {}),
    } } : {}),
    ...(value.task ? { task: { workerId: value.task.workerId.slice(0, 100), state: value.task.state,
      ...(value.task.taskId ? { taskId: value.task.taskId.slice(0, 100) } : {}),
      ...(value.task.stopReason ? { stopReason: value.task.stopReason.slice(0, 100) } : {}),
    } } : {}),
  };
}

export function resultMetadata(result: ToolResult): Omit<ToolResult, 'content'> {
  const { content: _content, ...metadata } = result;
  return metadata;
}

export function boundResult(result: ToolResult, max: number, ownerId: string, outputs?: ToolOutputStore): ToolResult {
  if (result.content.length <= max) return result;
  let output = result.output;
  let storageError = '';
  if (!output?.handle && outputs) {
    // 工具副作用已发生时，存日志失败不能伪装成“工具没执行”诱发重做。
    try {
      const log = outputs.create(ownerId);
      outputs.append(log.id, result.content);
      outputs.finish(log.id);
      output = { truncated: true, handle: log.id, totalBytes: log.totalBytes, retainedBytes: log.retainedBytes, storageTruncated: log.storageTruncated };
    } catch { storageError = '（日志写入失败，工具执行状态不变，勿因此重做副作用）'; }
  }
  const note = output?.handle
    ? `\noutput_id: ${output.handle}；用 ReadToolOutput 分页/搜索原文${output.storageTruncated ? '（存储配额已满，原文未完整保存）' : ''}。`
    : `\n[原文未落盘${storageError}；请缩小范围重新查询]`;
  return { ...result, output: { ...output, truncated: true }, content: clipOutput(result.content, max - note.length) + note };
}
