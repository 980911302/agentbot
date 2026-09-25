import { useCallback, useState } from 'react';
import type { ArtifactView } from '../../types';

/**
 * 聊天流「写」、聊天区「读」的那几份视图状态（OPT-04 从 App.tsx 抽出）：
 * artifacts、频道内系统提示行、沉默提示、记忆面板刷新令牌。
 *
 * sinks 的字段名与 use-chat-stream 的入参一致，App 直接展开喂给 useSend，
 * 不用在组合根里逐个转发。
 */
export function useChatViewState() {
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  /** 频道内的轻状态行（挂起/停止这类系统提示） */
  const [notices, setNotices] = useState<Record<string, string[]>>({});
  /** 沉默提示没有独立渲染位置，只驱动重渲染（提示行由时间线自己画） */
  const [, setSilentNotes] = useState<Record<string, string[]>>({});
  const [memoryToken, setMemoryToken] = useState(0);
  /** 记忆收尾后让记忆面板重拉一次 */
  const bumpMemory = useCallback(() => setMemoryToken((token) => token + 1), []);

  return {
    artifacts,
    notices,
    memoryToken,
    sinks: { setArtifacts, setNotices, setSilentNotes, onMemoryBump: bumpMemory },
  };
}