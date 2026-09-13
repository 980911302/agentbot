/** 工具的机器结果与展示正文分离；正文中的 Error: 只是数据。 */
export interface ToolResult {
  status: 'ok' | 'error' | 'running';
  content: string;
  error?: { code: string; message: string };
  output?: {
    truncated: boolean;
    handle?: string;
    nextOffset?: number;
    totalBytes?: number;
    retainedBytes?: number;
    storageTruncated?: boolean;
  };
  execution?: {
    id: string;
    state: 'running' | 'exited' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
    exitCode: number | null;
    signal?: string;
  };
  task?: {
    workerId: string;
    taskId?: string;
    state: 'running' | 'answered' | 'incomplete' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
    stopReason?: string;
  };
}
