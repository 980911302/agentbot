import { useCallback, useRef, useState } from 'react';
import * as api from '../../api';
import { applyEvent, errorMessage, now } from './message-reducer';
import type { DisplayMessage, ArtifactView, InteractionRequest, BotSummary } from '../../types';
import type { ChannelItem } from '../../components/Sidebar';

/**
 * useChatStream（E2.5c）：发送与流消费。
 * 拥有 busy 计数、liveText/liveChannelId/liveSid 守卫、挂起通知、abort 控制。
 * getSession 取每次发送时的频道快照；其余 App 耦合以回调注入。
 */
export function useChatStream(input: {
  getSession: () => {
    activeAgentId: string | null;
    activeChannel: ChannelItem;
    activeChannelId: string;
    model: string;
    ownerName: string;
  };
  setChannelHistories: (updater: (prev: Record<string, DisplayMessage[]>) => Record<string, DisplayMessage[]>) => void;
  setArtifacts: (updater: (curr: ArtifactView[]) => ArtifactView[]) => void;
  setNotices: (updater: (prev: Record<string, string[]>) => Record<string, string[]>) => void;
  setRoundActive: (member: { id: string; name: string; color: string } | null) => void;
  setSilentNotes: (updater: (prev: Record<string, string[]>) => Record<string, string[]>) => void;
  agentsRef: React.MutableRefObject<BotSummary[]>;
  handleInteractionRequest: (request: InteractionRequest) => void;
  handleInteractionClosed: (id: string) => void;
  onMemoryBump: () => void;
  syncWorkspace: () => Promise<unknown>;
  reloadChannel: (channelId: string) => Promise<void>;
}) {
  const deps = input;
  const [busy, setBusy] = useState(false);
  const busyCountRef = useRef(0);
  const [liveText, setLiveText] = useState('');
  const [liveChannelId, setLiveChannelId] = useState('');
  const liveSidRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const session = deps.getSession();
      const { activeAgentId, activeChannel, activeChannelId, model, ownerName } = session;
      if (!activeAgentId) {
        deps.setChannelHistories((prev) => ({
          ...prev,
          [activeChannelId]: [
            ...(prev[activeChannelId] ?? []),
            errorMessage(activeChannel, '后端未连接，找不到这个频道对应的智能体'),
          ],
        }));
        return;
      }

      const userMsg = {
        id: `pending-${clientMessageId}`,
        role: 'user' as const,
        senderName: ownerName,
        content: trimmed,
        toolCalls: [],
        createdAt: now(),
      };
      deps.setChannelHistories((prev) => ({
        ...prev,
        [activeChannelId]: [...(prev[activeChannelId] ?? []), userMsg],
      }));

      // 幂等键：同一键重复提交，服务端返回原消息（E3.2）
      const clientMessageId = crypto.randomUUID();
      busyCountRef.current += 1;
      setBusy(true);
      setLiveText('');
      setLiveChannelId(activeChannel.kind === 'room' ? '' : activeChannelId);
      const sid = ++liveSidRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      if (activeChannel.kind === 'room') {
        deps.setSilentNotes((prev) => ({ ...prev, [activeChannelId]: [] }));
        try {
          await api.streamRoom(
            activeChannelId,
            trimmed,
            {
              onMessage: (message) => {
                deps.setChannelHistories((prev) => {
                  const list = prev[activeChannelId] ?? [];
                  if (message.senderKind === 'user') {
                    const index = list.findIndex(
                      (item) =>
                        item.id === `pending-${clientMessageId}` ||
                        (item.id.startsWith('pending-') && item.content === message.text),
                    );
                    if (index >= 0) {
                      const next = [...list];
                      next[index] = {
                        ...next[index]!,
                        id: message.id,
                        senderName: message.senderName,
                        createdAt: new Date(message.createdAt).toISOString(),
                      };
                      return { ...prev, [activeChannelId]: next };
                    }
                  }
                  if (list.some((item) => item.id === message.id)) return prev;
                  return {
                    ...prev,
                    [activeChannelId]: [
                      ...list,
                      {
                        id: message.id,
                        role: message.senderKind === 'user' ? 'user' : 'assistant',
                        content: message.text,
                        senderName: message.senderName,
                        senderColor: message.senderColor,
                        toolCalls: [],
                        createdAt: new Date(message.createdAt).toISOString(),
                      },
                    ],
                  };
                });
              },
              onRoundStart: ({ agentId, agentName }) => {
                const color =
                  deps.agentsRef.current.find((bot) => bot.id === agentId)?.color ?? '#8b5cf6';
                deps.setRoundActive({ id: agentId, name: agentName, color });
              },
              onAgentEvent: (event) => {
                if (event.type === 'interaction') {
                  deps.handleInteractionRequest(event.request);
                  return;
                }
                if (event.type === 'interaction_closed') {
                  deps.handleInteractionClosed(event.id);
                }
              },
              onRoundEnd: (outcome) => {
                deps.setRoundActive(null);
                if (outcome.status !== 'spoke') {
                  deps.setSilentNotes((prev) => ({
                    ...prev,
                    [activeChannelId]: [
                      ...(prev[activeChannelId] ?? []),
                      `${outcome.agentName} ${outcome.status === 'error' ? '出错' : '看过，没开口'}`,
                    ],
                  }));
                }
              },
              onError: (err) => {
                deps.setChannelHistories((prev) => ({
                  ...prev,
                  [activeChannelId]: [
                    ...(prev[activeChannelId] ?? []),
                    errorMessage(activeChannel, err, trimmed),
                  ],
                }));
              },
            },
            controller.signal,
            model || undefined,
            ownerName,
            clientMessageId,
          );
        } catch (error) {
          const aborted = error instanceof DOMException && error.name === 'AbortError';
          if (!aborted) {
            deps.setChannelHistories((prev) => ({
              ...prev,
              [activeChannelId]: [
                ...(prev[activeChannelId] ?? []),
                errorMessage(
                  activeChannel,
                  `请求异常：${error instanceof Error ? error.message : String(error)}`,
                  trimmed,
                ),
              ],
            }));
          }
        } finally {
          abortRef.current = null;
          busyCountRef.current = Math.max(0, busyCountRef.current - 1);
          if (busyCountRef.current === 0) setBusy(false);
          deps.setRoundActive(null);
          void deps.syncWorkspace();
        }
        return;
      }

      try {
        await api.streamChat(
          { botId: activeAgentId, message: trimmed, model: model || undefined, clientMessageId },
          {
            onEvent: (event) => {
              if (event.type === 'delta') {
                if (sid === liveSidRef.current) setLiveText((current) => current + event.text);
                return;
              }
              if (event.type === 'interaction') {
                deps.handleInteractionRequest(event.request);
                return;
              }
              if (event.type === 'interaction_closed') {
                deps.handleInteractionClosed(event.id);
                return;
              }
              if (event.type === 'message' && event.message.role === 'assistant') {
                if (event.message.content.type === 'text' && sid === liveSidRef.current) {
                  setLiveText('');
                }
              }
              deps.setChannelHistories((prev) => ({
                ...prev,
                [activeChannelId]: applyEvent(prev[activeChannelId] ?? [], event),
              }));
              if (event.type === 'message' && event.message.content.type === 'tool_calls') {
                for (const call of event.message.content.calls) {
                  try {
                    const args = JSON.parse(call.arguments || '{}') as { path?: unknown };
                    if (typeof args.path !== 'string' || !args.path) continue;
                    const path = args.path;
                    deps.setArtifacts((curr) =>
                      curr.some((item) => item.path === path)
                        ? curr
                        : [...curr, { path, tool: call.name, createdAt: now() }],
                    );
                  } catch {
                    // 参数还不是合法 JSON
                  }
                }
              }
            },
            onError: (err) => {
              if (sid === liveSidRef.current) setLiveText('');
              deps.setChannelHistories((prev) => ({
                ...prev,
                [activeChannelId]: [
                  ...(prev[activeChannelId] ?? []),
                  errorMessage(activeChannel, err, trimmed),
                ],
              }));
            },
            onDone: (result) => {
              if (result.stopReason === 'parked') {
                deps.setNotices((prev) => ({
                  ...prev,
                  [activeChannelId]: [
                    ...(prev[activeChannelId] ?? []).slice(-4),
                    '⏸ 有一条任务被新指令插队挂起，做完手头的事会自动接着做',
                  ],
                }));
              }
            },
          },
          controller.signal,
        );
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        if (!aborted) {
          deps.setChannelHistories((prev) => ({
            ...prev,
            [activeChannelId]: [
              ...(prev[activeChannelId] ?? []),
              errorMessage(
                activeChannel,
                `请求异常：${error instanceof Error ? error.message : String(error)}`,
                trimmed,
              ),
            ],
          }));
        }
      } finally {
        abortRef.current = null;
        busyCountRef.current = Math.max(0, busyCountRef.current - 1);
        if (busyCountRef.current === 0) {
          setBusy(false);
          void deps.reloadChannel(activeChannelId);
        }
        if (liveSidRef.current === sid) {
          setLiveText('');
          setLiveChannelId('');
        }
        deps.onMemoryBump();
        void deps.syncWorkspace();
      }
    },
    [deps],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  return { send, stop, busy, liveText, liveChannelId };
}
