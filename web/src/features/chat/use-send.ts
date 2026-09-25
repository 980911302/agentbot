import { useCallback } from 'react';
import { useChatStream } from './use-chat-stream';
import { useEventStream } from '../events/use-event-stream';
import { EDIT_PROMPT_EVENT, outgoingRequest } from './send-view';

export type UseSendInput = Parameters<typeof useChatStream>[0];

/**
 * 发送与重试（OPT-04 从 App.tsx 抽出）。
 *
 * 只是把「UI 适配器（useChatStream）+ 独立事件订阅（useEventStream）」绑在一起，
 * 并加上两个纯前置判定：空文本不发（send-view.outgoingRequest）、重试复用原 clientMessageId。
 * 发送/停止/分流的行为一行没动——引擎与 API 调用仍在 use-chat-stream.ts。
 */
export function useSend(input: UseSendInput) {
  const stream = useChatStream(input);
  // 独立事件订阅（E3.4 第二步）：发送只收回执，回合进度与结果都从这里来
  useEventStream({ onEntry: stream.handleEntry, onResync: stream.resync });

  /** 发送与重试共用同一道闸：空的话直接不发，重试带上原来的 key 去重 */
  const send = useCallback(
    (text: string, retryClientMessageId?: string) => {
      const request = outgoingRequest(text, retryClientMessageId);
      if (!request) return;
      void stream.send(request.text, request.clientMessageId);
    },
    [stream.send],
  );

  /** 「重新编辑」：只把原文填回输入框（Composer 监听 agentbot:use_prompt），不改发送逻辑 */
  const editPrompt = useCallback((text: string) => {
    window.dispatchEvent(new CustomEvent(EDIT_PROMPT_EVENT, { detail: text }));
  }, []);

  return {
    send,
    editPrompt,
    busy: stream.busy,
    respondingChannelIds: stream.respondingChannelIds,
    reloadChannel: stream.reloadChannel,
    resync: stream.resync,
    handleEntry: stream.handleEntry,
  };
}