import { useCallback, useState } from 'react';
import * as api from '../../api';
import type { InteractionRequest } from '../../types';
import { notifyIfHidden } from '../../notify';

/**
 * 交互卡状态（E2.5b 从 App.tsx 抽出）：
 * 智能体 ask_user → 卡片出现（后台时系统通知）；回答/取消 → 卡片移除。
 * 私聊与群回合共用同一份状态（interaction_closed 双向清理）。
 */
export function useInteractions() {
  const [interactions, setInteractions] = useState<InteractionRequest[]>([]);

  /** 新卡片到达（去重），并按需提醒 */
  const handleRequest = useCallback((request: InteractionRequest) => {
    setInteractions((current) =>
      current.some((item) => item.id === request.id) ? current : [...current, request],
    );
    notifyIfHidden(`「${request.agentName}」在等你回答`, request.question);
  }, []);

  /** 卡片关闭（已回答或作废） */
  const handleClose = useCallback((id: string) => {
    setInteractions((current) => current.filter((item) => item.id !== id));
  }, []);

  /** 回答一张卡；失败时用服务端状态恢复 */
  const answer = useCallback(async (id: string, answer: { value?: string; secret?: string; cancelled?: boolean }) => {
    setInteractions((current) => current.filter((item) => item.id !== id));
    try {
      await api.answerInteraction(id, answer);
    } catch {
      const list = await api.fetchInteractions().catch(() => null);
      if (list) setInteractions(list);
    }
  }, []);

  return { interactions, handleRequest, handleClose, answer };
}
