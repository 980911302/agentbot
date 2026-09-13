/**
 * 共享 HTTP/SSE transport（E2.6）：请求、错误读取、SSE 分帧。
 * 领域语义（事件类型、dispatch）不在这里——在 features/各自的 api 里。
 */

/** 统一 JSON 请求：非 2xx 抛出带后端 error 信息的异常 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as T;
}

export async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // fall through to the status line
  }
  return `${response.status} ${response.statusText}`;
}

/**
 * 读一个 SSE 响应并按 "\n\n" 分帧回调。
 * 帧内容是原始文本（event:/data: 行），由调用方按领域解析。
 */
export async function readSseFrames(
  response: Response,
  onFrame: (frame: string) => void,
): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > 4 * 1024 * 1024) throw new Error('事件帧超过接收上限');
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      onFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  } finally {
    // 协议缺口/epoch 变化会从 onFrame 抛出；必须关闭旧流，不能只另开一条连接。
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
